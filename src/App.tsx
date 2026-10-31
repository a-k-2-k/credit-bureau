import { type FormEvent, useCallback, useEffect, useRef, useState } from "react"
import { createRoot } from "react-dom/client"

import type { AccountState, FeedEvent, JobResult, OpenLoan } from "./actors"
import "./App.css"
import { AGENTS, type AgentName, creditLimit, MIN_SCORE_TO_BORROW, SCORE_MAX, SCORE_MIN } from "./roster"
import { useActorSocket } from "./useActorSocket"
import { type Denial, type FeedState, useBureauFeed } from "./useBureauFeed"

type AccountMessage = Omit<AccountState, "id"> & { type: "change"; reason: string }

const SPARK_POINTS = 120
const TOAST_MS = 5_000
const credits = new Intl.NumberFormat("en-US")
const openDebt = (loans: OpenLoan[]) => loans.reduce((debt, loan) => debt + loan.principal, 0)

function ScoreGauge({ score }: { score: number }) {
    const fraction = (value: number) => (value - SCORE_MIN) / (SCORE_MAX - SCORE_MIN)
    const canBorrow = score >= MIN_SCORE_TO_BORROW
    // Half circle of radius 50: pathLength lets the dash pattern work in score fractions.
    const arc = "M 10 60 A 50 50 0 0 1 110 60"
    const floor = Math.PI * (1 - fraction(MIN_SCORE_TO_BORROW))
    const tick = (radius: number) => `${60 + radius * Math.cos(floor)} ${60 - radius * Math.sin(floor)}`
    return (
        <div className="gauge" role="img" aria-label={`Credit score ${score} of ${SCORE_MAX}`}>
            <svg viewBox="0 0 120 68" aria-hidden="true">
                <path d={arc} className="gauge-track" pathLength={1} />
                <path
                    d={arc}
                    className={`gauge-value ${canBorrow ? "good" : "bad"}`}
                    pathLength={1}
                    strokeDasharray={`${Math.max(0.001, fraction(score))} 1`}
                />
                <path d={`M ${tick(42)} L ${tick(58)}`} className="gauge-floor" />
            </svg>
            <strong>{score}</strong>
            <span className={canBorrow ? "standing good" : "standing bad"}>{canBorrow ? "✓ Can borrow" : "✕ Cut off"}</span>
        </div>
    )
}

function Countdown({ dueAt, graceUntil }: Pick<OpenLoan, "dueAt" | "graceUntil">) {
    const [now, setNow] = useState(Date.now)
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 1_000)
        return () => clearInterval(timer)
    }, [])
    const seconds = Math.max(0, Math.ceil(((graceUntil ?? dueAt) - now) / 1_000))
    if (graceUntil !== null) return <span className="bad">⚠ Late, {seconds}s to default</span>
    return <span className={seconds <= 15 ? "overdue" : undefined}>{seconds}s left</span>
}

function OpenLoans({ loans }: { loans: OpenLoan[] }) {
    if (loans.length === 0) return <p className="muted">No open loans</p>
    return (
        <ul className="loans">
            {loans.map(loan => (
                <li key={loan.loanId}>
                    <span>{credits.format(loan.principal)} cr</span>
                    <Countdown dueAt={loan.dueAt} graceUntil={loan.graceUntil} />
                </li>
            ))}
        </ul>
    )
}

type ScorePoint = { score: number; reason: string; at: number }

