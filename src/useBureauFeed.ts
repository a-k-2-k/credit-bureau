import { useReducer } from "react"

import type { FeedEvent } from "./actors"
import { AGENTS, type AgentName } from "./roster"
import { useActorSocket } from "./useActorSocket"

type FeedMessage = { type: "history"; events: FeedEvent[] } | { type: "event"; event: FeedEvent }

export type Denial = { seq: number; agent: AgentName; reason: string }
type Outcome = { seq: number; defaulted: boolean }
export type FeedState = {
    events: FeedEvent[]
    seen: Set<number>
    tally: { repaid: number; late: number; defaulted: number }
    outcomes: Partial<Record<AgentName, Outcome>>
    lastDenial: Partial<Record<AgentName, number>>
    toasts: Denial[]
}
type Action = { type: "absorb"; events: FeedEvent[]; live: boolean } | { type: "dismiss"; seq: number }

const FEED_LIMIT = 200
const MAX_TOASTS = 3
const initial: FeedState = {
    events: [],
    seen: new Set(),
    tally: { repaid: 0, late: 0, defaulted: 0 },
    outcomes: {},
    lastDenial: {},
    toasts: []
}

const isAgent = (name: string | undefined): name is AgentName => (AGENTS as readonly (string | undefined)[]).includes(name)

function denialReason(text: string): string {
    const score = /score (\d+) is below (\d+)/.exec(text)
    if (score) return `score ${score[1]} < ${score[2]}`
    const limit = /(\d+) on top of (\d+) open debt exceeds limit (\d+)/.exec(text)
    if (limit) return `${limit[1]} + ${limit[2]} owed > limit ${limit[3]}`
    return /credits\. (.+?)\.?$/.exec(text)?.[1] ?? "refused"
}

/**
 * The actor keeps only the last 200 events, so totals accumulate here by seq instead of being recounted
 * from the list. `live` is false for history, which must never replay a toast. Socket messages may arrive
 * out of order, hence the seq checks.
 */
function absorb(state: FeedState, incoming: FeedEvent[], live: boolean): FeedState {
    const fresh = incoming.filter(event => !state.seen.has(event.seq))
    if (fresh.length === 0) return state
    const next: FeedState = {
        ...state,
        seen: new Set(state.seen),
        tally: { ...state.tally },
        outcomes: { ...state.outcomes },
        lastDenial: { ...state.lastDenial },
        toasts: [...state.toasts]
    }
    for (const event of fresh) {
        next.seen.add(event.seq)
        const agent = event.agent
        if (!isAgent(agent)) continue
        if (event.kind === "repay") next.tally.repaid += 1
        if (event.kind === "late") next.tally.late += 1
        if (event.kind === "default") next.tally.defaulted += 1
        if (["default", "loan", "repay"].includes(event.kind) && event.seq > (next.outcomes[agent]?.seq ?? 0)) {
            next.outcomes[agent] = { seq: event.seq, defaulted: event.kind === "default" }
        }
        if (live && event.kind === "denied") {
            next.lastDenial[agent] = event.seq
            next.toasts = [...next.toasts, { seq: event.seq, agent, reason: denialReason(event.text) }].slice(-MAX_TOASTS)
        }
    }
    next.events = [...state.events, ...fresh].sort((a, b) => b.seq - a.seq).slice(0, FEED_LIMIT)
    return next
}

function reduce(state: FeedState, action: Action): FeedState {
    if (action.type === "absorb") return absorb(state, action.events, action.live)
    return { ...state, toasts: state.toasts.filter(toast => toast.seq !== action.seq) }
}

export function useBureauFeed() {
    const [state, dispatch] = useReducer(reduce, initial)
    const connected = useActorSocket<FeedMessage>("Feed", "main", message => {
        if (message.type === "history") dispatch({ type: "absorb", events: message.events, live: false })
        else if (message.type === "event") dispatch({ type: "absorb", events: [message.event], live: true })
    })
    return { ...state, connected, dismiss: (seq: number) => dispatch({ type: "dismiss", seq }) }
}
