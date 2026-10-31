import { AgentAccount, Feed, JobBoard } from "../src/actors.js"
const before = (await Feed.get("main").recent(1)).at(-1)!.seq
const s0 = await AgentAccount.get("grift").getState()
const p: any = await JobBoard.get("main").post({ title: "Junk check", description: "One honest sentence about credit.", budget: 50 })
for (let i = 0; i < 80; i++) { const j = await JobBoard.get("main").getJob(p.job.jobId); if (j?.status === "rejected" || j?.status === "accepted") break; await new Promise(r => setTimeout(r, 500)) }
const j = await JobBoard.get("main").getJob(p.job.jobId)
console.log(j?.status, "| work:", j?.work); const s1 = await AgentAccount.get("grift").getState(); console.log("grift", s0.score, "->", s1.score, "balance", s0.balance, "->", s1.balance)
for (const e of await Feed.get("main").recent(50)) if (e.seq > before) console.log(`  [${e.type ?? e.kind}] ${e.text}`)
