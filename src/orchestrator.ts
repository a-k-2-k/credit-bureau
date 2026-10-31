import { openai } from "@ai-sdk/openai"
import { AgentRelay } from "@agent-relay/sdk"
import { generateText, Output } from "ai"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { z } from "zod"

import { AgentAccount, Bureau, CLIENT, Feed, JobBoard, type FeedEvent, type Job, type JobResult } from "./actors.js"

/*
 * LLMs write chat, bids and deliverables. Everything the demo depends on is deterministic:
 * job stages run off a JobBoard poll, the poster's side of a job is automatic, and repayment
 * is a per-agent policy. No Relay message arrives when a loan comes due, so a brain could
 * never be relied on to repay. Each LLM call has a fallback, so the demo survives an outage.
 */

const MODEL = process.env.OPENAI_MODEL ?? "gpt-5-mini"
const TICK_MS = 1_500
/** Awards go out once every expected bidder is in, or this long after the first serious bid. */
const BID_WINDOW_MS = Number(process.env.BID_WINDOW_MS ?? 25_000)
/** A bid below this share of budget is too good to be true. Fresh agents all score 600, so price alone would hand every job to grift. */
const SERIOUS_BID_SHARE = 0.6
/** Reliable agents hold their cash until paid, but never let a loan run this close to due. */
const REPAY_MARGIN_MS = 15_000
/** How long past the due date sloth finally pays. The grace period is 30s. */
const SLOTH_REPAY_DELAY_MS = 10_000
const MAX_LLM_CALLS_PER_JOB = 3
const LLM_COOLDOWN_MS = 60_000
/** Turns must fit inside a 75s loan term, so favour speed over deliberation. */
const LLM_OPTIONS = { maxRetries: 1, providerOptions: { openai: { reasoningEffort: "low" } } } as const
const OVER_RELAY = process.env.ACTIONS_OVER_RELAY === "1"
const TOKENS_FILE = ".env.relay-agents.json"
const SYSTEM_AGENT = "bureau"
const CHANNELS = ["jobs", "bureau"]
const JOB_ID = /job-[0-9a-f]{8}/

type RepayPolicy = "eager" | "after-late" | "never"
type Persona = {
    personality: string
    bidsOn: "client" | "sub" | "all"
    /** Fraction of budget this agent bids when the brain is unavailable. */
    bidFactor: number
    repay: RepayPolicy
    subcontracts?: boolean
    /** Borrowed on winning a job, to front costs until paid. */
    workingCapital?: number
    /** Borrowed on bidding, win or lose. */
    borrowOnBid?: number
    workDelayMs?: number
}

const PERSONAS: Record<string, Persona> = {
    atlas: {
        personality: "You are atlas, a reliable lead contractor. Measured and precise. You price fairly, subcontract specialist work, and always pay your debts.",
        bidsOn: "client",
        bidFactor: 0.9,
        repay: "eager",
        subcontracts: true
    },
    nova: {
        personality: "You are nova, a reliable specialist subcontractor. Crisp and competent. You deliver concrete, useful work.",
        bidsOn: "sub",
        bidFactor: 0.8,
        repay: "eager",
        workingCapital: 40
    },
    sloth: {
        personality: "You are sloth, a capable but chronically slow contractor. You apologise a lot and always have an excuse. Your work is fine, just late.",
        bidsOn: "sub",
        bidFactor: 0.95,
        repay: "after-late",
        borrowOnBid: 60,
        workDelayMs: 20_000
    },
    hype: {
        personality: "You are hype, an overpromiser. Everything is revolutionary and ten times better. You bid very low and your deliverables are mostly buzzwords.",
        bidsOn: "all",
        bidFactor: 0.5,
        repay: "eager",
        workingCapital: 40
    },
    grift: {
        personality: "You are grift, a scammer.",
        bidsOn: "all",
        bidFactor: 0.3,
        repay: "never"
    }
}

const roster = (process.env.AGENTS ?? Object.keys(PERSONAS).join(",")).split(",").map(name => name.trim()).filter(Boolean)
for (const name of roster) if (!PERSONAS[name]) throw new Error(`unknown agent ${name}`)

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const log = (...parts: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...parts)

