// One job that drives all three outcomes: nova repays on time, sloth repays late, grift defaults and is DENIED.
// Needs the actor server and the orchestrator running with all five agents.
import { AgentAccount, Bureau, Feed, JobBoard, STARTING_BALANCE, STARTING_SCORE, type FeedEvent } from "../src/actors.js"

const BUDGET = Number(process.env.BUDGET ?? 300)
const LIMIT_MS = 240_000
const AGENTS = ["atlas", "nova", "sloth", "hype", "grift"]
const started = Date.now()
const stamp = () => `+${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s`
const feed = Feed.get("main")
const board = JobBoard.get("main")

async function accounts() {
    return Promise.all(AGENTS.map(agent => AgentAccount.get(agent).getState()))
}

console.log("Starting state:")
for (const { id, balance, score, openLoans } of await accounts()) {
    const stale = balance !== STARTING_BALANCE || score !== STARTING_SCORE || openLoans.length > 0
    console.log(`  ${id.padEnd(6)} balance ${String(balance).padStart(4)}  score ${score}  open loans ${openLoans.length}${stale ? "  (not fresh)" : ""}`)
}

const firstSeq = ((await feed.recent(1)).at(-1)?.seq ?? 0) + 1
const posted = await board.post({ title: "Launch announcement", description: "Three punchy sentences announcing the Agent Credit Bureau.", budget: BUDGET })
if (!posted.ok) throw new Error(posted.reason)
const { jobId } = posted.job
console.log(`\nPosted ${jobId} with budget ${BUDGET}\n`)

const events: FeedEvent[] = []
let lastSeq = firstSeq - 1

const seen = (agent: string, type: FeedEvent["type"], reason?: string) =>
    events.find(event => event.agent === agent && event.type === type && (reason === undefined || event.reason === reason))

function outcomes() {
    const griftDefault = seen("grift", "defaulted")
    const deniedAfter = griftDefault && events.find(event => event.agent === "grift" && event.type === "denied" && event.seq > griftDefault.seq)
    return [
        { name: "nova repays on time", event: seen("nova", "repaid", "on time") },
        { name: "sloth goes late", event: seen("sloth", "late") },
        { name: "sloth repays in grace", event: seen("sloth", "repaid", "late") },
        { name: "grift defaults", event: griftDefault },
        { name: "grift is DENIED after default", event: deniedAfter || undefined }
    ]
}

let jobDone = false
while (Date.now() - started < LIMIT_MS) {
    for (const event of await feed.recent(200)) {
        if (event.seq <= lastSeq) continue
        lastSeq = event.seq
        events.push(event)
        const label = (event.type ?? event.kind).toUpperCase().padEnd(9)
        console.log(`${stamp()}  ${label} ${event.text}`)
    }
    const job = await board.getJob(jobId)
    jobDone = job?.status === "accepted" || job?.status === "rejected"
    if (jobDone && outcomes().every(outcome => outcome.event)) break
    await new Promise(resolve => setTimeout(resolve, 500))
}

const ms = (event: FeedEvent) => `+${((event.at - started) / 1000).toFixed(1)}s`
console.log(`\nFinished in ${stamp().trim()}. Job ${jobId}: ${(await board.getJob(jobId))?.status}\n`)
const results = outcomes()
for (const { name, event } of results) console.log(`  ${event ? "PASS" : "FAIL"}  ${name}${event ? ` at ${ms(event)}` : ""}`)
console.log("\nFinal state:")
for (const { id, balance, score, openLoans } of await accounts()) console.log(`  ${id.padEnd(6)} balance ${String(balance).padStart(4)}  score ${score}  open loans ${openLoans.length}`)
const ledger = (await Bureau.get("main").getLedger(30)).filter(entry => entry.at >= started).reverse()
console.log(`\nBureau ledger: ${ledger.map(entry => `${entry.agent} ${entry.event}`).join(", ")}`)
process.exit(results.every(outcome => outcome.event) && jobDone ? 0 : 1)
