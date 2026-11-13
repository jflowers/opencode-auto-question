import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_CONFIG } from "./config"
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

  // Issue #3: a pass-1 answer between the two thresholds must not be replied
  // when pass 2 learned nothing new (skipped or failed).
  test("no gathered or immediate context: pass 1 between the thresholds defers to the human", async () => {
    h = createHarness({ agent: "autonomy", engine: [decide(0.44)], subagents: { context: "No relevant context found." } })
    await handleQuestionAsked(h.deps, q(), "v1")
    expect(h.engineRequests).toHaveLength(1)
    expect(h.replies()).toHaveLength(0)
    expect(h.summaries()).toHaveLength(1)
    expect(h.summaries()[0]).toStartWith(
      "[auto-question] Deferred to human — low confidence (llm confidence 0.44 below threshold 0.60)",
    )
  })

  test("a failed pass 2 holds the pass 1 decision to confidenceThreshold", async () => {
    h = createHarness({ agent: "autonomy", engine: [decide(0.5), { status: 500 }], subagents: { context: "Some facts." } })
    await handleQuestionAsked(h.deps, q(), "v1")
    expect(h.engineRequests).toHaveLength(2)
    expect(h.replies()).toHaveLength(0)
    expect(h.summaries()[0]).toContain("below threshold 0.60")
  })

  test("the same pass-1 confidence is replied once pass 2 re-decides with context", async () => {
    // Control for the two tests above: fallbackThreshold applies to pass 2.
    h = createHarness({ agent: "autonomy", engine: [decide(0.44), decide(0.44)], subagents: { context: "Some facts." } })
    await handleQuestionAsked(h.deps, q(), "v1")
    expect(h.engineRequests).toHaveLength(2)
    expect(h.replies()).toHaveLength(1)
    expect(h.summaries()[0]).toContain("(pass 2, min confidence 0.44)")
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

  test("a decision that arrives after the handler timeout is dropped, not replied", async () => {
    h = createHarness({
      agent: "autonomy",
      engine: [{ delayMs: 60, reply: decide(0.99) }],
      config: { handlerTimeoutMs: 20 },
    })
    await handleQuestionAsked(h.deps, q(), "v1")
    // Let the late decision finish.
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(h.engineRequests).toHaveLength(1)
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

  describe("profiles", () => {
    const agents = ["autonomy", "hud-supervisor"]
    let dirs: string[] = []
    afterEach(() => {
      for (const d of dirs) rmSync(d, { recursive: true, force: true })
      dirs = []
    })
    const guidanceDir = (text: string) => {
      const d = mkdtempSync(join(tmpdir(), "aq-profile-guidance-"))
      dirs.push(d)
      mkdirSync(d, { recursive: true })
      writeFileSync(join(d, "doc.md"), text)
      return d
    }
    const decisionPrompts = (h: Harness) =>
      h.posts.filter((p) => /^\/session\/child_\d+\/message$/.test(p.url)).map((p) => p.body.parts[0].text as string)

    test("a profile's threshold applies to its agent only", async () => {
      const config = { agents, profiles: { "hud-supervisor": { confidenceThreshold: 0.9 } } }
      h = createHarness({ agent: "autonomy", engine: [decide(0.8)], config })
      await handleQuestionAsked(h.deps, q(), "v1")
      expect(h.replies()).toHaveLength(1)
      h.cleanup()

      h = createHarness({ agent: "hud-supervisor", engine: [decide(0.8)], subagents: { context: null }, config })
      await handleQuestionAsked(h.deps, q(), "v1")
      expect(h.replies()).toHaveLength(0)
      expect(h.summaries()[0]).toContain("below threshold 0.90")
    })

    test("a profile's llm model is the one the engine is asked", async () => {
      const config = { agents, profiles: { "hud-supervisor": { llm: { model: "qwen/qwen3" } } } }
      h = createHarness({ agent: "hud-supervisor", engine: [decide(0.9)], config })
      await handleQuestionAsked(h.deps, q(), "v1")
      expect(h.engineRequests[0].model).toBe("qwen/qwen3")
    })

    test("inheritGlobal false: the decision agent sees only the profile's guidance", async () => {
      const shared = guidanceDir("SHARED: always proceed.")
      const own = guidanceDir("HUD: judge the proposal on the evidence.")
      const config = {
        agents,
        guidance: { ...DEFAULT_CONFIG.guidance, globalPath: shared },
        profiles: { "hud-supervisor": { guidance: { globalPath: own, inheritGlobal: false } } },
      }
      const decision = JSON.stringify({ answers: [["sqlite"]], confidences: [0.9], covered: true })
      h = createHarness({ agent: "hud-supervisor", engine: [decide(0.1)], subagents: { decision }, config })
      await handleQuestionAsked(h.deps, q(), "v1")
      const [prompt] = decisionPrompts(h)
      expect(prompt).toContain("HUD: judge the proposal on the evidence.")
      expect(prompt).not.toContain("SHARED")
      h.cleanup()

      // autonomy still gets the shared guidance.
      h = createHarness({ agent: "autonomy", engine: [decide(0.1)], subagents: { decision }, config })
      await handleQuestionAsked(h.deps, q(), "v1")
      expect(decisionPrompts(h)[0]).toContain("SHARED: always proceed.")
    })

    test("a HUMAN_GATE question is left for the human whatever the profile says", async () => {
      const config = { agents, profiles: { "hud-supervisor": { confidenceThreshold: 0, fallbackThreshold: 0 } } }
      h = createHarness({ agent: "hud-supervisor", engine: [decide(0.99)], config })
      await handleQuestionAsked(h.deps, request([question("HUMAN_GATE: Merge it?")]), "v1")
      expect(h.engineRequests).toHaveLength(0)
      expect(h.replies()).toHaveLength(0)
    })
  })
})