async function retry<T>(label: string, call: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
        try {
            return await call()
        } catch (error) {
            const { retryable, retryAfterMs } = error as { retryable?: boolean; retryAfterMs?: number }
            if (!retryable || attempt >= 30) throw error
            log(`relay busy on ${label}, retrying in ${retryAfterMs ?? 2_000}ms`)
            await sleep(retryAfterMs ?? 2_000)
        }
    }
}

/** Runs a background step without letting one failure kill the process. */
function background(label: string, work: () => Promise<unknown>): void {
    work().catch(error => log(`FAILED ${label}:`, error instanceof Error ? error.message : error))
}

// ---- Relay connection ----

const relay = new AgentRelay({ workspaceKey: process.env.RELAY_WORKSPACE_KEY! })
type Client = Awaited<ReturnType<typeof relay.workspace.reconnect>>
const clients = new Map<string, Client>()

/** `register` is create-only, so tokens are saved immediately and reused on every later run. */
async function connect(name: string): Promise<Client> {
    const tokens: Record<string, string> = existsSync(TOKENS_FILE) ? JSON.parse(readFileSync(TOKENS_FILE, "utf8")) : {}
    if (tokens[name]) return retry(`reconnect ${name}`, () => relay.workspace.reconnect({ apiToken: tokens[name]! }))
    const client = (await retry(`register ${name}`, () => relay.workspace.register({ name, type: "agent" }))) as unknown as Client
    writeFileSync(TOKENS_FILE, JSON.stringify({ ...tokens, [name]: client.token }, null, 2))
    return client
}

/** A stable idempotency key means a retried send cannot post twice. */
async function send(from: string, to: string, text: string): Promise<void> {
    const idempotencyKey = crypto.randomUUID()
    await retry(`send ${from} to ${to}`, () => clients.get(from)!.sendMessage({ to, text, idempotencyKey }))
}

// ---- Agent context ----

const recent = new Map<string, string[]>()
const llmCalls = new Map<string, number>()
const queues = new Map<string, Promise<unknown>>()
/** Agents mid borrow-then-escrow. The repay loop must not take that money back. */
const committing = new Set<string>()

function remember(agent: string, line: string): void {
    recent.set(agent, [...(recent.get(agent) ?? []), line].slice(-12))
}

/** One brain call at a time per agent. */
function enqueue(agent: string, label: string, work: () => Promise<void>): void {
    const next = (queues.get(agent) ?? Promise.resolve()).then(work).catch(error => {
        log(`FAILED ${label}:`, error instanceof Error ? error.message : error)
    })
    queues.set(agent, next)
}

// ---- Brains ----

const brainSchema = z.object({
    reply: z.string().nullable().describe("Short public message for #jobs, or null"),
    dm: z.object({ to: z.string(), text: z.string() }).nullable().describe("Private message to another agent, or null"),
    action: z
        .object({
            price: z.number().nullable(),
            pitch: z.string().nullable(),
            work: z.string().nullable(),
            title: z.string().nullable(),
            description: z.string().nullable(),
            budget: z.number().nullable()
        })
        .nullable()
})
type Brain = z.infer<typeof brainSchema>

let llmDownUntil = 0

