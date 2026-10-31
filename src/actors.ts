import { Actor, type ActorContext, type ActorSocket, Emittable, Persisted } from "durable-actors"

/*
 * Call graph is a DAG on purpose. An actor is held across `await`, so a cycle can deadlock.
 *   Bureau   -> Loan, AgentAccount, Feed
 *   JobBoard -> AgentAccount, Feed
 *   Loan     -> AgentAccount, Feed      (never Bureau: repay holds Bureau while it waits on Loan)
 *   AgentAccount, Feed are leaves.
 */

export const STARTING_BALANCE = 100
export const STARTING_SCORE = 600
export const SCORE_MIN = 300
export const SCORE_MAX = 850
export const LOAN_TERM_MS = 75_000
export const GRACE_MS = 30_000
export const LATE_PENALTY = 40
export const DEFAULT_PENALTY = 120
export const ON_TIME_BONUS = 25
export const MIN_SCORE_TO_BORROW = 550
export const JOB_ACCEPTED_BONUS = 10
export const JOB_REJECTED_PENALTY = 30
/** The human customer behind the UI. Not an agent, so it has no account and its jobs need no escrow debit. */
export const CLIENT = "client"

export type LoanStatus = "open" | "late" | "repaid" | "defaulted"
/** `graceUntil` is null until the loan goes late. */
export type OpenLoan = { loanId: string; principal: number; dueAt: number; graceUntil: number | null }
export type AccountState = { id: string; balance: number; score: number; openLoans: OpenLoan[] }
export type LoanInfo = { loanId: string; borrower: string; principal: number; dueAt: number; graceUntil: number | null; status: LoanStatus }
export type Result = { ok: true } | { ok: false; reason: string }
export type LoanDecision =
    | { ok: true; loanId: string; amount: number; dueAt: number; score: number; balance: number }
    | { ok: false; reason: string; score: number; limit: number; openDebt: number }
export type RepayResult = { ok: true; onTime: boolean; balance: number; score: number } | { ok: false; reason: string }

export type JobStatus = "open" | "awarded" | "submitted" | "accepted" | "rejected"
export type Bid = { agent: string; price: number; pitch: string }
export type Job = {
    jobId: string
    title: string
    description: string
    budget: number
    poster: string
    status: JobStatus
    bids: Bid[]
    worker: string | null
    price: number | null
    work: string | null
}
export type JobResult = { ok: true; job: Job } | { ok: false; reason: string }

export type FeedKind = "relay" | "loan" | "repay" | "late" | "default" | "denied" | "job" | "score" | "system"
/** Set on loan decisions only, so the UI can key animations off `type` without parsing `text`. */
export type LoanEventType = "approved" | "denied" | "late" | "defaulted" | "repaid"
export type FeedInput = {
    kind: FeedKind
    text: string
    agent?: string
    channel?: string
    loanId?: string
    jobId?: string
    type?: LoanEventType
    amount?: number
    score?: number
    reason?: string | null
}
export type FeedEvent = FeedInput & { seq: number; at: number }

type Viewer = { viewer: string }
type Ping = { type: "ping" }
type AccountOutgoing = { type: "change"; reason: string; balance: number; score: number; openLoans: OpenLoan[] }
type FeedOutgoing = { type: "history"; events: FeedEvent[] } | { type: "event"; event: FeedEvent }

const clampScore = (score: number) => Math.min(SCORE_MAX, Math.max(SCORE_MIN, score))
export const creditLimit = (score: number) => Math.max(0, (score - 500) * 2)

export class AgentAccount extends Actor<Viewer, Ping, AccountOutgoing> {
    @Persisted @Emittable balance = STARTING_BALANCE
    @Persisted @Emittable score = STARTING_SCORE
    @Persisted @Emittable openLoans: OpenLoan[] = []

    async getState(): Promise<AccountState> {
        return this.#snapshot()
    }

    async credit(amount: number, reason: string): Promise<AccountState> {
        this.balance += amount
        return this.#changed(reason)
    }

    async debit(amount: number, reason: string): Promise<{ ok: boolean; balance: number }> {
        if (this.balance < amount) return { ok: false, balance: this.balance }
        this.balance -= amount
        this.#changed(reason)
        return { ok: true, balance: this.balance }
    }

