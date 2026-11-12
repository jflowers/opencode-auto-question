import type { QuestionInfo, QuestionRequest } from "./types"

/**
 * Human gates (issue #1): questions that must never be auto-answered.
 *
 * Marker contract (unbound-force/dewey, curator-agent-human-gates design D7):
 * a gate question begins with the exact token `HUMAN_GATE:` at the start of
 * its first line, e.g. `HUMAN_GATE: Which tags should I compile?`.
 *
 * Detection here is deliberately more lenient than the contract — leading
 * whitespace, any letter case, and the marker on the header as well as the
 * question all count. A false positive (or a spoofed marker) can only force a
 * human answer, so over-matching is fail-safe; under-matching is not.
 */
export const HUMAN_GATE_MARKER = "HUMAN_GATE:"

/** Agents that are always human-gated, whatever the config says. */
export const BUILTIN_HUMAN_GATED_AGENTS: readonly string[] = ["curator"]

const MARKER_RE = /^\s*HUMAN_GATE:/i

/** True when a single question carries the human-gate marker. */
export function isHumanGateQuestion(q: Pick<QuestionInfo, "question" | "header">): boolean {
  return MARKER_RE.test(q.question ?? "") || MARKER_RE.test(q.header ?? "")
}

/**
 * True when any question in the request is human-gated. A request is
 * answered as a whole, so one gated question defers the entire request.
 */
export function isHumanGatedRequest(request: Pick<QuestionRequest, "questions">): boolean {
  return request.questions.some(isHumanGateQuestion)
}

/** Case-insensitive name comparison, matching isAutonomousAgent. */
function sameAgent(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/** True when agent is in the human-gated set. */
export function isHumanGatedAgent(agent: string | undefined, gated: readonly string[]): boolean {
  if (!agent) return false
  return gated.some((g) => sameAgent(g, agent))
}

/** Auto-answered agents that are also human-gated (in `agents` order). */
export function gatedAgentOverlap(agents: readonly string[], gated: readonly string[]): string[] {
  return agents.filter((a) => isHumanGatedAgent(a, gated))
}