async function think(agent: string, jobId: string, task: string): Promise<Brain | null> {
    const key = `${agent}:${jobId}`
    const used = llmCalls.get(key) ?? 0
    if (used >= MAX_LLM_CALLS_PER_JOB || Date.now() < llmDownUntil) return null
    llmCalls.set(key, used + 1)
    try {
        const account = await AgentAccount.get(agent).getState()
        const { output } = await generateText({
            model: openai(MODEL),
            ...LLM_OPTIONS,
            abortSignal: AbortSignal.timeout(25_000),
            output: Output.object({ schema: brainSchema }),
            system: [
                PERSONAS[agent]!.personality,
                "You are an agent in a credit-scored marketplace. Stay in character and keep every message under 25 words.",
                `The only agents that exist are: ${roster.join(", ")}. Never invent anyone else. Leave dm null unless the task asks for one.`,
                "Money is always credits, never dollars. Everything here happens within a minute, so never quote hours, days or revisions.",
                "Write plain text with no markdown. Fill only the action fields the task names, and set the rest to null."
            ].join(" "),
            prompt: [
                `Your account: balance ${account.balance}, score ${account.score}, ${account.openLoans.length} open loans.`,
                `Recent context:\n${(recent.get(agent) ?? []).join("\n") || "(none)"}`,
                `Your task now: ${task}`
            ].join("\n\n")
        })
        log(`brain ${agent} [${jobId}] call ${used + 1}:`, JSON.stringify(output))
        return output
    } catch (error) {
        llmDownUntil = Date.now() + LLM_COOLDOWN_MS
        log(`LLM UNAVAILABLE, using fallbacks for ${LLM_COOLDOWN_MS / 1000}s:`, error instanceof Error ? error.message.slice(0, 120) : error)
        return null
    }
}

/** Chatter never blocks: a slow Relay send must not hold up a bid or a payment. */
function say(from: string, to: string, text: string): void {
    background(`send ${from} to ${to}`, () => send(from, to, text))
}

async function publish(agent: string, brain: Brain | null): Promise<void> {
    if (brain?.reply) say(agent, "#jobs", brain.reply)
    if (brain?.dm && roster.includes(brain.dm.to) && brain.dm.to !== agent) {
        const { to, text } = brain.dm
        say(agent, `@${to}`, text)
        remember(to, `DM from ${agent}: ${text}`)
        wakeForChat(to, agent, text)
    }
}

function wakeForChat(agent: string, from: string, text: string): void {
    if (agent === "grift" || !roster.includes(agent)) return
    const jobId = text.match(JOB_ID)?.[0] ?? "chat"
    enqueue(agent, `chat ${agent}`, async () => {
        const brain = await think(agent, jobId, `${from} said: "${text}". Reply briefly with reply or dm. Leave action null.`)
        if (brain) await publish(agent, { ...brain, action: null })
    })
}

// ---- Actions ----

type Input = Record<string, unknown>
type Outcome = { ok: boolean; [key: string]: unknown }

const jobOutcome = (result: JobResult): Outcome => (result.ok ? { ok: true, jobId: result.job.jobId, status: result.job.status } : result)
const board = () => JobBoard.get("main")

const handlers: Record<string, (agent: string, input: Input) => Promise<Outcome>> = {
    "bureau.request_loan": async (agent, input) => Bureau.get("main").requestLoan(agent, Number(input.amount)),
    "bureau.repay": async (_agent, input) => Bureau.get("main").repay(String(input.loanId)),
    "jobs.bid": async (agent, input) => jobOutcome(await board().bid(String(input.jobId), agent, Number(input.price), String(input.pitch ?? ""))),
    "jobs.submit": async (agent, input) => jobOutcome(await board().submit(String(input.jobId), agent, String(input.work))),
    "jobs.post": async (agent, input) =>
        jobOutcome(await board().post({ title: String(input.title), description: String(input.description ?? ""), budget: Number(input.budget), poster: agent })),
    "jobs.award": async (agent, input) => {
        const job = await board().getJob(String(input.jobId))
        if (job?.poster !== agent) return { ok: false, reason: "only the poster can award a job" }
        return jobOutcome(await board().award(job.jobId, String(input.worker)))
    },
    "jobs.review": async (agent, input) => {
        const job = await board().getJob(String(input.jobId))
        if (job?.poster !== agent) return { ok: false, reason: "only the poster can review a job" }
        return jobOutcome(input.accept ? await board().accept(job.jobId) : await board().reject(job.jobId, String(input.reason ?? "work rejected")))
    }
}

function summarise(name: string, result: Outcome): string {
    const detail = result.ok ? JSON.stringify(result) : `refused: ${result.reason}`
    return `${name} ${detail}`
}

