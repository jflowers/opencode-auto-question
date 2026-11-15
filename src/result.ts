import type { Config, Decision, QuestionRequest } from "./types"

/**
 * Structured result of one question request (issue #10). Written to
 * results.jsonl for every outcome and, with `resultTrailer`, appended to the
 * answer the asking agent receives.
 */
export interface ResultRecord {
  /** Record format version. */
  v: 1
  time: string
  requestID: string
  sessionID: string
  agent: string | null
  /**
   * What asked: an intercepted `question` call, a `second_opinion` tool
   * call, or (headless mode) the plugin's own `question` tool.
   */
  source: "question" | "second_opinion" | "headless"
  /** "partial" (headless only): some questions answered, the rest marked. */
  outcome: "answered" | "partial" | "deferred" | "gated" | "timeout"
  /**
   * What the plugin did: replied with the decision, replied with a
   * NO_SECOND_OPINION marker, rejected a human gate, left it pending, or
   * (second_opinion) returned the record as the tool's output.
   */
  action: "replied" | "marker" | "rejected" | "left_for_human" | "returned"
  /** The answer when there is one question: its labels joined with ", ". Null unless answered. */
  answer: string | null
  /** One array of labels per question. Null unless answered. */
  answers: string[][] | null
  /** Lowest per-question confidence of the deciding (or falling-short) decision. */
  confidence: number | null
  confidences: number[] | null
  /** The confidence a deferred decision had to reach. */
  threshold: number | null
  /** 0, 1 or 2: the pass whose decision counted. */
  pass: number | null
  /** The pass as the log names it, e.g. "pass 1 (no gathered context)". */
  passDetail: string | null
  engine: string | null
  model: string | null
  rationale: string | null
  /** Why it was not answered. Null when answered. */
  reason: string | null
  /** Headless only: how each question ended, in the form's order. */
  questions?: QuestionResult[]
}

/** How one question of a headless form ended. */
export interface QuestionResult {
  outcome: "answered" | "deferred" | "gated" | "timeout"
  /** The selected labels (or custom answer), or null when not answered. */
  answer: string[] | null
  /** What the asking agent received for this question: the answer, or a marker. */
  reply: string[]
  confidence: number | null
  /** The confidence the decision had to reach, when one was made. */
  threshold: number | null
  /** The pass as the log names it, e.g. "pass 2". */
  pass: string | null
  engine: string | null
  model: string | null
  /** Why it was not answered. Null when answered. */
  reason: string | null
}

/** Prefix of the trailer appended to the answer under `resultTrailer`. */
export const RESULT_TRAILER = "AUTO_QUESTION_RESULT"

type SettledOutcome =
  | { kind: "answered"; decision: Decision; pass: string }
  | { kind: "deferred"; decision: Decision | null; reason: string; threshold: number; pass: string }
  | { kind: "gated"; reason: string }
  | { kind: "timeout"; timeoutMs: number }

function passNumber(pass: string): number | null {
  const m = /^pass (\d)/.exec(pass)
  return m ? Number(m[1]) : null
}

function minConfidence(decision: Decision): number | null {
  return decision.confidences.length === 0 ? null : Math.min(...decision.confidences)
}

/** Build the record for how a request ended. */
export function buildResult(
  request: QuestionRequest,
  outcome: SettledOutcome,
  agent: string | undefined,
  onDefer: Config["onDefer"],
  now: Date = new Date(),
): ResultRecord {
  const record: ResultRecord = {
    v: 1,
    time: now.toISOString(),
    requestID: request.id,
    sessionID: request.sessionID,
    agent: agent ?? null,
    source: "question",
    outcome: outcome.kind,
    action: "left_for_human",
    answer: null,
    answers: null,
    confidence: null,
    confidences: null,
    threshold: null,
    pass: null,
    passDetail: null,
    engine: null,
    model: null,
    rationale: null,
    reason: null,
  }

  const fromDecision = (decision: Decision | null) => {
    if (!decision) return
    record.engine = decision.engine
    record.model = decision.model ?? null
    if (!decision.ok) return
    record.confidence = minConfidence(decision)
    record.confidences = [...decision.confidences]
    record.rationale = decision.rationale ?? null
  }

  switch (outcome.kind) {
    case "answered":
      record.action = "replied"
      record.answers = outcome.decision.answers.map((a) => [...a])
      if (request.questions.length === 1) record.answer = (outcome.decision.answers[0] ?? []).join(", ")
      record.pass = passNumber(outcome.pass)
      record.passDetail = outcome.pass
      fromDecision(outcome.decision)
      break
    case "deferred":
      record.action = onDefer === "reject" ? "marker" : "left_for_human"
      record.threshold = outcome.threshold
      record.pass = passNumber(outcome.pass)
      record.passDetail = outcome.pass
      record.reason = outcome.reason
      fromDecision(outcome.decision)
      break
    case "timeout":
      record.action = onDefer === "reject" ? "marker" : "left_for_human"
      record.reason = `handler timed out after ${Math.round(outcome.timeoutMs / 1000)}s`
      break
    case "gated":
      record.action = onDefer === "reject" ? "rejected" : "left_for_human"
      record.reason = outcome.reason
      break
  }
  return record
}

/**
 * The trailer the asking agent receives: the record without the fields it
 * already knows (ids, agent, time) or that only the log needs.
 */
export function formatTrailer(record: ResultRecord): string {
  return `${RESULT_TRAILER} ${JSON.stringify(compactResult(record))}`
}

/** The record without ids, time and log-only fields: the trailer body and the second_opinion output. */
export function compactResult(record: ResultRecord): Record<string, unknown> {
  const compact: Record<string, unknown> = {
    outcome: record.outcome,
    answer: record.answer,
    confidence: record.confidence,
    pass: record.pass,
    engine: record.engine,
    model: record.model,
    rationale: record.rationale,
  }
  if (record.answers && record.answers.length > 1) compact.answers = record.answers
  if (record.reason) compact.reason = record.reason
  if (record.questions) {
    compact.questions = record.questions.map((q) => ({
      outcome: q.outcome,
      answer: q.answer,
      confidence: q.confidence,
      ...(q.reason ? { reason: q.reason } : {}),
    }))
  }
  return compact
}

/** Append the trailer as one more element of the last question's answer. */
export function withTrailer(answers: string[][], trailer: string): string[][] {
  if (answers.length === 0) return answers
  const out = answers.map((a) => [...a])
  out[out.length - 1]!.push(trailer)
  return out
}