function Sparkline({ points }: { points: ScorePoint[] }) {
    const [width, height, inset] = [200, 34, 4]
    const scores = points.map(point => point.score)
    const range = Math.max(...scores) - Math.min(...scores)
    // A minimum span keeps a 10-point move from filling the whole plot.
    const span = Math.max(range, 40)
    const low = Math.min(...scores) - (span - range) / 2
    // One reading still draws as a flat line across the plot.
    const drawn = scores.length === 1 ? [scores[0], scores[0]] : scores
    const x = (index: number) => inset + (index * (width - inset * 2)) / (drawn.length - 1)
    const y = (score: number) => height - inset - ((score - low) * (height - inset * 2)) / span
    const last = drawn.length - 1
    return (
        <figure className="spark">
            <figcaption>
                <span>Score since load</span>
                <span>{scores.length === 1 ? "no change" : `${scores[0]} → ${scores.at(-1)}`}</span>
            </figcaption>
            <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Score history: ${scores.join(", ")}`}>
                {low < MIN_SCORE_TO_BORROW && low + span > MIN_SCORE_TO_BORROW && (
                    <line x1={0} x2={width} y1={y(MIN_SCORE_TO_BORROW)} y2={y(MIN_SCORE_TO_BORROW)} className="spark-floor" />
                )}
                <polyline points={drawn.map((score, index) => `${x(index)},${y(score)}`).join(" ")} className="spark-line" />
                <circle cx={x(last)} cy={y(drawn[last])} r={3.5} className="spark-end" />
                {points.map((point, index) => (
                    <rect key={point.at} x={(index * width) / points.length} y={0} width={width / points.length} height={height} className="spark-hit">
                        <title>{`${point.score}: ${point.reason} (${new Date(point.at).toLocaleTimeString()})`}</title>
                    </rect>
                ))}
            </svg>
        </figure>
    )
}

type CardProps = { agent: AgentName; ghost: boolean; denialSeq?: number; onDebt: (agent: AgentName, debt: number) => void }

function AgentCard({ agent, ghost, denialSeq, onDebt }: CardProps) {
    const [account, setAccount] = useState<AccountMessage>()
    const [history, setHistory] = useState<ScorePoint[]>([])
    const card = useRef<HTMLElement>(null)
    const connected = useActorSocket<AccountMessage>("AgentAccount", agent, message => {
        if (message.type !== "change") return
        setAccount(message)
        onDebt(agent, openDebt(message.openLoans))
        setHistory(points =>
            points.at(-1)?.score === message.score
                ? points
                : [...points, { score: message.score, reason: message.reason, at: Date.now() }].slice(-SPARK_POINTS)
        )
    })

    useEffect(() => {
        if (denialSeq === undefined) return
        const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches
        const shift = still ? [0] : [0, -10, 10, -8, 8, -5, 5, 0]
        card.current?.animate(
            shift.map((px, index) => ({
                transform: `translateX(${px}px)`,
                ...(index === 0 ? { backgroundColor: "#7a1712", borderColor: "#ff6b5e", boxShadow: "0 0 36px #ff3b2f" } : {})
            })),
            { duration: still ? 1_200 : 900, easing: "ease-out" }
        )
    }, [denialSeq])

    // The bureau caps total open debt, not each loan.
    const limit = account ? creditLimit(account.score) : 0
    const available = Math.max(0, limit - openDebt(account?.openLoans ?? []))
    const late = account?.openLoans.some(loan => loan.graceUntil !== null) ?? false
    return (
        <article ref={card} className="card" aria-label={agent}>
            <header>
                <h2>{agent}</h2>
                <span className="badges">
                    {ghost && <span className="badge ghost-badge">👻 Defaulted</span>}
                    {late && <span className="badge late-badge">⚠ Late</span>}
                    <span className={connected ? "dot live" : "dot"} title={connected ? "Live" : "Reconnecting"} />
                </span>
            </header>
            {account ? (
                <div className={ghost ? "card-body ghostly" : "card-body"}>
                    <ScoreGauge score={account.score} />
                    <Sparkline points={history} />
                    <dl>
                        <div>
                            <dt>Balance</dt>
                            <dd>{credits.format(account.balance)}</dd>
                        </div>
                        <div>
                            <dt>Can borrow</dt>
                            <dd>
                                {credits.format(available)}
                                <small> / {credits.format(limit)}</small>
                            </dd>
                        </div>
                    </dl>
                    <h3>Open loans</h3>
                    <OpenLoans loans={account.openLoans} />
                    <p className="reason">{account.reason === "connected" ? "\u00a0" : account.reason}</p>
                </div>
            ) : (
                <p className="muted">Connecting…</p>
            )}
        </article>
    )
}

function Toast({ toast, onDone }: { toast: Denial; onDone: (seq: number) => void }) {
    useEffect(() => {
        const timer = setTimeout(() => onDone(toast.seq), TOAST_MS)
        return () => clearTimeout(timer)
    }, [toast.seq])
    return (
        <p role="alert" className="toast">
            ✕ LOAN DENIED: {toast.agent} ({toast.reason})
        </p>
    )
}

function Totals({ outstanding, tally }: { outstanding: number; tally: FeedState["tally"] }) {
    const tiles = [
        { label: "Credit outstanding", value: outstanding },
        { label: "✓ Loans repaid", value: tally.repaid },
        { label: "⚠ Loans late", value: tally.late },
        { label: "👻 Loans defaulted", value: tally.defaulted }
    ]
    return (
        <dl className="totals" aria-label="Bureau totals">
            {tiles.map(tile => (
                <div key={tile.label}>
                    <dt>{tile.label}</dt>
                    <dd>{credits.format(tile.value)}</dd>
                </div>
            ))}
        </dl>
    )
}

/** Actor events carry no channel: job events belong to #jobs and everything else to #bureau. Relay without one is a DM. */
function channelOf(event: FeedEvent): { id: string; label: string } {
    if (event.channel) return { id: event.channel, label: `#${event.channel}` }
    if (event.kind === "relay") return { id: "dm", label: "DM" }
    return event.kind === "job" ? { id: "jobs", label: "#jobs" } : { id: "bureau", label: "#bureau" }
}

function LiveFeed({ events, connected }: { events: FeedEvent[]; connected: boolean }) {
    return (
        <section className="panel feed" aria-label="Live feed">
            <header>
                <h2>Live feed</h2>
                <span className={connected ? "dot live" : "dot"} title={connected ? "Live" : "Reconnecting"} />
            </header>
            {events.length === 0 && <p className="muted">Nothing has happened yet.</p>}
            <ol role="log">
                {events.map(event => {
                    const channel = channelOf(event)
                    const speaker = event.agent ?? "bureau"
                    const text = event.text.startsWith(`${speaker}: `) ? event.text.slice(speaker.length + 2) : event.text
                    return (
                        <li key={event.seq} className={`kind-${event.kind} channel-${channel.id}`}>
                            <time dateTime={new Date(event.at).toISOString()}>{new Date(event.at).toLocaleTimeString()}</time>
                            <strong className="speaker">{speaker}</strong>
                            <span className="channel">{channel.label}</span>
                            <span className="text">{text}</span>
                        </li>
                    )
                })}
            </ol>
        </section>
    )
}

function PostJob() {
    const [pending, setPending] = useState(false)
    const [outcome, setOutcome] = useState<{ ok: boolean; text: string }>()

    async function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault()
        const form = event.currentTarget
        const fields = new FormData(form)
        setPending(true)
        setOutcome(undefined)
        try {
            const response = await fetch("/api/jobs", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    title: fields.get("title"),
                    description: fields.get("description"),
                    budget: fields.get("budget")
                })
            })
            const result: JobResult = await response.json()
            if (result.ok) {
                form.reset()
                setOutcome({ ok: true, text: `Posted ${result.job.jobId}` })
            } else {
                setOutcome({ ok: false, text: result.reason })
            }
        } catch {
            setOutcome({ ok: false, text: "Could not reach the job board" })
        } finally {
            setPending(false)
        }
    }

    return (
        <section className="panel" aria-label="Post a job">
            <header>
                <h2>Post a job</h2>
            </header>
            <form onSubmit={submit}>
                <label>
                    Title
                    <input name="title" required maxLength={120} placeholder="Summon a landing page" />
                </label>
                <label>
                    Description
                    <textarea name="description" rows={4} maxLength={1000} placeholder="What should the agents deliver?" />
                </label>
                <label>
                    Budget (credits)
                    <input name="budget" type="number" required min={1} step={1} defaultValue={100} />
                </label>
                <button disabled={pending}>{pending ? "Posting…" : "Post job"}</button>
                {outcome && (
                    <p role="status" className={outcome.ok ? "outcome good" : "outcome bad"}>
                        {outcome.ok ? "✓" : "✕"} {outcome.text}
                    </p>
                )}
            </form>
        </section>
    )
}

