// Browser-safe constants. The UI must not value-import actors.ts: that would pull the actor runtime into Vite.
export const AGENTS = ["atlas", "nova", "sloth", "hype", "grift"] as const
export type AgentName = (typeof AGENTS)[number]

export const SCORE_MIN = 300
export const SCORE_MAX = 850
export const MIN_SCORE_TO_BORROW = 550
export const creditLimit = (score: number) => (score < MIN_SCORE_TO_BORROW ? 0 : Math.max(0, (score - 500) * 2))
