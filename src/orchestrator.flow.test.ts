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

    test("a profile's subagent models are sent with the child-session prompts", async () => {
      const config = {
        agents,
        profiles: {
          "hud-supervisor": {
            contextGathering: { model: "openrouter/qwen/qwen3-coder" },
            agentDecision: { model: "openrouter/deepseek/deepseek-v4" },
          },
        },
      }
      h = createHarness({
        agent: "hud-supervisor",
        engine: [decide(0.4), decide(0.9)],
        guidance: "Prefer sqlite.",
        subagents: { decision: null, context: "Team uses sqlite." },
        config,
      })
      await handleQuestionAsked(h.deps, q(), "v1")
      const bodies = h.posts.filter((p) => /^\/session\/child_\d+\/message$/.test(p.url)).map((p) => p.body)
      expect(bodies.map((b) => b.model)).toEqual([
        { providerID: "openrouter", modelID: "deepseek/deepseek-v4" },
        { providerID: "openrouter", modelID: "qwen/qwen3-coder" },
      ])
    })

    test("without a subagent model the agent's own model is used (no model in the body)", async () => {
      h = createHarness({ agent: "autonomy", engine: [decide(0.4), decide(0.9)], subagents: { context: "x" } })
      await handleQuestionAsked(h.deps, q(), "v1")
      const body = h.posts.find((p) => /^\/session\/child_\d+\/message$/.test(p.url))!.body
      expect(body).not.toHaveProperty("model")
    })

    describe("the asking session's own model", () => {
      const hud = (llm: Record<string, unknown>) => ({ agents, profiles: { "hud-supervisor": { llm } } })

      test("is swapped for the first alternate that differs from it, and the record names it", async () => {
        h = createHarness({
          agent: "hud-supervisor",
          askerModel: "zai/glm-5.3",
          engine: [decide(0.9)],
          config: hud({ model: "z-ai/glm-5.3", alternateModels: ["z-ai/glm-5.3:free", "qwen/qwen3"] }),
        })
        await handleQuestionAsked(h.deps, q(), "v1")
        expect(h.engineRequests[0].model).toBe("qwen/qwen3")
        expect(h.results[0]!.model).toBe("qwen/qwen3")
      })

      test("is kept, with a warning, when no alternate is configured", async () => {
        h = createHarness({
          agent: "hud-supervisor",
          askerModel: "openrouter/z-ai/glm-5.3",
          engine: [decide(0.9)],
          config: hud({ model: "z-ai/glm-5.3" }),
        })
        await handleQuestionAsked(h.deps, q(), "v1")
        expect(h.engineRequests[0].model).toBe("z-ai/glm-5.3")
      })

      test("a different asker model leaves llm.model alone", async () => {
        h = createHarness({
          agent: "hud-supervisor",
          askerModel: "anthropic/claude-sonnet-5-5",
          engine: [decide(0.9)],
          config: hud({ model: "z-ai/glm-5.3", alternateModels: ["qwen/qwen3"] }),
        })
        await handleQuestionAsked(h.deps, q(), "v1")
        expect(h.engineRequests[0].model).toBe("z-ai/glm-5.3")
      })
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

  describe("onDefer: reject", () => {
    const reject = { onDefer: "reject" as const }
    const markerReply = (h: Harness) => h.replies()[0]?.body.answers as string[][] | undefined
    const rejects = (h: Harness) => h.posts.filter((p) => p.url.endsWith("/reject")).map((p) => p.url)

    test("an answered question is replied as usual", async () => {
      h = createHarness({ agent: "autonomy", engine: [decide(0.9)], config: reject })
      await handleQuestionAsked(h.deps, q(), "v1")
      expect(markerReply(h)).toEqual([["sqlite"]])
    })

    test("low confidence after pass 2 is answered with a NO_SECOND_OPINION marker", async () => {
      h = createHarness({
        agent: "autonomy",
        engine: [decide(0.3), decide(0.31)],
        subagents: { context: "Some facts." },
        config: reject,
      })
      await handleQuestionAsked(h.deps, q(), "v1")
      expect(markerReply(h)).toEqual([["NO_SECOND_OPINION: deferred (confidence 0.31 < 0.35, pass 2)"]])
      expect(rejects(h)).toEqual([])
      expect(h.summaries()[0]).toStartWith("[auto-question] Not answered (onDefer: reject) — replied NO_SECOND_OPINION")
    })

    test("every question in the request gets the marker", async () => {
      h = createHarness({
        agent: "autonomy",
        engine: [{ answers: [["sqlite"], ["postgres"]], confidences: [0.9, 0.2] }],
        subagents: { context: null },
        config: reject,
      })
      await handleQuestionAsked(h.deps, request([question("Which database?"), question("Which cache?")]), "v2")
      expect(h.replies()[0]!.url).toBe("/api/session/ses_1/question/que_1/reply")
      const answers = markerReply(h)!
      expect(answers).toHaveLength(2)
      for (const a of answers) expect(a[0]).toStartWith("NO_SECOND_OPINION: deferred (confidence 0.20 < 0.60, pass 1")
    })

    test("an engine failure is answered with the error in the marker", async () => {
      h = createHarness({ agent: "autonomy", engine: [{ status: 503 }], subagents: { context: null }, config: reject })
      await handleQuestionAsked(h.deps, q(), "v1")
      expect(markerReply(h)![0]![0]).toStartWith("NO_SECOND_OPINION: deferred — LLM API 503")
    })

    test("guidance covered but unconfident is answered with the reason", async () => {
      const decision = JSON.stringify({ answers: [["sqlite"]], confidences: [0.4], covered: true })
      h = createHarness({ agent: "autonomy", engine: [decide(0.99)], guidance: "Prefer sqlite.", subagents: { decision }, config: reject })
      await handleQuestionAsked(h.deps, q(), "v1")
      expect(h.engineRequests).toHaveLength(0)
      expect(markerReply(h)).toEqual([
        [
          "NO_SECOND_OPINION: deferred — project guidance covered the question but the decision agent was not confident (confidence 0.40 < 0.60, pass 0)",
        ],
      ])
    })

    test("a handler timeout is answered within handlerTimeoutMs", async () => {
      h = createHarness({ agent: "autonomy", engine: ["hang"], config: { ...reject, handlerTimeoutMs: 20 } })
      const started = Date.now()
      await handleQuestionAsked(h.deps, q(), "v1")
      expect(Date.now() - started).toBeLessThan(1000)
      expect(markerReply(h)).toEqual([["NO_SECOND_OPINION: deferred (handler timed out after 0s)"]])
    })

    test("a HUMAN_GATE question is rejected, never answered", async () => {
      h = createHarness({ agent: "autonomy", engine: [decide(0.99)], config: reject })
      await handleQuestionAsked(h.deps, request([question("HUMAN_GATE: Promote?")]), "v2")
      expect(h.engineRequests).toHaveLength(0)
      expect(h.replies()).toEqual([])
      expect(rejects(h)).toEqual(["/api/session/ses_1/question/que_1/reject"])
      expect(h.summaries()[0]).toStartWith("[auto-question] Rejected (onDefer: reject) — HUMAN_GATE_UNANSWERED:")
    })

    test("onDefer human leaves a HUMAN_GATE question pending, as before", async () => {
      h = createHarness({ agent: "autonomy", engine: [decide(0.99)] })
      await handleQuestionAsked(h.deps, request([question("HUMAN_GATE: Promote?")]), "v1")
      expect(h.replies()).toEqual([])
      expect(rejects(h)).toEqual([])
    })

    test("onDefer can be set per profile", async () => {
      const config = { agents: ["autonomy", "hud-supervisor"], profiles: { "hud-supervisor": reject } }
      h = createHarness({ agent: "hud-supervisor", engine: [decide(0.2)], subagents: { context: null }, config })
      await handleQuestionAsked(h.deps, q(), "v1")
      expect(markerReply(h)![0]![0]).toStartWith("NO_SECOND_OPINION:")
      h.cleanup()

      h = createHarness({ agent: "autonomy", engine: [decide(0.2)], subagents: { context: null }, config })
      await handleQuestionAsked(h.deps, q(), "v1")
      expect(h.replies()).toEqual([])
    })
  })

  describe("structured result", () => {
    const parseTrailer = (answer: string) => {
      expect(answer.startsWith("AUTO_QUESTION_RESULT ")).toBe(true)
      return JSON.parse(answer.slice("AUTO_QUESTION_RESULT ".length))
    }

    test("an answered question is recorded with engine, model and rationale; no trailer by default", async () => {
      h = createHarness({ agent: "autonomy", engine: [{ ...decide(0.82), rationale: "The tool is single-user." }] })
      await handleQuestionAsked(h.deps, q(), "v1")
      expect(h.replies()[0]!.body.answers).toEqual([["sqlite"]])
      expect(h.results).toHaveLength(1)
      expect(h.results[0]).toMatchObject({
        requestID: "que_1",
        sessionID: "ses_1",
        agent: "autonomy",
        outcome: "answered",
        action: "replied",
        answer: "sqlite",
        confidence: 0.82,
        pass: 1,
        engine: "llm",
        model: DEFAULT_CONFIG.llm.model,
        rationale: "The tool is single-user.",
      })
    })

    test("resultTrailer appends the record to the answer", async () => {
      h = createHarness({
        agent: "autonomy",
        engine: [decide(0.3), { ...decide(0.5), rationale: "Context says sqlite." }],
        subagents: { context: "The team chose sqlite." },
        config: { resultTrailer: true },
      })
      await handleQuestionAsked(h.deps, q(), "v1")
      const [answer] = h.replies()[0]!.body.answers as string[][]
      expect(answer![0]).toBe("sqlite")
      expect(parseTrailer(answer![1]!)).toEqual({
        outcome: "answered",
        answer: "sqlite",
        confidence: 0.5,
        pass: 2,
        engine: "llm",
        model: DEFAULT_CONFIG.llm.model,
        rationale: "Context says sqlite.",
      })
    })

    test("a question left for the human is recorded with answer null and the reason", async () => {
      h = createHarness({ agent: "autonomy", engine: [decide(0.3), decide(0.2)], subagents: { context: "Facts." } })
      await handleQuestionAsked(h.deps, q(), "v1")
      expect(h.replies()).toHaveLength(0)
      expect(h.results[0]).toMatchObject({
        outcome: "deferred",
        action: "left_for_human",
        answer: null,
        confidence: 0.2,
        threshold: 0.35,
        pass: 2,
        reason: "low confidence",
      })
    })

    test("under onDefer reject the marker reply carries the trailer", async () => {
      h = createHarness({
        agent: "autonomy",
        engine: [decide(0.3), decide(0.31)],
        subagents: { context: "Facts." },
        config: { onDefer: "reject", resultTrailer: true },
      })
      await handleQuestionAsked(h.deps, q(), "v1")
      const [answer] = h.replies()[0]!.body.answers as string[][]
      expect(answer![0]).toStartWith("NO_SECOND_OPINION: deferred")
      expect(parseTrailer(answer![1]!)).toMatchObject({ outcome: "deferred", answer: null, confidence: 0.31, pass: 2, reason: "low confidence" })
      expect(h.results[0]!.action).toBe("marker")
    })

    test("a rejected human gate is recorded (no reply can carry a trailer)", async () => {
      h = createHarness({ agent: "autonomy", engine: [decide(0.99)], config: { onDefer: "reject", resultTrailer: true } })
      await handleQuestionAsked(h.deps, request([question("HUMAN_GATE: Promote?")]), "v1")
      expect(h.replies()).toHaveLength(0)
      expect(h.results[0]).toMatchObject({ outcome: "gated", action: "rejected", answer: null, reason: "question carries the HUMAN_GATE: marker" })
    })

    test("a timeout is recorded once, and a late decision adds nothing", async () => {
      h = createHarness({ agent: "autonomy", engine: [{ delayMs: 60, reply: decide(0.99) }], config: { handlerTimeoutMs: 20 } })
      await handleQuestionAsked(h.deps, q(), "v1")
      await new Promise((resolve) => setTimeout(resolve, 120))
      expect(h.results).toHaveLength(1)
      expect(h.results[0]).toMatchObject({ outcome: "timeout", action: "left_for_human" })
    })

    test("the guidance agent's answer names it as the model when the server reports none", async () => {
      const decision = JSON.stringify({ answers: [["sqlite"]], confidences: [0.9], covered: true, rationale: "Guidance says sqlite." })
      h = createHarness({ agent: "autonomy", engine: [decide(0.1)], guidance: "Prefer sqlite.", subagents: { decision } })
      await handleQuestionAsked(h.deps, q(), "v1")
      expect(h.results[0]).toMatchObject({ pass: 0, engine: "agent", model: "agent:auto-question-decide", rationale: "Guidance says sqlite." })
    })

    test("a non-autonomous session records nothing", async () => {
      h = createHarness({ agent: "build", engine: [decide(0.99)] })
      await handleQuestionAsked(h.deps, q(), "v1")
      expect(h.results).toEqual([])
    })
  })
})