    async adjustScore(delta: number, reason: string): Promise<AccountState> {
        this.score = clampScore(this.score + delta)
        return this.#changed(reason)
    }

    async receiveLoan(loan: OpenLoan): Promise<AccountState> {
        this.balance += loan.principal
        this.openLoans = [...this.openLoans, loan]
        return this.#changed(`loan ${loan.loanId} funded`)
    }

    async repayLoan(loanId: string, onTime: boolean): Promise<Result> {
        const loan = this.openLoans.find(open => open.loanId === loanId)
        if (!loan) return { ok: false, reason: `${loanId} is not open` }
        if (this.balance < loan.principal) {
            return { ok: false, reason: `needs ${loan.principal} credits, has ${this.balance}` }
        }
        this.balance -= loan.principal
        this.openLoans = this.openLoans.filter(open => open.loanId !== loanId)
        if (onTime) this.score = clampScore(this.score + ON_TIME_BONUS)
        this.#changed(`loan ${loanId} repaid`)
        return { ok: true }
    }

    /** Idempotent: a retried alarm must not charge the penalty twice. */
    async applyLate(loanId: string, graceUntil: number): Promise<AccountState> {
        const loan = this.openLoans.find(open => open.loanId === loanId)
        if (!loan || loan.graceUntil !== null) return this.#snapshot()
        this.openLoans = this.openLoans.map(open => (open.loanId === loanId ? { ...open, graceUntil } : open))
        this.score = clampScore(this.score - LATE_PENALTY)
        return this.#changed(`loan ${loanId} late`)
    }

    /** Idempotent: a retried alarm must not charge the penalty twice. */
    async applyDefault(loanId: string): Promise<AccountState> {
        if (!this.openLoans.some(open => open.loanId === loanId)) return this.#snapshot()
        this.openLoans = this.openLoans.filter(open => open.loanId !== loanId)
        this.score = clampScore(this.score - DEFAULT_PENALTY)
        return this.#changed(`loan ${loanId} defaulted`)
    }