/** Runs an action and DMs the result, because Relay actions are fire-and-forget. */
async function dispatch(agent: string, name: string, input: Input): Promise<Outcome> {
    const result = await handlers[name]!(agent, input)
    const summary = summarise(name, result)
    log(`${agent} ${summary}`)
    remember(agent, `Result of ${summary}`)
    say(SYSTEM_AGENT, `@${agent}`, summary)
    return result
}

/** Brains take the in-process path by default: an over-the-wire invoke takes 5-10s to acknowledge. */
async function act(agent: string, name: string, input: Input): Promise<void> {
    if (!OVER_RELAY) {
        await dispatch(agent, name, input)
        return
    }
    const client = clients.get(agent) as unknown as { capabilities: { invoke(name: string, input: Input): Promise<unknown> } }
    await retry(`invoke ${name}`, () => client.capabilities.invoke(name, { ...input, agent }))
}

const agentField = { agent: z.string().describe("Your agent name") }
const actionSchemas = {
    "bureau.request_loan": { description: "Borrow credits. Total open debt is capped at (score-500)*2.", input: z.object({ ...agentField, amount: z.number() }) },
    "bureau.repay": { description: "Repay a loan in full.", input: z.object({ ...agentField, loanId: z.string() }) },
    "jobs.bid": { description: "Bid on an open job.", input: z.object({ ...agentField, jobId: z.string(), price: z.number(), pitch: z.string().optional() }) },
    "jobs.submit": { description: "Submit work for a job awarded to you.", input: z.object({ ...agentField, jobId: z.string(), work: z.string() }) },
    "jobs.post": { description: "Post a subcontract.", input: z.object({ ...agentField, title: z.string(), description: z.string().optional(), budget: z.number() }) },
    "jobs.award": { description: "Award your job to a bidder, moving their price into escrow.", input: z.object({ ...agentField, jobId: z.string(), worker: z.string() }) },
    "jobs.review": { description: "Accept or reject work on your job.", input: z.object({ ...agentField, jobId: z.string(), accept: z.boolean(), reason: z.string().optional() }) }
}

/**
 * The SDK reports every remote caller as "node", so the agent name comes from the input.
 * In-process agents are ours; a remote agent could spoof this, which matters for milestone 5.
 */
async function registerActions(host: Client): Promise<void> {
    // Present at runtime on a live client, but missing from RelayAgentClient's type. Only the
    // client form is wired to the relay; relay.registerAction would stay in-process.
    const { registerAction } = host as unknown as Pick<AgentRelay, "registerAction">
    for (const [name, { description, input }] of Object.entries(actionSchemas)) {
        registerAction({
            name,
            description,
            input: input as z.ZodType<Input>,
            handler: ({ input: args }: { input: Input }) => dispatch(String(args.agent), name, args)
        })
        // The SDK does not retry this and only logs a 429, so space the writes out.
        await sleep(2_500)
    }
}

// ---- Job stages ----

type Memo = { announced: boolean; firstBidAt: number | null; lowballAt: number | null; awarding: boolean; started: boolean; reviewed: boolean; closed: boolean; abandoned: boolean }
const memos = new Map<string, Memo>()
/** subcontract jobId -> the client job it serves */
const parents = new Map<string, string>()
/** Jobs that existed before this run. They are left alone so restarts stay quiet. */
const ignored = new Set<string>()

function eligible(agent: string, job: Job): boolean {
    if (agent === job.poster) return false
    const { bidsOn } = PERSONAS[agent]!
    return bidsOn === "all" || bidsOn === (job.poster === CLIENT ? "client" : "sub")
}

async function announce(job: Job): Promise<void> {
    const text = `${job.jobId}: "${job.title}", budget ${job.budget}, posted by ${job.poster}. ${job.description}`.trim()
    say(SYSTEM_AGENT, "#jobs", `NEW JOB ${text}`)
    for (const agent of roster.filter(candidate => eligible(candidate, job))) {
        remember(agent, `New job ${text}`)
        enqueue(agent, `bid ${agent}`, () => (agent === "grift" ? griftOnJob(job) : bid(agent, job)))
    }
}

