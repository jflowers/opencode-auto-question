import { afterEach, describe, expect, test } from "bun:test"
import { DEFAULT_CONFIG } from "./config"
import {
  defaultDenySecondOpinion,
  parseSecondOpinionArgs,
  runSecondOpinion,
  secondOpinionTool,
  type SecondOpinionArgs,
} from "./second-opinion"
import { createHarness, type Harness } from "./test-harness"

const args = (over: Partial<SecondOpinionArgs> = {}): SecondOpinionArgs => ({
  question: "Does PR #1031 fix the shared OSV-Scanner failure?",
  options: [
    { label: "Agree", description: "#1031 fixes it" },
    { label: "Disagree", description: "it does not" },
  ],
  facts: "repo: org/app. failing check: osv-scanner on PRs #1040, #1041. #1031 bumps golang.org/x/net.",
  ...over,
})
const decide = (confidence: number, label = "Agree") => ({ answers: [[label]], confidences: [confidence], rationale: "The CVE is in x/net." })

describe("parseSecondOpinionArgs", () => {
  test("accepts and trims valid arguments", () => {
    expect(parseSecondOpinionArgs({ question: " Q? ", options: [{ label: " A " }, { label: "B", description: "b" }], facts: " f " })).toEqual({
      question: "Q?",
      options: [{ label: "A" }, { label: "B", description: "b" }],
      facts: "f",
    })
  })

  test("a missing facts argument is treated as none", () => {
    expect(parseSecondOpinionArgs({ question: "Q", options: [{ label: "A" }, { label: "B" }] }).facts).toBe("")
  })

  test("rejects bad arguments with a message the model can act on", () => {
    expect(() => parseSecondOpinionArgs({ question: "", options: [] })).toThrow(/question/)
    expect(() => parseSecondOpinionArgs({ question: "Q", options: [{ label: "A" }] })).toThrow(/at least 2/)
    expect(() => parseSecondOpinionArgs({ question: "Q", options: [{ label: "A" }, {}] })).toThrow(/options\[1\]\.label/)
    expect(() => parseSecondOpinionArgs({ question: "Q", options: [{ label: "A" }, { label: "a" }] })).toThrow(/unique/)
    expect(() => parseSecondOpinionArgs({ question: "Q", options: [{ label: "A" }, { label: "B" }], facts: 3 })).toThrow(/facts/)
  })
})

