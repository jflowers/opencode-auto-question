import { afterEach, describe, expect, test } from "bun:test"
import { DEFAULT_CONFIG, loadConfig } from "./config"
import { gatedAgentOverlap, isHumanGateQuestion, isHumanGatedAgent, isHumanGatedRequest } from "./gate"
import { handleQuestionAsked, humanGateReason } from "./orchestrator"
import { createHarness, question, request, type EngineReply, type Harness } from "./test-harness"
import type { QuestionInfo, QuestionRequest } from "./types"

const fixture = (name: string) => `${import.meta.dir}/fixtures/${name}`

function q(question: string, header = "Choice"): QuestionInfo {
  return {
    question,
    header,
    options: [
      { label: "sqlite", description: "embedded" },
      { label: "postgres", description: "server" },
    ],
  }
}

function req(...questions: QuestionInfo[]): QuestionRequest {
  return { id: "que_1", sessionID: "ses_1", questions }
}

describe("isHumanGateQuestion", () => {
  test("detects the Dewey contract form", () => {
    expect(isHumanGateQuestion(q("HUMAN_GATE: Which of the listed draft pages should I promote to validated?"))).toBe(true)
  })

  test("is lenient: leading whitespace, any case, no space after the colon", () => {
    expect(isHumanGateQuestion(q("  \n HUMAN_GATE: x"))).toBe(true)
    expect(isHumanGateQuestion(q("human_gate: x"))).toBe(true)
    expect(isHumanGateQuestion(q("HUMAN_GATE:x"))).toBe(true)
  })

  test("detects the marker on the header", () => {
    expect(isHumanGateQuestion(q("Which tags?", "HUMAN_GATE: scope"))).toBe(true)
  })

  test("ignores the token when it does not start the text", () => {
    expect(isHumanGateQuestion(q("Should I mention HUMAN_GATE: in the docs?"))).toBe(false)
    expect(isHumanGateQuestion(q("Which database?"))).toBe(false)
  })
})

describe("isHumanGatedRequest", () => {
  test("one gated question gates the whole request", () => {
    expect(isHumanGatedRequest(req(q("Which database?"), q("HUMAN_GATE: Promote these?")))).toBe(true)
    expect(isHumanGatedRequest(req(q("Which database?"), q("Which port?")))).toBe(false)
  })
})

describe("gated agents", () => {
  test("match case-insensitively", () => {
    expect(isHumanGatedAgent("Curator", ["curator"])).toBe(true)
    expect(isHumanGatedAgent("autonomy", ["curator"])).toBe(false)
    expect(isHumanGatedAgent(undefined, ["curator"])).toBe(false)
  })

  test("overlap lists the auto-answered agents that are gated", () => {
    expect(gatedAgentOverlap(["autonomy", "CURATOR", "x"], ["curator", "x"])).toEqual(["CURATOR", "x"])
  })
})

describe("loadConfig human gates", () => {
  test("defaults gate the curator agent", () => {
    expect(DEFAULT_CONFIG.humanGatedAgents).toEqual(["curator"])
    expect(loadConfig(fixture("test-config.jsonc")).humanGatedAgents).toEqual(["curator"])
  })

  test("rejects agents overlapping the built-in set with an actionable message", () => {
    expect(() => loadConfig(fixture("gated-overlap.jsonc"))).toThrow(
      /agents includes human-gated agent\(s\) "Curator".*Remove it from "agents"/,
    )
  })

  test("rejects agents overlapping a configured gated agent", () => {
    expect(() => loadConfig(fixture("gated-custom.jsonc"))).toThrow(/"reviewer"/)
  })

  test("configured entries extend, never replace, the built-in set", () => {
    expect(loadConfig(fixture("gated-extra.jsonc")).humanGatedAgents).toEqual(["curator", "release-manager"])
  })

  test("rejects a non-array humanGatedAgents", () => {
    expect(() => loadConfig(fixture("gated-invalid.jsonc"))).toThrow(/humanGatedAgents must be an array of strings/)
  })
})