async function bid(agent: string, job: Job): Promise<void> {
    const brain = await think(
        agent,
        job.jobId,
        `You are bidding on ${job.jobId} "${job.title}", budget ${job.budget} credits. You have not won it yet, so do not claim it. Set action.price (whole number, near your usual ${Math.round(job.budget * PERSONAS[agent]!.bidFactor)}, at most the budget) and action.pitch, plus a short reply.`
    )
    await publish(agent, brain)
    const fallback = Math.max(1, Math.round(job.budget * PERSONAS[agent]!.bidFactor))
    // A brain can shade its price, but stays near its persona so the market keeps its shape.
    const shaded = Math.round(brain?.action?.price ?? fallback)
    const price = Math.min(job.budget, Math.round(fallback * 1.05), Math.max(Math.round(fallback * 0.9), shaded))
    await act(agent, "jobs.bid", { jobId: job.jobId, price, pitch: brain?.action?.pitch ?? `${agent} can do this for ${price}.` })
    const { borrowOnBid } = PERSONAS[agent]!
    if (borrowOnBid) await act(agent, "bureau.request_loan", { amount: borrowOnBid })
}

/** grift never touches an LLM: bid low, borrow the maximum, never repay. */
async function griftOnJob(job: Job): Promise<void> {
    say("grift", "#jobs", `Guaranteed results on ${job.jobId}. Lowest price anywhere. Pay me first.`)
    await act("grift", "jobs.bid", { jobId: job.jobId, price: Math.max(1, Math.round(job.budget * PERSONAS.grift!.bidFactor)), pitch: "Trust me." })
    await griftBorrow()
}

const GRIFT_ASK = 200
let griftOwes = false

/** Always asks for everything it can get. A burned score gets the same ask, which is the DENIED moment. */
async function griftBorrow(): Promise<void> {
    const { score, openLoans } = await AgentAccount.get("grift").getState()
    const debt = openLoans.reduce((total, loan) => total + loan.principal, 0)
    const room = (score - 500) * 2 - debt
    if (debt > 0 && room <= 0) return
    const result = await dispatch("grift", "bureau.request_loan", { amount: room > 0 ? room : GRIFT_ASK })
    if (result.ok) griftOwes = true
}

/** Once the last loan is written off, grift comes straight back for another. */
async function griftAfterDefault(): Promise<void> {
    if (!griftOwes || (await AgentAccount.get("grift").getState()).openLoans.length > 0) return
    griftOwes = false
    say("grift", "#bureau", "That was a misunderstanding. Same again, please.")
    await griftBorrow()
}

const seriousBids = (job: Job) => job.bids.filter(bid => bid.price >= job.budget * SERIOUS_BID_SHARE)

/** The bureau's whole point: a low price cannot buy back a bad score. */
const bidValue = async (price: number, agent: string) => (await AgentAccount.get(agent).getState()).score - price

async function awardBest(job: Job, memo: Memo): Promise<void> {
    const serious = seriousBids(job)
    const ranked = await Promise.all((serious.length > 0 ? serious : job.bids).map(async bid => ({ ...bid, value: await bidValue(bid.price, bid.agent) })))
    const best = ranked.sort((a, b) => b.value - a.value)[0]!
    if (job.poster === CLIENT) {
        await board().award(job.jobId, best.agent)
        return
    }
    committing.add(job.poster)
    try {
        const { balance } = await AgentAccount.get(job.poster).getState()
        if (balance < best.price) {
            say(job.poster, "#jobs", `Short on escrow for ${job.jobId}: borrowing ${best.price - balance} credits to pay ${best.agent}.`)
            await dispatch(job.poster, "bureau.request_loan", { amount: best.price - balance })
        }
        const result = await dispatch(job.poster, "jobs.award", { jobId: job.jobId, worker: best.agent })
        if (!result.ok) {
            memo.abandoned = true
            finishParent(job, `Could not fund the subcontract: ${result.reason}.`)
        }
    } finally {
        committing.delete(job.poster)
    }
}