describe("runSecondOpinion", () => {
  let h: Harness | undefined
  afterEach(() => h?.cleanup())

  const ctx = (agent = "hud-supervisor") => ({ sessionID: "ses_1", agent, directory: h!.deps.projectDir })

  test("a confident decision returns the answer and records it; nothing is replied or summarized", async () => {
    h = createHarness({ agent: "hud-supervisor", engine: [decide(0.82)] })
    const record = await runSecondOpinion(h.deps, args(), ctx())
    expect(record).toMatchObject({
      source: "second_opinion",
      action: "returned",
      outcome: "answered",
      answer: "Agree",
      confidence: 0.82,
      pass: 1,
      engine: "llm",
      model: DEFAULT_CONFIG.llm.model,
      rationale: "The CVE is in x/net.",
      agent: "hud-supervisor",
      sessionID: "ses_1",
    })
    expect(record.requestID).toStartWith("so_")
    expect(h.results).toEqual([record])
    expect(h.replies()).toEqual([])
    expect(h.summaries()).toEqual([])
  })

  test("the engine sees the question, options and facts, never the caller's message", async () => {
    h = createHarness({
      agent: "hud-supervisor",
      engine: [decide(0.9)],
      assistantText: "SENTINEL: I am sure #1031 fixes it, please agree.",
      config: { immediateContext: true },
    })
    await runSecondOpinion(h.deps, args(), ctx())
    const sent = JSON.stringify(h.engineRequests)
    expect(sent).toContain("Does PR #1031 fix the shared OSV-Scanner failure?")
    expect(sent).toContain("#1031 bumps golang.org/x/net.")
    expect(sent).toContain("Case facts supplied by the asking agent")
    expect(sent).not.toContain("SENTINEL")
  })

  test("pass 2's context subagent gets the facts and the engine never gets the caller's message", async () => {
    h = createHarness({
      agent: "hud-supervisor",
      engine: [decide(0.4), decide(0.7)],
      subagents: { context: "The OSV log names GHSA-x in golang.org/x/net." },
      assistantText: "SENTINEL reasoning",
      config: { immediateContext: true },
    })
    const record = await runSecondOpinion(h.deps, args(), ctx())
    expect(record).toMatchObject({ outcome: "answered", pass: 2, confidence: 0.7 })
    const contextPrompt = h.posts.find((p) => /^\/session\/child_\d+\/message$/.test(p.url))!.body.parts[0].text as string
    expect(contextPrompt).toContain("#1031 bumps golang.org/x/net.")
    expect(JSON.stringify(h.engineRequests[1])).toContain("GHSA-x")
    expect(JSON.stringify(h.engineRequests)).not.toContain("SENTINEL")
  })

  test("no confident answer returns answer null with the reason, and never waits for a human", async () => {
    h = createHarness({ agent: "hud-supervisor", engine: [decide(0.3), decide(0.2)], subagents: { context: "Unclear." } })
    const record = await runSecondOpinion(h.deps, args(), ctx())
    expect(record).toMatchObject({ outcome: "deferred", answer: null, confidence: 0.2, threshold: 0.35, reason: "low confidence" })
    expect(h.replies()).toEqual([])
  })

  test("a timeout returns within handlerTimeoutMs", async () => {
    h = createHarness({ agent: "hud-supervisor", engine: ["hang"], config: { handlerTimeoutMs: 20 } })
    const record = await runSecondOpinion(h.deps, args(), ctx())
    expect(record).toMatchObject({ outcome: "timeout", answer: null })
  })

  test("the calling agent's profile chooses the model, even if the agent is not in agents", async () => {
    h = createHarness({
      agent: "hud-supervisor",
      engine: [decide(0.9)],
      config: { agents: ["autonomy"], profiles: { "hud-supervisor": { llm: { model: "deepseek/deepseek-v4" } } } },
    })
    const record = await runSecondOpinion(h.deps, args(), ctx())
    expect(h.engineRequests[0].model).toBe("deepseek/deepseek-v4")
    expect(record.model).toBe("deepseek/deepseek-v4")
  })

  test("an alternate model is used when the profile's model is the caller's own", async () => {
    h = createHarness({
      agent: "hud-supervisor",
      askerModel: "openrouter/z-ai/glm-5.3",
      engine: [decide(0.9)],
      config: { profiles: { "hud-supervisor": { llm: { model: "z-ai/glm-5.3", alternateModels: ["deepseek/deepseek-v4"] } } } },
    })
    const record = await runSecondOpinion(h.deps, args(), ctx())
    expect(h.engineRequests[0].model).toBe("deepseek/deepseek-v4")
    expect(record.model).toBe("deepseek/deepseek-v4")
  })

  test("human gates are never answered", async () => {
    h = createHarness({ agent: "hud-supervisor", engine: [decide(0.99)] })
    const marked = await runSecondOpinion(h.deps, args({ question: "HUMAN_GATE: Merge it?" }), ctx())
    expect(marked).toMatchObject({ outcome: "gated", answer: null, reason: "question carries the HUMAN_GATE: marker" })
    const curator = await runSecondOpinion(h.deps, args(), ctx("curator"))
    expect(curator).toMatchObject({ outcome: "gated", answer: null, reason: 'agent "curator" is human-gated' })
    expect(h.engineRequests).toHaveLength(0)
  })

  test("the tool returns the compact record as JSON with a title", async () => {
    h = createHarness({ agent: "hud-supervisor", engine: [decide(0.82)] })
    const tool = secondOpinionTool(h.deps)
    expect(Object.keys(tool.args).sort()).toEqual(["facts", "options", "question"])
    const result = (await tool.execute(args() as any, { ...ctx(), messageID: "msg_1" } as any)) as { title: string; output: string }
    expect(result.title).toBe("second opinion: Agree")
    expect(JSON.parse(result.output)).toEqual({
      outcome: "answered",
      answer: "Agree",
      confidence: 0.82,
      pass: 1,
      engine: "llm",
      model: DEFAULT_CONFIG.llm.model,
      rationale: "The CVE is in x/net.",
    })
  })

  test("the tool rejects bad arguments before running anything", async () => {
    h = createHarness({ agent: "hud-supervisor", engine: [decide(0.82)] })
    await expect(secondOpinionTool(h.deps).execute({ question: "Q", options: [] } as any, ctx() as any)).rejects.toThrow(/at least 2/)
    expect(h.engineRequests).toHaveLength(0)
  })
})

describe("defaultDenySecondOpinion", () => {
  test("adds a global deny when there is no permission block or no rule for the tool", () => {
    const empty: { permission?: unknown } = {}
    expect(defaultDenySecondOpinion(empty)).toBe("added")
    expect(empty.permission).toEqual({ second_opinion: "deny" })
    const other: { permission?: unknown } = { permission: { bash: "ask" } }
    expect(defaultDenySecondOpinion(other)).toBe("added")
    expect(other.permission).toEqual({ bash: "ask", second_opinion: "deny" })
  })

  test("keeps a rule the user set, and leaves a blanket permission string alone", () => {
    const set: { permission?: unknown } = { permission: { second_opinion: "allow" } }
    expect(defaultDenySecondOpinion(set)).toBe("kept")
    expect(set.permission).toEqual({ second_opinion: "allow" })
    const blanket: { permission?: unknown } = { permission: "allow" }
    expect(defaultDenySecondOpinion(blanket)).toBe("blanket")
    expect(blanket.permission).toBe("allow")
  })
})