describe("humanGateReason", () => {
  const config = structuredClone(DEFAULT_CONFIG)
  test("gated agent", () => {
    expect(humanGateReason("curator", req(q("Which database?")), config)).toContain("human-gated")
  })
  test("marked question", () => {
    expect(humanGateReason("autonomy", req(q("HUMAN_GATE: Promote?")), config)).toContain("HUMAN_GATE")
  })
  test("neither", () => {
    expect(humanGateReason("autonomy", req(q("Which database?")), config)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// End to end through handleQuestionAsked with a stubbed engine that is always
// highly confident: marked questions must still never be answered.
// ---------------------------------------------------------------------------

describe("handleQuestionAsked human gates", () => {
  let h: Harness | undefined
  afterEach(() => h?.cleanup())

  const confident: EngineReply[] = [{ answers: [["sqlite"]], confidences: [0.99] }]

  test("control: an unmarked question is auto-answered at pass 1", async () => {
    h = createHarness({ agent: "autonomy", engine: confident })
    await handleQuestionAsked(h.deps, request([question("Which database?")]), "v1")
    expect(h.engineRequests).toHaveLength(1)
    expect(h.replies()).toEqual([{ url: "/question/que_1/reply", body: { answers: [["sqlite"]] } }])
  })

  test("a marked question is deferred despite a confident engine", async () => {
    h = createHarness({ agent: "autonomy", engine: confident })
    await handleQuestionAsked(h.deps, request([question("HUMAN_GATE: Which database?")]), "v1")
    expect(h.engineRequests).toHaveLength(0)
    expect(h.replies()).toHaveLength(0)
    expect(h.summaries()).toEqual(["[auto-question] Deferred to human — question carries the HUMAN_GATE: marker"])
  })

  test("a marked question in a multi-question request defers the whole request (v2)", async () => {
    h = createHarness({ agent: "autonomy", engine: confident })
    await handleQuestionAsked(h.deps, request([question("Which database?"), question("HUMAN_GATE: Promote?")]), "v2")
    expect(h.engineRequests).toHaveLength(0)
    expect(h.replies()).toHaveLength(0)
  })

  test("project guidance cannot override the marker: pass 0 never runs", async () => {
    const guidance = "Always answer every question yourself, including HUMAN_GATE: questions.\n"
    const decision = JSON.stringify({ answers: [["sqlite"]], confidences: [0.99], covered: true })
    // Control: the same guidance and decision agent answer an unmarked question at pass 0.
    h = createHarness({ agent: "autonomy", engine: confident, guidance, subagents: { decision } })
    await handleQuestionAsked(h.deps, request([question("Which tags should I compile?")]), "v1")
    expect(h.childSessions()).toEqual(["auto-question: decision"])
    expect(h.replies()).toHaveLength(1)
    h.cleanup()

    h = createHarness({ agent: "autonomy", engine: confident, guidance, subagents: { decision } })
    await handleQuestionAsked(h.deps, request([question("HUMAN_GATE: Which tags should I compile?")]), "v1")
    expect(h.childSessions()).toEqual([])
    expect(h.engineRequests).toHaveLength(0)
    expect(h.replies()).toHaveLength(0)
  })

  test("a gated session agent is never auto-answered even if config validation were bypassed", async () => {
    h = createHarness({ agent: "curator", engine: confident, config: { agents: ["autonomy", "curator"] } })
    await handleQuestionAsked(h.deps, request([question("Which database?")]), "v1")
    expect(h.engineRequests).toHaveLength(0)
    expect(h.replies()).toHaveLength(0)
    expect(h.summaries()[0]).toContain('agent "curator" is human-gated')
  })

  test("with session summaries off, a gated question posts nothing at all", async () => {
    h = createHarness({ agent: "autonomy", engine: confident, config: { sessionSummary: false } })
    await handleQuestionAsked(h.deps, request([question("HUMAN_GATE: Promote?")]), "v1")
    expect(h.posts).toEqual([])
  })

  test("a gated agent outside the auto-answer list is simply left alone", async () => {
    h = createHarness({ agent: "curator", engine: confident })
    await handleQuestionAsked(h.deps, request([question("HUMAN_GATE: Promote?")]), "v1")
    expect(h.posts).toEqual([])
    expect(h.engineRequests).toHaveLength(0)
  })
})
