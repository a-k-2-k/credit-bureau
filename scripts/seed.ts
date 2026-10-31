// Fake activity for testing the UI: open the page, then run `bun scripts/seed.ts` and watch it arrive.
// It goes through the real actor APIs, so it changes the real atlas/nova/sloth/hype/grift accounts and
// Feed "main", and those changes persist. Do not run it right before a demo; each run also stacks on the last.
import { Bureau, CLIENT, Feed, JobBoard, LOAN_TERM_MS } from "../src/actors.js"

const DEFAULT_TERM_MS = 6_000
const DEFAULT_GRACE_MS = 6_000
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const beat = () => sleep(500)
const bureau = Bureau.get("main")
const board = JobBoard.get("main")
const feed = Feed.get("main")

/** Matches what the orchestrator forwards: no channel means a DM. */
async function relay(agent: string, channel: string | undefined, text: string) {
    await feed.append({ kind: "relay", agent, ...(channel ? { channel } : {}), text: `${agent}: ${text}` })
    await beat()
}

async function postJob(title: string, description: string, budget: number): Promise<string> {
    const posted = await board.post({ title, description, budget, poster: CLIENT })
    if (!posted.ok) throw new Error(posted.reason)
    await beat()
    return posted.job.jobId
}

async function runJob(jobId: string, winner: string, price: number, loser: string, outcome: "accept" | "reject") {
    await board.bid(jobId, loser, price + 10, "I can do this by midnight.")
    await beat()
    await board.bid(jobId, winner, price, "Cheapest and fastest in the graveyard.")
    await beat()
    await board.award(jobId, winner)
    await beat()
    await board.submit(jobId, winner, "Delivered.")
    await beat()
    if (outcome === "accept") await board.accept(jobId)
    else await board.reject(jobId, "the copy was plagiarised")
    await beat()
}

await relay("atlas", "jobs", "Looking for steady work. References available.")
await relay("grift", "bureau", "Guaranteed 10x returns, ask me how.")

const atlasLoan = await bureau.requestLoan("atlas", 120, LOAN_TERM_MS)
console.log("atlas loan", atlasLoan)
await beat()
const novaLoan = await bureau.requestLoan("nova", 80, LOAN_TERM_MS)
await beat()
if (novaLoan.ok) await bureau.repay(novaLoan.loanId)
await beat()

await bureau.requestLoan("grift", 500)
await beat()
const griftLoan = await bureau.requestLoan("grift", 90, LOAN_TERM_MS)
await beat()

await runJob(await postJob("Write launch copy", "Three taglines for a haunted house.", 60), "nova", 45, "hype", "accept")
await runJob(await postJob("Audit the crypt ledger", "Reconcile last month's entries.", 80), "hype", 70, "atlas", "reject")
await postJob("Summon a landing page", "One page, dark theme.", 150)

const slothLoan = await bureau.requestLoan("sloth", 60, DEFAULT_TERM_MS, DEFAULT_GRACE_MS)
console.log("sloth loan", slothLoan)
await relay("sloth", undefined, "@grift I will repay that tomorrow. Probably.")

const wait = DEFAULT_TERM_MS + DEFAULT_GRACE_MS
console.log(`Waiting ${wait / 1000}s for sloth to go late, then default...`)
await sleep(wait + 2_000)
console.log("sloth denied", await bureau.requestLoan("sloth", 20))

// Repaid so these loans cannot go late and default after the script has exited.
if (atlasLoan.ok) await bureau.repay(atlasLoan.loanId)
await beat()
if (griftLoan.ok) await bureau.repay(griftLoan.loanId)
console.log("Seeded.")
