// Milestone 1: proves loans, repayment, alarm-driven default, and the job lifecycle against live actors.
// TERM_MS=75000 bun scripts/m1.ts runs the default section on the real loan term.
import assert from "node:assert/strict"
import { AgentAccount, Bureau, CLIENT, Feed, JobBoard, Loan, LOAN_TERM_MS } from "../src/actors.js"

const run = Date.now()
const name = (base: string) => `${base}-${run}`
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const bureau = Bureau.get("main")
const board = JobBoard.get("main")
const account = (agent: string) => AgentAccount.get(agent)
const term = Number(process.env.TERM_MS ?? 4_000)
const grace = Number(process.env.GRACE_MS ?? 3_000)

async function section(title: string, body: () => Promise<void>) {
    await body()
    console.log(`  ok  ${title}`)
}

function approved<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
    assert.ok(result.ok, `expected success, got ${JSON.stringify(result)}`)
    return result as Extract<T, { ok: true }>
}

await section("repay on time: principal returned, +25, and the cancelled alarm never fires", async () => {
    const agent = name("nova")
    const { loanId } = approved(await bureau.requestLoan(agent, 50, 8_000))
    assert.equal((await account(agent).getState()).balance, 150)
    const repaid = approved(await bureau.repay(loanId))
    assert.equal(repaid.onTime, true)
    assert.equal(repaid.balance, 100)
    assert.equal(repaid.score, 625)
    await sleep(9_500)
    const state = await account(agent).getState()
    assert.equal((await Loan.get(loanId).getInfo()).status, "repaid")
    assert.equal(state.score, 625)
    assert.deepEqual(state.openLoans, [])
    const twice = await bureau.repay(loanId)
    assert.equal(twice.ok, false)
    assert.equal((await account(agent).getState()).balance, 100)
})

await section("total open debt is capped at (score-500)*2, and repaying frees it up", async () => {
    const agent = name("stacker")
    const first = approved(await bureau.requestLoan(agent, 150))
    const over = await bureau.requestLoan(agent, 51)
    assert.deepEqual(over.ok === false && [over.limit, over.openDebt], [200, 150])
    const second = approved(await bureau.requestLoan(agent, 50))
    assert.equal((await bureau.requestLoan(agent, 1)).ok, false)
    approved(await bureau.repay(first.loanId))
    approved(await bureau.repay(second.loanId))
    assert.equal((await account(agent).getState()).score, 650)
    approved(await bureau.requestLoan(agent, 300))
})

await section("late repayment: -40 at the due date, repaid in grace with no bonus, no default follows", async () => {
    const agent = name("slowpoke")
    const { loanId } = approved(await bureau.requestLoan(agent, 50, 8_000, 5_000))
    await sleep(9_500)
    const info = await Loan.get(loanId).getInfo()
    assert.equal(info.status, "late")
    assert.ok(info.graceUntil)
    assert.equal((await account(agent).getState()).score, 560)
    const repaid = approved(await bureau.repay(loanId))
    assert.deepEqual([repaid.onTime, repaid.balance, repaid.score], [false, 100, 560])
    await sleep(5_000)
    const state = await account(agent).getState()
    assert.equal((await Loan.get(loanId).getInfo()).status, "repaid")
    assert.deepEqual([state.score, state.openLoans.length], [560, 0])
})

await section("underwriting: score 600 caps at 200, and bad amounts are denied", async () => {
    const agent = name("limit")
    const over = await bureau.requestLoan(agent, 201)
    assert.deepEqual(over.ok === false && [over.limit, over.score], [200, 600])
    for (const amount of [0, -50, 1.5, Number.NaN]) assert.equal((await bureau.requestLoan(agent, amount)).ok, false)
    assert.equal((await account(agent).getState()).balance, 100)
})

await section("repay without funds is refused, then late (-40), then default (-120)", async () => {
    const agent = name("sloth")
    const { loanId } = approved(await bureau.requestLoan(agent, 150, 8_000, 4_000))
    assert.equal((await account(agent).debit(200, "spent it")).ok, true)
    assert.equal((await bureau.repay(loanId)).ok, false)
    assert.equal((await Loan.get(loanId).getInfo()).status, "open")
    await sleep(9_500)
    assert.equal((await Loan.get(loanId).getInfo()).status, "late")
    assert.equal((await account(agent).getState()).score, 560)
    assert.equal((await bureau.repay(loanId)).ok, false)
    await sleep(4_500)
    assert.equal((await Loan.get(loanId).getInfo()).status, "defaulted")
    assert.equal((await account(agent).getState()).score, 440)
})

