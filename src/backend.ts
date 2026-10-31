import { SocketProxy } from "durable-actors/proxy"
import type { ProxyActor } from "durable-actors/proxy"
import express from "express"
import { createServer as createHttpServer } from "node:http"
import { createServer } from "vite"

import { JobBoard } from "./actors.js"
import { AGENTS } from "./roster.js"

const app = express()
const server = createHttpServer(app)
const port = Number(process.env.PORT ?? 3000)
app.use(express.json())

type SocketActors = { AgentAccount: ProxyActor<{ viewer: string }>; Feed: ProxyActor<{ viewer: string }> }
const sockets = new SocketProxy<SocketActors>({ AgentAccount: {}, Feed: {} })
const socketAllowed = (actorName: string, actorId: string) =>
    actorName === "Feed" ? actorId === "main" : actorName === "AgentAccount" && (AGENTS as readonly string[]).includes(actorId)

app.post("/api/socket/:actorName/:actorId", async (request, response) => {
    const { actorName, actorId } = request.params
    if (!socketAllowed(actorName, actorId)) {
        response.status(404).json({ ok: false, reason: "unknown actor" })
        return
    }
    const grant = await sockets.handle({ actorName: actorName as keyof SocketActors, actorId, metadata: { viewer: "ui" } })
    response.set("Cache-Control", "no-store").json(grant)
})

app.post("/api/jobs", async (request, response) => {
    const title = String(request.body?.title ?? "").trim()
    if (!title) {
        response.status(400).json({ ok: false, reason: "title is required" })
        return
    }
    const result = await JobBoard.get("main").post({
        title,
        description: String(request.body?.description ?? "").trim(),
        budget: Number(request.body?.budget)
    })
    response.status(result.ok ? 201 : 400).json(result)
})

const vite = await createServer({
    server: { middlewareMode: true, hmr: { server }, fs: { deny: [".env", ".env.*", "**/.durable-actors/**", "**/.git/**"] } }
})
app.use(vite.middlewares)
server.listen(port, "127.0.0.1", () => console.log(`Agent Credit Bureau: http://127.0.0.1:${port}`))
