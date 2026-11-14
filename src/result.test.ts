import { describe, expect, test } from "bun:test"
import { buildResult, formatTrailer, RESULT_TRAILER, withTrailer } from "./result"
import { question, request } from "./test-harness"
import type { Decision } from "./types"

const now = new Date("2026-11-14T12:00:00.000Z")
const one = request([question("Which database?")])
const two = request([question("Which database?"), question("Which cache?", "Cache")])
const decision = (over: Partial<Decision> = {}): Decision => ({
  ok: true,
  answers: [["sqlite"]],
  confidences: [0.82],
  engine: "llm",
  model: "qwen/qwen3",
  rationale: "Single-user tool.",
  ...over,
})

describe("buildResult", () => {
  test("answered: answer, confidence, pass number and engine details", () => {
    const r = buildResult(one, { kind: "answered", decision: decision(), pass: "pass 2" }, "hud-supervisor", "human", now)
    expect(r).toEqual({
      v: 1,
      time: "2026-11-14T12:00:00.000Z",
      requestID: "que_1",
      sessionID: "ses_1",
      agent: "hud-supervisor",
      source: "question",
      outcome: "answered",
      action: "replied",
      answer: "sqlite",
      answers: [["sqlite"]],
      confidence: 0.82,
      confidences: [0.82],
      threshold: null,
      pass: 2,
      passDetail: "pass 2",
      engine: "llm",
      model: "qwen/qwen3",
      rationale: "Single-user tool.",
      reason: null,
    })
  })

  test("answered with several questions: answer is null, answers holds each, confidence is the minimum", () => {
    const d = decision({ answers: [["sqlite"], ["redis", "memory"]], confidences: [0.9, 0.7] })
    const r = buildResult(two, { kind: "answered", decision: d, pass: "pass 1" }, "autonomy", "human", now)
    expect(r.answer).toBeNull()
    expect(r.answers).toEqual([["sqlite"], ["redis", "memory"]])
    expect(r.confidence).toBe(0.7)
    expect(r.pass).toBe(1)
  })

  test("deferred: answer null, the falling-short confidence, threshold and reason", () => {
    const outcome = { kind: "deferred" as const, decision: decision({ confidences: [0.31] }), reason: "low confidence", threshold: 0.35, pass: "pass 2" }
    const human = buildResult(one, outcome, "autonomy", "human", now)
    expect(human).toMatchObject({ outcome: "deferred", action: "left_for_human", answer: null, answers: null, confidence: 0.31, threshold: 0.35, pass: 2, reason: "low confidence" })
    expect(buildResult(one, outcome, "autonomy", "reject", now).action).toBe("marker")
  })

  test("deferred after a failed decision: engine and error, no confidence", () => {
    const failed: Decision = { ok: false, answers: [], confidences: [], engine: "llm", error: "LLM API 503" }
    const r = buildResult(one, { kind: "deferred", decision: failed, reason: "LLM API 503", threshold: 0.6, pass: "pass 1 (no gathered context)" }, undefined, "human", now)
    expect(r).toMatchObject({ agent: null, engine: "llm", confidence: null, pass: 1, passDetail: "pass 1 (no gathered context)", reason: "LLM API 503" })
  })

  test("timeout and gated", () => {
    expect(buildResult(one, { kind: "timeout", timeoutMs: 120_000 }, "autonomy", "reject", now)).toMatchObject({
      outcome: "timeout",
      action: "marker",
      reason: "handler timed out after 120s",
    })
    expect(buildResult(one, { kind: "gated", reason: "question carries the HUMAN_GATE: marker" }, "autonomy", "reject", now)).toMatchObject({
      outcome: "gated",
      action: "rejected",
      answer: null,
    })
    expect(buildResult(one, { kind: "gated", reason: "x" }, "autonomy", "human", now).action).toBe("left_for_human")
  })
})

describe("formatTrailer", () => {
  test("is the prefix and compact JSON, without ids or time", () => {
    const r = buildResult(one, { kind: "answered", decision: decision(), pass: "pass 2" }, "autonomy", "human", now)
    const trailer = formatTrailer(r)
    expect(trailer.startsWith(`${RESULT_TRAILER} {`)).toBe(true)
    expect(JSON.parse(trailer.slice(RESULT_TRAILER.length + 1))).toEqual({
      outcome: "answered",
      answer: "sqlite",
      confidence: 0.82,
      pass: 2,
      engine: "llm",
      model: "qwen/qwen3",
      rationale: "Single-user tool.",
    })
  })

  test("adds answers for several questions and the reason when not answered", () => {
    const d = decision({ answers: [["sqlite"], ["redis"]], confidences: [0.9, 0.8] })
    const multi = JSON.parse(formatTrailer(buildResult(two, { kind: "answered", decision: d, pass: "pass 1" }, "a", "human", now)).slice(RESULT_TRAILER.length + 1))
    expect(multi.answers).toEqual([["sqlite"], ["redis"]])
    const timeout = JSON.parse(formatTrailer(buildResult(one, { kind: "timeout", timeoutMs: 20 }, "a", "reject", now)).slice(RESULT_TRAILER.length + 1))
    expect(timeout).toMatchObject({ outcome: "timeout", answer: null, reason: "handler timed out after 0s" })
  })
})

describe("withTrailer", () => {
  test("appends to the last question's answer without changing the input", () => {
    const answers = [["a"], ["b"]]
    expect(withTrailer(answers, "T")).toEqual([["a"], ["b", "T"]])
    expect(answers).toEqual([["a"], ["b"]])
    expect(withTrailer([], "T")).toEqual([])
  })
})
