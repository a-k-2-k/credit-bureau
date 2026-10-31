import { useEffect, useRef, useState } from "react"

const PING_MS = 20_000
const MAX_BACKOFF_MS = 5_000

/**
 * Subscribes to an actor socket and stays subscribed. Grants expire within about a minute, so every
 * attempt fetches a new one. Both actors resend full state on connect, so nothing is lost across a gap.
 */
export function useActorSocket<Message>(actor: string, id: string, onMessage: (message: Message) => void): boolean {
    const [connected, setConnected] = useState(false)
    const handler = useRef(onMessage)
    handler.current = onMessage

    useEffect(() => {
        let disposed = false
        let socket: WebSocket | undefined
        let retry: ReturnType<typeof setTimeout> | undefined
        let ping: ReturnType<typeof setInterval> | undefined
        let backoff = 500

        function reconnect() {
            clearInterval(ping)
            setConnected(false)
            if (disposed) return
            clearTimeout(retry)
            retry = setTimeout(() => void open(), backoff)
            backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
        }

        async function open() {
            try {
                const response = await fetch(`/api/socket/${actor}/${id}`, { method: "POST" })
                if (!response.ok) throw new Error(`socket grant refused (${response.status})`)
                const { websocketUrl } = await response.json()
                if (disposed) return
                socket = new WebSocket(websocketUrl)
                socket.onopen = () => {
                    backoff = 500
                    setConnected(true)
                    ping = setInterval(() => socket?.send("ping"), PING_MS)
                }
                socket.onmessage = event => {
                    try {
                        handler.current(JSON.parse(event.data))
                    } catch {
                        // The keepalive reply is a bare "pong", which is not JSON.
                    }
                }
                socket.onclose = reconnect
            } catch {
                reconnect()
            }
        }

        void open()
        return () => {
            disposed = true
            clearTimeout(retry)
            clearInterval(ping)
            socket?.close()
        }
    }, [actor, id])

    return connected
}