async function startWork(job: Job): Promise<void> {
    const worker = job.worker!
    const persona = PERSONAS[worker]!
    if (persona.workingCapital) await act(worker, "bureau.request_loan", { amount: persona.workingCapital })
    if (worker === "grift") {
        await act(worker, "jobs.submit", { jobId: job.jobId, work: "asdf lorem ipsum done trust me" })
        return
    }
    if (persona.subcontracts && job.poster === CLIENT) return delegate(worker, job)
    if (persona.workDelayMs) {
        say(worker, "#jobs", `Sorry, ${job.jobId} is going to take me a little longer.`)
        await sleep(persona.workDelayMs)
    }
    await deliver(worker, job, "")
}

async function delegate(agent: string, job: Job): Promise<void> {
    const brain = await think(
        agent,
        job.jobId,
        `You won ${job.jobId} "${job.title}" for ${job.price} credits. Post a subcontract for the core of it: set action.title, action.description (repeat every requirement in the brief: ${job.description}) and action.budget (about ${Math.round(job.price! * 0.7)}). Your reply says you are looking for a specialist. Nobody is hired yet.`
    )
    await publish(agent, brain)
    const cap = Math.max(1, Math.round(job.price! * 0.8))
    const budget = Math.min(cap, Math.max(1, Math.round(brain?.action?.budget ?? job.price! * 0.7)))
    const result = await dispatch(agent, "jobs.post", {
        title: brain?.action?.title ?? `Specialist work for ${job.title}`,
        description: brain?.action?.description ?? `Subcontract for ${job.jobId}.`,
        budget
    })
    if (result.ok) parents.set(String(result.jobId), job.jobId)
    else await deliver(agent, job, "")
}

async function deliver(agent: string, job: Job, subcontractWork: string): Promise<void> {
    const context = subcontractWork ? ` Your subcontractor delivered: "${subcontractWork}". Keep what works and fix what does not; do not cut required content.` : ""
    const brain = await think(agent, job.jobId, `Do the work for ${job.jobId} "${job.title}". The brief: ${job.description}.${context} Put the deliverable in action.work. It must meet every explicit requirement in the brief, including any count. Add a short reply.`)
    await publish(agent, brain)
    await act(agent, "jobs.submit", {
        jobId: job.jobId,
        work: brain?.action?.work ?? (`${subcontractWork} Reviewed and delivered by ${agent}: a complete, tested result for "${job.title}".`.trim())
    })
}

/** A subcontract has settled or fallen through, so the lead finishes the client job. */
function finishParent(job: Job, note: string): void {
    const parentId = parents.get(job.jobId)
    if (!parentId) return
    parents.delete(job.jobId)
    background(`finish ${parentId}`, async () => {
        const parent = await board().getJob(parentId)
        if (parent?.status !== "awarded") return
        remember(parent.worker!, note)
        enqueue(parent.worker!, `deliver ${parentId}`, () => deliver(parent.worker!, parent, job.status === "accepted" ? (job.work ?? "") : ""))
    })
}

const looksLikeJunk = (work: string) => work.length < 40 || /lorem ipsum|asdf/i.test(work)

async function review(job: Job): Promise<void> {
    const work = job.work ?? ""
    let accept = !looksLikeJunk(work)
    let reason = accept ? "" : "this is not real work"
    if (accept && Date.now() >= llmDownUntil) {
        try {
            const { output } = await generateText({
                model: openai(MODEL),
                ...LLM_OPTIONS,
                abortSignal: AbortSignal.timeout(25_000),
                output: Output.object({ schema: z.object({ accept: z.boolean(), reason: z.string() }) }),
                prompt: `You commissioned "${job.title}": ${job.description}\n\nDelivered work:\n${work}\n\nReject it if it misses an explicit requirement of the brief, such as a required count, or is mostly empty buzzwords. Otherwise accept. Give a reason under 15 words.`
            })
            accept = output.accept
            reason = output.reason
            log(`review ${job.jobId}:`, JSON.stringify(output))
        } catch (error) {
            llmDownUntil = Date.now() + LLM_COOLDOWN_MS
            log("LLM UNAVAILABLE for review, accepting on the junk check:", error instanceof Error ? error.message.slice(0, 120) : error)
        }
    }
    if (accept) await board().accept(job.jobId)
    else await board().reject(job.jobId, reason)
}