function App() {
    const feed = useBureauFeed()
    const [debts, setDebts] = useState<Partial<Record<AgentName, number>>>({})
    const onDebt = useCallback((agent: AgentName, debt: number) => setDebts(current => ({ ...current, [agent]: debt })), [])
    const outstanding = Object.values(debts).reduce((total, debt) => total + debt, 0)
    return (
        <main>
            <header className="masthead">
                <div>
                    <h1>
                        <span aria-hidden="true">🎃</span> Agent Credit Bureau
                    </h1>
                    <p>Five agents. One ledger. Nobody escapes their score.</p>
                </div>
                <Totals outstanding={outstanding} tally={feed.tally} />
            </header>
            <div className="toasts">
                {feed.toasts.map(toast => (
                    <Toast key={toast.seq} toast={toast} onDone={feed.dismiss} />
                ))}
            </div>
            <div className="cards">
                {AGENTS.map(agent => (
                    <AgentCard
                        key={agent}
                        agent={agent}
                        ghost={feed.outcomes[agent]?.defaulted ?? false}
                        denialSeq={feed.lastDenial[agent]}
                        onDebt={onDebt}
                    />
                ))}
            </div>
            <div className="lower">
                <LiveFeed events={feed.events} connected={feed.connected} />
                <PostJob />
            </div>
        </main>
    )
}

createRoot(document.getElementById("root")!).render(<App />)
