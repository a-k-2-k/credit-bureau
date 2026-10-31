// Wakes one instance of every actor class so the first calls on stage do not hit a cold start.
import { AgentAccount, Bureau, Feed, JobBoard, Loan } from "../src/actors.js"

const started = Date.now()
await Promise.all([
    ...["atlas", "nova", "sloth", "hype", "grift"].map(agent => AgentAccount.get(agent).getState()),
    Bureau.get("main").getLedger(1),
    Feed.get("main").recent(1),
    JobBoard.get("main").listJobs(),
    Loan.get("warmup").getInfo()
])
console.log(`Warmed all actors in ${Date.now() - started}ms`)