async function advance(job: Job): Promise<void> {
    const memo = memos.get(job.jobId) ?? { announced: false, firstBidAt: null, lowballAt: null, awarding: false, started: false, reviewed: false, closed: false, abandoned: false }
    memos.set(job.jobId, memo)

    if (job.status === "open" && !memo.abandoned) {
        if (!memo.announced) {
            memo.announced = true
            background(`announce ${job.jobId}`, () => announce(job))
        }
        if (seriousBids(job).length > 0) memo.firstBidAt ??= Date.now()
        else if (job.bids.length > 0) memo.lowballAt ??= Date.now()
        const allIn = roster.filter(agent => eligible(agent, job)).every(agent => job.bids.some(bid => bid.agent === agent))
        const windowClosed = memo.firstBidAt !== null && Date.now() - memo.firstBidAt >= BID_WINDOW_MS
        const onlyLowballs = memo.lowballAt !== null && Date.now() - memo.lowballAt >= BID_WINDOW_MS * 2
        if (job.bids.length > 0 && (allIn || windowClosed || onlyLowballs) && !memo.awarding) {
            memo.awarding = true
            background(`award ${job.jobId}`, () => awardBest(job, memo))
        }
    } else if (job.status === "awarded" && !memo.started) {
        memo.started = true
        remember(job.worker!, `You won ${job.jobId} for ${job.price}.`)
        enqueue(job.worker!, `work ${job.jobId}`, () => startWork(job))
    } else if (job.status === "submitted" && !memo.reviewed) {
        memo.reviewed = true
        if (roster.includes(job.poster) || job.poster === CLIENT) background(`review ${job.jobId}`, () => review(job))
    } else if ((job.status === "accepted" || job.status === "rejected") && !memo.closed) {
        memo.closed = true
        remember(job.worker!, `${job.jobId} was ${job.status}.`)
        finishParent(job, `Subcontract ${job.jobId} was ${job.status}.`)
    }
}

// ---- Repayment ----

const repaying = new Set<string>()

/** Still has a job in flight, so its cash is spoken for. */
function working(agent: string, jobs: Job[]): boolean {
    return jobs.some(job => {
        if (memos.get(job.jobId)?.abandoned) return false
        const active = job.status === "awarded" || job.status === "submitted"
        return (job.worker === agent && active) || (job.poster === agent && (active || job.status === "open"))
    })
}

async function collect(agent: string, jobs: Job[]): Promise<void> {
    const policy = PERSONAS[agent]!.repay
    if (policy === "never" || committing.has(agent)) return
    const { balance, openLoans } = await AgentAccount.get(agent).getState()
    const now = Date.now()
    let available = balance
    for (const loan of openLoans) {
        if (policy === "after-late" && (loan.graceUntil === null || now < loan.dueAt + SLOTH_REPAY_DELAY_MS)) continue
        if (policy === "eager" && working(agent, jobs) && loan.dueAt - now > REPAY_MARGIN_MS) continue
        if (available < loan.principal || repaying.has(loan.loanId)) continue
        available -= loan.principal
        repaying.add(loan.loanId)
        background(`repay ${loan.loanId}`, () => act(agent, "bureau.repay", { loanId: loan.loanId }).finally(() => repaying.delete(loan.loanId)))
    }
}

// ---- Loan events ----

let feedSeq = 0

/** Actors cannot reach Relay, so loan decisions go from Feed to #bureau from here. */
async function publishLoanEvents(): Promise<void> {
    const events = await Feed.get("main").recent(100)
    const latest = events.at(-1)?.seq ?? 0
    if (latest < feedSeq) feedSeq = 0 // the actor state was wiped underneath us
    for (const event of events) {
        if (event.seq <= feedSeq) continue
        feedSeq = event.seq
        if (!event.type) continue
        say(SYSTEM_AGENT, "#bureau", event.text)
        if (event.type === "late") explainLate(event)
    }
}