await section("repay racing either alarm: exactly one side wins, no deadlock", async () => {
    const outcomes = await Promise.all(
        Array.from({ length: 16 }, async (_, index) => {
            const agent = name(`race${index}`)
            const atGrace = index % 2 === 1
            const { loanId, dueAt } = approved(await bureau.requestLoan(agent, 40, 8_000, 3_000))
            // Aim each repay at a deadline. A repay takes about 150ms to land.
            const target = atGrace ? dueAt + 3_000 : dueAt
            await sleep(target - Date.now() - 300 + (index % 8) * 40)
            await bureau.repay(loanId)
            await sleep(atGrace ? 800 : 3_800)
            const { status } = await Loan.get(loanId).getInfo()
            const { balance, score, openLoans } = await account(agent).getState()
            assert.deepEqual(openLoans, [])
            if (status === "defaulted") assert.deepEqual([atGrace, balance, score], [true, 140, 440])
            else {
                assert.equal(status, "repaid")
                assert.equal(balance, 100)
                assert.ok(atGrace ? score === 560 : [625, 600, 560].includes(score), `repaid at score ${score}`)
            }
            return `${atGrace ? "grace" : "due"}:${status}${status === "repaid" ? `@${score}` : ""}`
        })
    )
    const tally = outcomes.reduce<Record<string, number>>((all, key) => ({ ...all, [key]: (all[key] ?? 0) + 1 }), {})
    console.log(`      ${JSON.stringify(tally)}`)
})

await section("score clamps to 300..850, and applyDefault is idempotent", async () => {
    const agent = name("clamp")
    assert.equal((await account(agent).adjustScore(10_000, "test")).score, 850)
    assert.equal((await account(agent).adjustScore(-10_000, "test")).score, 300)
    const { score } = await account(name("fresh")).applyDefault("no-such-loan")
    assert.equal(score, 600)
})

await section("job accepted: client pays, worker +10", async () => {
    const worker = name("atlas")
    const { job } = approved(await board.post({ title: "write docs", budget: 60 }))
    assert.equal(job.poster, CLIENT)
    assert.equal((await board.bid(job.jobId, worker, 61)).ok, false)
    approved(await board.bid(job.jobId, worker, 50))
    approved(await board.award(job.jobId, worker))
    assert.equal((await board.submit(job.jobId, name("other"), "x")).ok, false)
    approved(await board.submit(job.jobId, worker, "the docs"))
    approved(await board.accept(job.jobId))
    const state = await account(worker).getState()
    assert.deepEqual([state.balance, state.score], [150, 610])
    assert.equal((await board.accept(job.jobId)).ok, false)
    assert.equal((await account(worker).getState()).balance, 150)
})

await section("subcontract: escrow needs funds, a loan covers it, rejection refunds and costs -30", async () => {
    const lead = name("lead")
    const sub = name("sub")
    const { job } = approved(await board.post({ title: "subcontract", budget: 150, poster: lead }))
    approved(await board.bid(job.jobId, sub, 120))
    assert.equal((await board.award(job.jobId, sub)).ok, false)
    assert.equal((await board.getJob(job.jobId))?.status, "open")
    const { loanId } = approved(await bureau.requestLoan(lead, 50, 30_000))
    approved(await board.award(job.jobId, sub))
    assert.equal((await account(lead).getState()).balance, 30)
    approved(await board.submit(job.jobId, sub, "junk"))
    approved(await board.reject(job.jobId, "junk"))
    assert.equal((await account(lead).getState()).balance, 150)
    const worker = await account(sub).getState()
    assert.deepEqual([worker.balance, worker.score], [100, 570])
    approved(await bureau.repay(loanId))
})

await section(`DEMO MOMENT (term ${term}ms + grace ${grace}ms): borrow max, late, default, next request DENIED`, async () => {
    const agent = name("grift")
    const { loanId, dueAt } = approved(await bureau.requestLoan(agent, 200, term, grace))
    const before = await account(agent).getState()
    assert.deepEqual([before.balance, before.score, before.openLoans.length], [300, 600, 1])
    await sleep(Math.max(0, dueAt - Date.now()) + 1_000)
    assert.equal((await Loan.get(loanId).getInfo()).status, "late")
    assert.equal((await account(agent).getState()).score, 560)
    const whileLate = await bureau.requestLoan(agent, 10)
    console.log(`      denied while late: ${whileLate.ok === false && whileLate.reason}`)
    assert.equal(whileLate.ok, false)
    await sleep(grace + 500)
    assert.equal((await Loan.get(loanId).getInfo()).status, "defaulted")
    const after = await account(agent).getState()
    assert.deepEqual([after.balance, after.score, after.openLoans.length], [300, 440, 0])
    const denied = await bureau.requestLoan(agent, 10)
    assert.equal(denied.ok, false)
    console.log(`      denied after default: ${denied.ok === false && denied.reason}`)
    assert.equal((await bureau.repay(loanId)).ok, false)
    const feed = (await Feed.get("main").recent(100)).filter(event => event.agent === agent).map(event => event.kind)
    assert.deepEqual(feed, ["loan", "late", "denied", "default", "denied"])
    const ledger = (await bureau.getLedger(50)).filter(entry => entry.agent === agent).map(entry => entry.event).reverse()
    assert.deepEqual(ledger, ["approved", "late", "denied", "defaulted", "denied", "repay_refused"])
})

console.log(`\nMilestone 1 passed in ${((Date.now() - run) / 1000).toFixed(1)}s (default loan term is ${LOAN_TERM_MS}ms)`)
