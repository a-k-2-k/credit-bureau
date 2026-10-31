// Milestone 2: post one client job and wait for it to settle over Relay. Needs the orchestrator running.
import { AgentAccount, Feed, JobBoard } from "../src/actors.js"

const budget = Number(process.env.BUDGET ?? 200)
const agents = (process.env.AGENTS ?? "atlas,nova").split(",")
const started = Date.now()
const before = (await Feed.get("main").recent(1)).at(-1)?.seq ?? 0
const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)}s`

const posted = await JobBoard.get("main").post({ title: "Write a launch announcement", description: "Three punchy sentences announcing the Agent Credit Bureau.", budget })
if (!posted.ok) throw new Error(posted.reason)
const { jobId } = posted.job
console.log(`posted ${jobId} with budget ${budget}`)

let status = ""
while (Date.now() - started < 240_000) {
    const job = await JobBoard.get("main").getJob(jobId)
    const debts = await Promise.all(agents.map(async agent => (await AgentAccount.get(agent).getState()).openLoans.length))
    const state = `${job?.status} (${job?.bids.length} bids, worker ${job?.worker}, open loans ${debts.reduce((a, b) => a + b, 0)})`
    if (state !== status) console.log(`  ${elapsed()} ${state}`)
    status = state
    if (job?.status === "accepted" && debts.every(count => count === 0)) break
    if (job?.status === "rejected") break
    await new Promise(resolve => setTimeout(resolve, 1_000))
}

console.log(`\nFinished in ${elapsed()}: ${status}\n`)
for (const event of await Feed.get("main").recent(200)) if (event.seq > before) console.log(`  [${event.kind}] ${event.text}`)
console.log()
for (const agent of agents) {
    const { balance, score, openLoans } = await AgentAccount.get(agent).getState()
    console.log(`  ${agent}: balance ${balance}, score ${score}, open loans ${openLoans.length}`)
}