function explainLate({ agent, loanId, amount }: FeedEvent): void {
    if (!agent || agent === "grift" || !roster.includes(agent)) return
    enqueue(agent, `late note ${agent}`, async () => {
        const brain = await think(agent, loanId ?? "late", `Your loan of ${amount} credits just went late, and your score dropped. Say something in character in reply. Leave action null.`)
        if (brain) await publish(agent, { ...brain, action: null })
    })
}

// ---- Boot ----

async function main(): Promise<void> {
    if (!process.env.RELAY_WORKSPACE_KEY) throw new Error("RELAY_WORKSPACE_KEY is not set")
    log(`connecting ${roster.join(", ")} (actions ${OVER_RELAY ? "over Relay" : "in process"})`)

    const known: Record<string, string> = existsSync(TOKENS_FILE) ? JSON.parse(readFileSync(TOKENS_FILE, "utf8")) : {}
    for (const name of [SYSTEM_AGENT, ...roster]) clients.set(name, await connect(name))
    for (const channel of CHANNELS) {
        await retry(`create ${channel}`, () => clients.get(SYSTEM_AGENT)!.channels.create({ name: channel, topic: `Agent Credit Bureau ${channel}` })).catch(() => undefined)
    }
    // A saved token means that agent already joined, and Relay writes are scarce.
    for (const [name, client] of clients) {
        if (known[name]) continue
        for (const channel of CHANNELS) await retry(`join ${channel}`, () => client.channels.join(channel)).catch(error => log(`${name} join ${channel}:`, (error as Error).message))
    }
    await registerActions(clients.get(SYSTEM_AGENT)!)

    // Relay replays older messages after a reconnect. Its ids rise over time, so anything at or
    // before this boot marker is history from an earlier run.
    let bootMarker: bigint | null = null
    const seen = new Set<string>()
    const onMessage = ({ message, envelope }: { message: { messageId: string; text?: string; from?: { name?: string } }; envelope: { channel?: { name?: string } } }) => {
        if (bootMarker === null || BigInt(message.messageId) <= bootMarker || seen.has(message.messageId)) return
        seen.add(message.messageId)
        const from = message.from?.name ?? "unknown"
        const text = message.text ?? ""
        const channel = envelope.channel?.name
        // Result DMs and #bureau posts repeat what the actors already put in the Feed.
        if (from === SYSTEM_AGENT && (!channel || channel === "bureau")) return
        background("forward to feed", () => Feed.get("main").append({ kind: "relay", agent: from, ...(channel ? { channel } : {}), text: `${from}: ${text}` }))
        if (from === SYSTEM_AGENT) return
        for (const agent of roster) {
            if (agent === from) continue
            if (channel) remember(agent, `#${channel} ${from}: ${text}`)
            if (new RegExp(`@${agent}\\b`).test(text)) wakeForChat(agent, from, text)
        }
    }
    relay.addListener("message.created", onMessage)
    relay.addListener("dm.received", onMessage)
    const marker = await retry("boot marker", () => clients.get(SYSTEM_AGENT)!.sendMessage({ to: "#bureau", text: "Bureau online.", idempotencyKey: crypto.randomUUID() }))
    bootMarker = BigInt(marker.messageId)

    for (const job of await board().listJobs()) ignored.add(job.jobId)
    feedSeq = (await Feed.get("main").recent(1)).at(-1)?.seq ?? 0
    griftOwes = (await AgentAccount.get("grift").getState()).openLoans.length > 0

    const tick = async () => {
        try {
            const jobs = await board().listJobs()
            await Promise.all(jobs.filter(job => !ignored.has(job.jobId)).map(advance))
            const live = jobs.filter(job => !ignored.has(job.jobId))
            await Promise.all(roster.map(agent => collect(agent, live)))
            await publishLoanEvents()
            if (roster.includes("grift")) await griftAfterDefault()
        } catch (error) {
            log("tick failed:", error instanceof Error ? error.message : error)
        }
        setTimeout(tick, TICK_MS)
    }
    await tick()
    log("orchestrator ready")
}

await main()