    async onConnect(socket: ActorSocket<Viewer, AccountOutgoing>): Promise<void> {
        this.setWebSocketAutoResponse({ request: "ping", response: "pong" })
        socket.send({ type: "change", reason: "connected", ...this.#values() })
    }

    #values() {
        return { balance: this.balance, score: this.score, openLoans: this.openLoans }
    }

    #snapshot(): AccountState {
        return { id: this.id, ...this.#values() }
    }

    #changed(reason: string): AccountState {
        this.broadcast({ type: "change", reason, ...this.#values() })
        return this.#snapshot()
    }
}

/** One actor per loan because each actor has exactly one alarm. */
export class Loan extends Actor {
    @Persisted @Emittable borrower = ""
    @Persisted @Emittable principal = 0
    @Persisted @Emittable dueAt = 0
    @Persisted @Emittable graceUntil: number | null = null
    @Persisted @Emittable status: LoanStatus = "open"
    @Persisted private graceMs = GRACE_MS

    async open(borrower: string, principal: number, dueAt: number, graceMs: number = GRACE_MS): Promise<void> {
        this.borrower = borrower
        this.principal = principal
        this.dueAt = dueAt
        this.graceMs = graceMs
        this.alarm.set(dueAt)
    }

    async getInfo(): Promise<LoanInfo> {
        return { loanId: this.id, borrower: this.borrower, principal: this.principal, dueAt: this.dueAt, graceUntil: this.graceUntil, status: this.status }
    }

    /** Repayment is decided here so it serialises against onAlarm: exactly one of them wins. */
    async repay(): Promise<RepayResult> {
        if (!this.borrower) return { ok: false, reason: `unknown loan ${this.id}` }
        if (this.status !== "open" && this.status !== "late") return { ok: false, reason: `loan ${this.id} already ${this.status}` }
        const onTime = this.status === "open" && Date.now() <= this.dueAt
        const account = AgentAccount.get(this.borrower)
        const paid = await account.repayLoan(this.id, onTime)
        if (!paid.ok) return paid
        this.status = "repaid"
        this.alarm.delete()
        const { balance, score } = await account.getState()
        return { ok: true, onTime, balance, score }
    }

    /** First alarm: late, -40, re-armed for the grace period. Second alarm: default, -120. */
    async onAlarm(): Promise<void> {
        if (this.status === "open") {
            const graceUntil = Date.now() + this.graceMs
            this.status = "late"
            this.graceUntil = graceUntil
            this.alarm.set(graceUntil)
            const { score } = await AgentAccount.get(this.borrower).applyLate(this.id, graceUntil)
            await Feed.get("main").append({
                kind: "late",
                type: "late",
                agent: this.borrower,
                loanId: this.id,
                amount: this.principal,
                score,
                reason: `missed due date, ${Math.round(this.graceMs / 1000)}s grace to repay`,
                text: `LATE: ${this.borrower} missed the due date on ${this.id} (${this.principal} credits). Score fell to ${score}, ${Math.round(this.graceMs / 1000)}s to repay.`
            })
        } else if (this.status === "late") {
            this.status = "defaulted"
            const { score } = await AgentAccount.get(this.borrower).applyDefault(this.id)
            await Feed.get("main").append({
                kind: "default",
                type: "defaulted",
                agent: this.borrower,
                loanId: this.id,
                amount: this.principal,
                score,
                reason: "unpaid after the grace period",
                text: `DEFAULT: ${this.borrower} never repaid ${this.id} (${this.principal} credits). Score fell to ${score}.`
            })
        }
    }
}

export class Bureau extends Actor {
    constructor(context: ActorContext) {
        super(context)
        this.db.exec(`CREATE TABLE IF NOT EXISTS ledger (
            id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, event TEXT NOT NULL,
            agent TEXT NOT NULL, loan_id TEXT, amount INTEGER, detail TEXT)`)
        this.db.exec(`CREATE TABLE IF NOT EXISTS loans (
            loan_id TEXT PRIMARY KEY, agent TEXT NOT NULL, amount INTEGER NOT NULL, due_at INTEGER NOT NULL, status TEXT NOT NULL)`)
    }

    async requestLoan(agent: string, amount: number, termMs: number = LOAN_TERM_MS, graceMs: number = GRACE_MS): Promise<LoanDecision> {
        await this.#reconcile()
        const account = AgentAccount.get(agent)
        const { score, openLoans } = await account.getState()
        const openDebt = openLoans.reduce((total, loan) => total + loan.principal, 0)
        const limit = score < MIN_SCORE_TO_BORROW ? 0 : creditLimit(score)

        let reason: string | null = null
        if (!Number.isInteger(amount) || amount <= 0) reason = "amount must be a positive whole number"
        else if (score < MIN_SCORE_TO_BORROW) reason = `score ${score} is below ${MIN_SCORE_TO_BORROW}`
        else if (openDebt + amount > limit) reason = `${amount} on top of ${openDebt} open debt exceeds limit ${limit} at score ${score}`

        if (reason) {
            this.#record("denied", agent, null, amount, reason)
            await Feed.get("main").append({
                kind: "denied",
                type: "denied",
                agent,
                amount: Number.isFinite(amount) ? amount : 0,
                score,
                reason,
                text: `DENIED: ${agent} asked for ${amount} credits. ${reason}.`
            })
            return { ok: false, reason, score, limit, openDebt }
        }

        const loanId = `loan-${crypto.randomUUID().slice(0, 8)}`
        const dueAt = Date.now() + termMs
        await Loan.get(loanId).open(agent, amount, dueAt, graceMs)
        const { balance } = await account.receiveLoan({ loanId, principal: amount, dueAt, graceUntil: null })
        this.db.exec("INSERT INTO loans (loan_id, agent, amount, due_at, status) VALUES (?, ?, ?, ?, 'open')", loanId, agent, amount, dueAt)
        this.#record("approved", agent, loanId, amount, null)
        await Feed.get("main").append({
            kind: "loan",
            type: "approved",
            agent,
            loanId,
            amount,
            score,
            reason: null,
            text: `APPROVED: ${agent} borrowed ${amount} credits (${loanId}), due in ${Math.round(termMs / 1000)}s.`
        })
        return { ok: true, loanId, amount, dueAt, score, balance }
    }

    async repay(loanId: string): Promise<RepayResult> {
        const result = await Loan.get(loanId).repay()
        const { agent, amount } = this.db.exec("SELECT agent, amount FROM loans WHERE loan_id = ?", loanId)[0] ?? { agent: "unknown", amount: null }
        if (!result.ok) {
            this.#record("repay_refused", String(agent), loanId, amount === null ? null : Number(amount), result.reason)
            return result
        }
        this.db.exec("UPDATE loans SET status = 'repaid' WHERE loan_id = ?", loanId)
        this.#record(result.onTime ? "repaid" : "repaid_late", String(agent), loanId, Number(amount), null)
        await Feed.get("main").append({
            kind: "repay",
            type: "repaid",
            agent: String(agent),
            loanId,
            amount: Number(amount),
            score: result.score,
            reason: result.onTime ? "on time" : "late",
            text: `REPAID: ${agent} repaid ${amount} credits (${loanId}) ${result.onTime ? "on time. Score up to" : "late. Score stays"} ${result.score}.`
        })
        return result
    }

    async getLedger(limit: number = 100): Promise<LedgerEntry[]> {
        await this.#reconcile()
        return this.db.exec("SELECT at, event, agent, loan_id, amount, detail FROM ledger ORDER BY id DESC LIMIT ?", limit) as LedgerEntry[]
    }

    /** Loan cannot call back into Bureau, so overdue loans are pulled into the ledger here. */
    async #reconcile(): Promise<void> {
        const overdue = this.db.exec("SELECT loan_id, agent, amount, status FROM loans WHERE status IN ('open', 'late') AND due_at <= ?", Date.now())
        for (const row of overdue) {
            const loanId = String(row.loan_id)
            const { status } = await Loan.get(loanId).getInfo()
            if (status === row.status || status === "repaid") continue
            this.db.exec("UPDATE loans SET status = ? WHERE loan_id = ?", status, loanId)
            this.#record(status === "late" ? "late" : "defaulted", String(row.agent), loanId, Number(row.amount), null)
        }
    }

    #record(event: string, agent: string, loanId: string | null, amount: number | null, detail: string | null): void {
        this.db.exec("INSERT INTO ledger (at, event, agent, loan_id, amount, detail) VALUES (?, ?, ?, ?, ?, ?)", Date.now(), event, agent, loanId, amount, detail)
    }
}

