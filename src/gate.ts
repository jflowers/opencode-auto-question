import type { QuestionInfo, QuestionRequest } from "./types"

/**
 * Human gates (issue #1): questions that must never be auto-answered.
 *
 * Marker contract (unbound-force/dewey, curator-agent-human-gates design D7):
 * a gate question begins with the exact token `HUMAN_GATE:` at the start of
 * its first line, e.g. `HUMAN_GATE: Which tags should I compile?`.
 *
 * The question text is written by a model, which may decorate the line, so
 * detection is deliberately more lenient than the contract. All of these count:
 * - leading whitespace and markdown decoration (`**`, `_`, `` ` ``, `>`, `#`,
 *   `-`, `+`, `~`, numbered-list markers like `1.` or `2)`, zero-width chars)
 * - any letter case
 * - `HUMAN_GATE`, `HUMAN-GATE`, `HUMAN GATE` or `HUMANGATE`, with emphasis
 *   or spaces before the colon (`**HUMAN_GATE**:`)
 * - the marker on the header as well as on the question
 *
 * The marker must still lead the text: a question that merely mentions it
 * mid-sentence is not gated.
 *
 * Over-matching never auto-answers a gate, so it is the safe direction for
 * the gate itself. It is not free: in an unattended run (gh-hud dispatching
 * an autonomy TUI session, no human watching) a deferred question blocks the
 * pane until someone answers it. Any question the session's model writes with
 * the marker, deliberately or by copying text that quotes it, stalls the run.
 */
export const HUMAN_GATE_MARKER = "HUMAN_GATE:"

/** Agents that are always human-gated, whatever the config says. */
export const BUILTIN_HUMAN_GATED_AGENTS: readonly string[] = ["curator"]

/**
 * Optional leading decoration, then the marker. Each decoration step consumes
 * at least one character and digits only match as a list marker, so the
 * repetition cannot backtrack catastrophically.
 */
const MARKER_RE = /^(?:[\s>#*_`~+\-\u200B-\u200D\uFEFF]|\d{1,3}[.)])*HUMAN[\s_-]?GATE[\s*_`]*:/i

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

/**
 * The built-in gated agents followed by the configured ones, deduplicated
 * case-insensitively (first spelling wins), so configuration can extend the
 * set but never remove a built-in entry.
 */
export function mergeGatedAgents(builtin: readonly string[], configured: readonly string[]): string[] {
  const out: string[] = []
  for (const name of [...builtin, ...configured]) {
    if (!isHumanGatedAgent(name, out)) out.push(name)
  }
  return out
}
