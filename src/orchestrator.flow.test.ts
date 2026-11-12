import { afterEach, describe, expect, test } from "bun:test"
import { handleQuestionAsked } from "./orchestrator"
import { createHarness, question, request, type Harness } from "./test-harness"

/**
 * End-to-end decision flow through handleQuestionAsked: pass 0 (guidance
 * agent), pass 1, pass 2 (context gathering), thresholds, failures, and
 * timeouts. Defaults: confidenceThreshold 0.6, fallbackThreshold 0.35.
 */
describe("handleQuestionAsked decision flow", () => {
  let h: Harness | undefined
  afterEach(() => h?.cleanup())

  const q = () => request([question("Which database?")])
  const decide = (confidence: number) => ({ answers: [["sqlite"]], confidences: [confidence] })

  test("non-autonomous sessions are left to the human untouched", async () => {
    h = createHarness({ agent: "build", engine: [decide(0.99)] })
    await handleQuestionAsked(h.deps, q(), "v1")
    expect(h.posts).toEqual([])
    expect(h.engineRequests).toHaveLength(0)
  })

  test("an unknown session agent is not autonomous", async () => {
    h = createHarness({ engine: [decide(0.99)] })
    await handleQuestionAsked(h.deps, q(), "v1")
    expect(h.posts).toEqual([])
  })

  test("already-settled requests are skipped", async () => {
    h = createHarness({ agent: "autonomy", engine: [decide(0.99)] })
    h.deps.settled.add("que_1")
    await handleQuestionAsked(h.deps, q(), "v1")
    expect(h.posts).toEqual([])
  })

  test("pass 1 at or above confidenceThreshold replies and summarizes", async () => {
    h = createHarness({ agent: "autonomy", engine: [decide(0.6)] })
    await handleQuestionAsked(h.deps, q(), "v1")
    expect(h.replies()).toEqual([{ url: "/question/que_1/reply", body: { answers: [["sqlite"]] } }])
    expect(h.childSessions()).toEqual([])
    expect(h.summaries()[0]).toStartWith("[auto-question] Answered by llm (pass 1, min confidence 0.60)")
  })

  test("v2 replies go to the session-scoped endpoint", async () => {
    h = createHarness({ agent: "autonomy", engine: [decide(0.9)] })
    await handleQuestionAsked(h.deps, q(), "v2")
    expect(h.replies().map((r) => r.url)).toEqual(["/api/session/ses_1/question/que_1/reply"])
  })

  test("low pass 1 gathers context and replies from pass 2 above fallbackThreshold", async () => {
    h = createHarness({
      agent: "autonomy",
      engine: [decide(0.4), decide(0.5)],
      subagents: { context: "The team chose sqlite for local tools last month." },
    })
    await handleQuestionAsked(h.deps, q(), "v1")
    expect(h.childSessions()).toEqual(["auto-question: context gathering"])
    expect(h.engineRequests).toHaveLength(2)
    expect(JSON.stringify(h.engineRequests[1])).toContain("The team chose sqlite")
    expect(h.replies()).toHaveLength(1)
    expect(h.summaries()[0]).toContain("(pass 2, min confidence 0.50)")
  })

  test("below fallbackThreshold after pass 2 defers to the human", async () => {
    h = createHarness({ agent: "autonomy", engine: [decide(0.3), decide(0.2)], subagents: { context: "Nothing decisive." } })
    await handleQuestionAsked(h.deps, q(), "v1")
    expect(h.replies()).toHaveLength(0)
    expect(h.summaries()[0]).toStartWith(
      "[auto-question] Deferred to human — low confidence (llm confidence 0.20 below threshold 0.35)",
    )
  })

  test("no gathered context and no immediate context skips the second decision", async () => {
    h = createHarness({ agent: "autonomy", engine: [decide(0.5)], subagents: { context: "No relevant context found." } })
    await handleQuestionAsked(h.deps, q(), "v1")
    expect(h.engineRequests).toHaveLength(1)
    expect(h.replies()).toHaveLength(1)
    expect(h.summaries()[0]).toContain("(pass 1 (no gathered context)")
  })

  test("a failed pass 2 keeps the pass 1 decision for thresholding", async () => {
    h = createHarness({ agent: "autonomy", engine: [decide(0.5), { status: 500 }], subagents: { context: "Some facts." } })
    await handleQuestionAsked(h.deps, q(), "v1")
    expect(h.engineRequests).toHaveLength(2)
    expect(h.replies()).toHaveLength(1)
  })

  test("an engine error defers to the human with the error as the reason", async () => {
    h = createHarness({ agent: "autonomy", engine: [{ status: 503 }], subagents: { context: null } })
    await handleQuestionAsked(h.deps, q(), "v1")
    expect(h.replies()).toHaveLength(0)
    expect(h.summaries()[0]).toStartWith("[auto-question] Deferred to human — LLM API 503")
  })

  test("immediate context from the asking message reaches the engine", async () => {
    h = createHarness({
      agent: "autonomy",
      engine: [decide(0.9)],
      assistantText: "I recommend sqlite because the tool is single-user.",
      config: { immediateContext: true },
    })
    await handleQuestionAsked(h.deps, request([question("Which database?")], { messageID: "msg_a" }), "v1")
    expect(JSON.stringify(h.engineRequests[0])).toContain("I recommend sqlite because the tool is single-user.")
    expect(h.replies()).toHaveLength(1)
  })

  test("the handler timeout defers to the human", async () => {
    h = createHarness({ agent: "autonomy", engine: ["hang"], config: { handlerTimeoutMs: 20 } })
    await handleQuestionAsked(h.deps, q(), "v1")
    expect(h.replies()).toHaveLength(0)
    expect(h.summaries()).toEqual(["[auto-question] Deferred to human — handler timed out (0s)"])
  })

  test("sessionSummary false replies without injecting a summary", async () => {
    h = createHarness({ agent: "autonomy", engine: [decide(0.9)], config: { sessionSummary: false } })
    await handleQuestionAsked(h.deps, q(), "v1")
    expect(h.replies()).toHaveLength(1)
    expect(h.summaries()).toEqual([])
  })

  describe("pass 0 (project guidance)", () => {
    const guidance = "Prefer sqlite for single-user tools.\n"
    const agentDecision = (confidence: number, covered: boolean) =>
      JSON.stringify({ answers: [["sqlite"]], confidences: [confidence], covered })

    test("a confident guidance agent answers before the engines run", async () => {
      h = createHarness({ agent: "autonomy", engine: [decide(0.1)], guidance, subagents: { decision: agentDecision(0.9, true) } })
      await handleQuestionAsked(h.deps, q(), "v1")
      expect(h.engineRequests).toHaveLength(0)
      expect(h.replies()).toHaveLength(1)
      expect(h.summaries()[0]).toStartWith("[auto-question] Answered by agent (pass 0")
    })

    test("covered but unconfident defers to the human without a generic-engine override", async () => {
      h = createHarness({ agent: "autonomy", engine: [decide(0.99)], guidance, subagents: { decision: agentDecision(0.4, true) } })
      await handleQuestionAsked(h.deps, q(), "v1")
      expect(h.engineRequests).toHaveLength(0)
      expect(h.replies()).toHaveLength(0)
      expect(h.summaries()[0]).toContain("project guidance covered the question but the decision agent was not confident")
    })

    test("not covered falls through to pass 1", async () => {
      h = createHarness({ agent: "autonomy", engine: [decide(0.9)], guidance, subagents: { decision: agentDecision(0.2, false) } })
      await handleQuestionAsked(h.deps, q(), "v1")
      expect(h.engineRequests).toHaveLength(1)
      expect(h.summaries()[0]).toStartWith("[auto-question] Answered by llm (pass 1")
    })

    test("a failed guidance agent falls through to pass 1", async () => {
      h = createHarness({ agent: "autonomy", engine: [decide(0.9)], guidance, subagents: { decision: null } })
      await handleQuestionAsked(h.deps, q(), "v1")
      expect(h.engineRequests).toHaveLength(1)
      expect(h.replies()).toHaveLength(1)
    })

    test("guidance disabled skips pass 0 entirely", async () => {
      h = createHarness({
        agent: "autonomy",
        engine: [decide(0.9)],
        guidance,
        subagents: { decision: agentDecision(0.9, true) },
        config: { guidance: { enabled: false, projectPath: ".opencode/auto-question/guidance", globalPath: "/nonexistent", maxChars: 20_000 } },
      })
      await handleQuestionAsked(h.deps, q(), "v1")
      expect(h.childSessions()).toEqual([])
      expect(h.engineRequests).toHaveLength(1)
    })
  })
})