export type LedgerEntry = { at: number; event: string; agent: string; loan_id: string | null; amount: number | null; detail: string | null }

export class JobBoard extends Actor {
    @Persisted @Emittable jobs: Job[] = []

    async listJobs(): Promise<Job[]> {
        return this.jobs
    }

    async getJob(jobId: string): Promise<Job | null> {
        return this.#find(jobId) ?? null
    }

    async post(input: { title: string; description?: string; budget: number; poster?: string }): Promise<JobResult> {
        if (!Number.isInteger(input.budget) || input.budget <= 0) return { ok: false, reason: "budget must be a positive whole number" }
        const job: Job = {
            jobId: `job-${crypto.randomUUID().slice(0, 8)}`,
            title: input.title,
            description: input.description ?? "",
            budget: input.budget,
            poster: input.poster ?? CLIENT,
            status: "open",
            bids: [],
            worker: null,
            price: null,
            work: null
        }
        this.jobs = [...this.jobs, job].slice(-50)
        await this.#feed(job, job.poster, `JOB: ${job.poster} posted "${job.title}" (${job.jobId}) with budget ${job.budget}.`)
        return { ok: true, job }
    }

    async bid(jobId: string, agent: string, price: number, pitch: string = ""): Promise<JobResult> {
        const job = this.#find(jobId)
        if (!job) return { ok: false, reason: `unknown job ${jobId}` }
        if (job.status !== "open") return { ok: false, reason: `job is ${job.status}` }
        if (agent === job.poster) return { ok: false, reason: "cannot bid on your own job" }
        if (!Number.isInteger(price) || price <= 0) return { ok: false, reason: "price must be a positive whole number" }
        if (price > job.budget) return { ok: false, reason: `price ${price} exceeds budget ${job.budget}` }
        const bids = [...job.bids.filter(bid => bid.agent !== agent), { agent, price, pitch }]
        const updated = this.#update(jobId, { bids })
        await this.#feed(updated, agent, `BID: ${agent} bid ${price} on ${jobId}.`)
        return { ok: true, job: updated }
    }

    /** Funds the escrow at the winning price. A poster without the balance is refused, which is what forces borrowing. */
    async award(jobId: string, agent: string): Promise<JobResult> {
        const job = this.#find(jobId)
        if (!job) return { ok: false, reason: `unknown job ${jobId}` }
        if (job.status !== "open") return { ok: false, reason: `job is ${job.status}` }
        const bid = job.bids.find(candidate => candidate.agent === agent)
        if (!bid) return { ok: false, reason: `${agent} has not bid on ${jobId}` }
        if (job.poster !== CLIENT) {
            const escrow = await AgentAccount.get(job.poster).debit(bid.price, `escrow for ${jobId}`)
            if (!escrow.ok) return { ok: false, reason: `${job.poster} has ${escrow.balance} credits, escrow needs ${bid.price}` }
        }
        const updated = this.#update(jobId, { status: "awarded", worker: agent, price: bid.price })
        await this.#feed(updated, job.poster, `AWARD: ${jobId} to ${agent} for ${bid.price}, funds in escrow.`)
        return { ok: true, job: updated }
    }

    async submit(jobId: string, agent: string, work: string): Promise<JobResult> {
        const job = this.#find(jobId)
        if (!job) return { ok: false, reason: `unknown job ${jobId}` }
        if (job.status !== "awarded") return { ok: false, reason: `job is ${job.status}` }
        if (job.worker !== agent) return { ok: false, reason: `${jobId} was awarded to ${job.worker}` }
        const updated = this.#update(jobId, { status: "submitted", work })
        await this.#feed(updated, agent, `SUBMIT: ${agent} delivered ${jobId}.`)
        return { ok: true, job: updated }
    }

    async accept(jobId: string): Promise<JobResult> {
        const job = this.#find(jobId)
        if (!job) return { ok: false, reason: `unknown job ${jobId}` }
        if (job.status !== "submitted") return { ok: false, reason: `job is ${job.status}` }
        const worker = AgentAccount.get(job.worker!)
        await worker.credit(job.price!, `paid for ${jobId}`)
        const { score } = await worker.adjustScore(JOB_ACCEPTED_BONUS, `${jobId} accepted`)
        const updated = this.#update(jobId, { status: "accepted" })
        await this.#feed(updated, job.worker!, `ACCEPTED: ${job.worker} paid ${job.price} for ${jobId}. Score up to ${score}.`)
        return { ok: true, job: updated }
    }

    /** Refunds the escrow to an agent poster and costs the worker score. */
    async reject(jobId: string, reason: string = "work rejected"): Promise<JobResult> {
        const job = this.#find(jobId)
        if (!job) return { ok: false, reason: `unknown job ${jobId}` }
        if (job.status !== "submitted") return { ok: false, reason: `job is ${job.status}` }
        if (job.poster !== CLIENT) await AgentAccount.get(job.poster).credit(job.price!, `escrow refund for ${jobId}`)
        const { score } = await AgentAccount.get(job.worker!).adjustScore(-JOB_REJECTED_PENALTY, `${jobId} rejected`)
        const updated = this.#update(jobId, { status: "rejected" })
        await this.#feed(updated, job.worker!, `REJECTED: ${job.worker}'s work on ${jobId}: ${reason}. Score down to ${score}.`)
        return { ok: true, job: updated }
    }

    #find(jobId: string): Job | undefined {
        return this.jobs.find(job => job.jobId === jobId)
    }

    #update(jobId: string, changes: Partial<Job>): Job {
        const updated = { ...this.#find(jobId)!, ...changes }
        this.jobs = this.jobs.map(job => (job.jobId === jobId ? updated : job))
        return updated
    }

    async #feed(job: Job, agent: string, text: string): Promise<void> {
        await Feed.get("main").append({ kind: "job", agent, jobId: job.jobId, text })
    }
}

export class Feed extends Actor<Viewer, Ping, FeedOutgoing> {
    @Persisted private events: FeedEvent[] = []
    @Persisted private seq = 0

    async append(input: FeedInput): Promise<FeedEvent> {
        this.seq += 1
        const event: FeedEvent = { ...input, seq: this.seq, at: Date.now() }
        this.events = [...this.events, event].slice(-200)
        this.broadcast({ type: "event", event })
        return event
    }

    async recent(limit: number = 50): Promise<FeedEvent[]> {
        return this.events.slice(-limit)
    }

    async onConnect(socket: ActorSocket<Viewer, FeedOutgoing>): Promise<void> {
        this.setWebSocketAutoResponse({ request: "ping", response: "pong" })
        socket.send({ type: "history", events: this.events })
    }
}
