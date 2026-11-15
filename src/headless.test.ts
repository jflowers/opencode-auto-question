import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ESCALATION_ENV, HEADLESS_ENV, headlessFromEnv, loadConfig } from "./config"
import { loadBundledAgents, registerAgents } from "./agents"
import {
  allowQuestionHeadless,
  DEFAULT_ESCALATION,
  escalationPlaybook,
  formatOutput,
  headlessQuestionTool,
  parseQuestionArgs,
  runHeadlessQuestion,
} from "./headless"
import { createHarness, question, type Harness } from "./test-harness"

const ctx = (agent = "build") => ({ sessionID: "ses_1", agent, directory: "", messageID: "msg_a" })

describe("runHeadlessQuestion", () => {
  let h: Harness | undefined
  afterEach(() => h?.cleanup())

  test("answers any agent's question, not just agents in the agents list", async () => {
    h = createHarness({ agent: "build", engine: [{ answers: [["postgres"]], confidences: [0.9], rationale: "server" }] })
    const record = await runHeadlessQuestion(h.deps, [question("Which DB?")], ctx("build"))
    expect(record).toMatchObject({ source: "headless", action: "returned", outcome: "answered", answer: "postgres", confidence: 0.9, pass: 1 })
    expect(record.questions![0]).toMatchObject({ outcome: "answered", reply: ["postgres"], pass: "pass 1" })
    expect(h.results).toEqual([record])
    // Nothing is replied through the question API and no summary is written.
    expect(h.replies()).toEqual([])
    expect(h.summaries()).toEqual([])
  })

  test("pass 2 re-asks only the questions pass 1 left, and keeps the confident ones", async () => {
    h = createHarness({
      engine: [
        { answers: [["sqlite"], ["postgres"], ["sqlite"]], confidences: [0.9, 0.2, 0.8] },
        { answers: [["postgres"]], confidences: [0.5] },
      ],
      subagents: { context: "The team runs Postgres everywhere." },
    })
    const qs = [question("Q one?", "A"), question("Q two?", "B"), question("Q three?", "C")]
    const record = await runHeadlessQuestion(h.deps, qs, ctx())
    expect(record.outcome).toBe("answered")
    expect(record.questions!.map((q) => [q.outcome, q.reply, q.pass])).toEqual([
      ["answered", ["sqlite"], "pass 1"],
      ["answered", ["postgres"], "pass 2"],
      ["answered", ["sqlite"], "pass 1"],
    ])
    expect(record.passDetail).toBe("pass 1, pass 2")
    const second = JSON.stringify(h.engineRequests[1])
    expect(second).toContain("Q two?")
    expect(second).not.toContain("Q one?")
    expect(second).not.toContain("Q three?")
    const contextPrompt = h.posts.find((p) => /^\/session\/child_\d+\/message$/.test(p.url))!.body.parts[0].text as string
    expect(contextPrompt).toContain("Q two?")
    expect(contextPrompt).not.toContain("Q one?")
  })

  test("a form that is partly answered marks only the questions that fell short", async () => {
    h = createHarness({
      engine: [
        { answers: [["sqlite"], ["postgres"]], confidences: [0.9, 0.2] },
        { answers: [["postgres"]], confidences: [0.1] },
      ],
      subagents: { context: "Unclear." },
    })
    const record = await runHeadlessQuestion(h.deps, [question("Q one?"), question("Q two?")], ctx())
    expect(record).toMatchObject({ outcome: "partial", reason: "1 of 2 questions not answered", answers: [["sqlite"], []] })
    expect(record.questions![1]).toMatchObject({
      outcome: "deferred",
      answer: null,
      confidence: 0.1,
      threshold: 0.35,
      reply: ["NO_SECOND_OPINION: deferred (confidence 0.10 < 0.35, pass 2)"],
    })
  })

  test("with no context to gather, pass 1 confidence is still held to confidenceThreshold", async () => {
    h = createHarness({ engine: [{ answers: [["sqlite"]], confidences: [0.5] }], subagents: { context: null } })
    const record = await runHeadlessQuestion(h.deps, [question("Q?")], ctx())
    expect(record.outcome).toBe("deferred")
    expect(record.questions![0]!.reply).toEqual(["NO_SECOND_OPINION: deferred (confidence 0.50 < 0.60, pass 1 (no gathered context))"])
    expect(h.engineRequests).toHaveLength(1)
  })

  test("an engine failure marks every question with the error", async () => {
    h = createHarness({ engine: [{ status: 503 }] })
    const record = await runHeadlessQuestion(h.deps, [question("Q one?"), question("Q two?")], ctx())
    expect(record.outcome).toBe("deferred")
    for (const q of record.questions!) {
      expect(q.outcome).toBe("deferred")
      expect(q.reply[0]).toStartWith("NO_SECOND_OPINION: deferred — ")
      expect(q.reply[0]).toContain("503")
    }
  })

  test("a timeout keeps the answers already decided and marks the rest", async () => {
    h = createHarness({
      engine: [{ answers: [["sqlite"], ["postgres"]], confidences: [0.9, 0.2] }, "hang"],
      subagents: { context: "Some context." },
      config: { handlerTimeoutMs: 50 },
    })
    const record = await runHeadlessQuestion(h.deps, [question("Q one?"), question("Q two?")], ctx())
    expect(record.outcome).toBe("partial")
    expect(record.questions!.map((q) => q.outcome)).toEqual(["answered", "timeout"])
    expect(record.questions![1]!.reply).toEqual(["NO_SECOND_OPINION: deferred (handler timed out after 0s)"])
  })

  test("a human gate on any question marks the whole form and never asks an engine", async () => {
    h = createHarness({ engine: [{ answers: [["sqlite"], ["postgres"]], confidences: [0.99, 0.99] }] })
    const record = await runHeadlessQuestion(h.deps, [question("Q one?"), question("HUMAN_GATE: Merge it?")], ctx())
    expect(record).toMatchObject({ outcome: "gated", reason: "question carries the HUMAN_GATE: marker", answers: null })
    expect(record.questions!.map((q) => q.reply)).toEqual([
      ["HUMAN_GATE_UNANSWERED: question carries the HUMAN_GATE: marker"],
      ["HUMAN_GATE_UNANSWERED: question carries the HUMAN_GATE: marker"],
    ])
    const curator = await runHeadlessQuestion(h.deps, [question("Q?")], ctx("curator"))
    expect(curator).toMatchObject({ outcome: "gated", reason: 'agent "curator" is human-gated' })
    expect(h.engineRequests).toHaveLength(0)
  })

  test("the plugin's own subagents never get an answer", async () => {
    h = createHarness({ engine: [{ answers: [["sqlite"]], confidences: [0.99] }] })
    const record = await runHeadlessQuestion(h.deps, [question("Q?")], ctx("auto-question-ctx"))
    expect(record.outcome).toBe("deferred")
    expect(record.questions![0]!.reply[0]).toContain("internal to auto-question")
    expect(h.engineRequests).toHaveLength(0)
  })

  test("the calling agent's profile applies", async () => {
    h = createHarness({
      engine: [{ answers: [["sqlite"]], confidences: [0.5] }],
      subagents: { context: null },
      config: { profiles: { build: { confidenceThreshold: 0.4 } } },
    })
    const record = await runHeadlessQuestion(h.deps, [question("Q?")], ctx("build"))
    expect(record).toMatchObject({ outcome: "answered", answer: "sqlite" })
  })
})

describe("headlessQuestionTool", () => {
  let h: Harness | undefined
  afterEach(() => h?.cleanup())

  const run = async (h: Harness, questions: unknown[], agent = "build") =>
    (await headlessQuestionTool(h.deps).execute({ questions } as any, ctx(agent) as any)) as {
      title: string
      output: string
      metadata: any
    }

  test("every question answered: the built-in tool's wording", async () => {
    h = createHarness({ engine: [{ answers: [["sqlite"]], confidences: [0.9] }] })
    const result = await run(h, [question("Q?")])
    expect(result.title).toBe("Asked 1 question (auto-answered 1/1)")
    expect(result.output).toBe('User has answered your questions: "Q?"="sqlite". You can now continue with the user\'s answers in mind.')
    expect(result.metadata.autoQuestion).toEqual({ v: 1, outcome: "answered", answered: 1, total: 1, humanGate: false, humanNeeded: false })
  })

  test("unconfident questions: the agent is told to decide them itself, and no human is needed", async () => {
    h = createHarness({
      engine: [{ answers: [["sqlite"], ["postgres"]], confidences: [0.9, 0.2] }],
      subagents: { context: null },
    })
    const tool = headlessQuestionTool(h.deps)
    expect(Object.keys(tool.args)).toEqual(["questions"])
    const result = await run(h, [question("Q one?"), question("Q two?")])
    expect(result.title).toBe("Asked 2 questions (auto-answered 1/2)")
    expect(result.output).toStartWith(
      'Auto-answered 1 of 2 questions: "Q one?"="sqlite", "Q two?"="NO_SECOND_OPINION: deferred (confidence 0.20 < 0.60, pass 1 (no gathered context))".',
    )
    expect(result.output).toContain("Decide them yourself from the evidence")
    expect(result.output).not.toContain("You can now continue")
    expect(result.metadata.autoQuestion).toEqual({ v: 1, outcome: "partial", answered: 1, total: 2, humanGate: false, humanNeeded: false })
  })

  test("a human gate: don't decide, then the default instruction; the metadata flags it", async () => {
    h = createHarness({ engine: [{ answers: [["sqlite"]], confidences: [0.99] }] })
    const result = await run(h, [question("HUMAN_GATE: Merge it?")])
    expect(result.title).toBe("Asked 1 question (human needed)")
    expect(result.output).toContain('"HUMAN_GATE: Merge it?"="HUMAN_GATE_UNANSWERED: question carries the HUMAN_GATE: marker"')
    expect(result.output).toContain("Do not decide them yourself")
    expect(result.output.endsWith(DEFAULT_ESCALATION)).toBe(true)
    expect(result.metadata.autoQuestion).toEqual({ v: 1, outcome: "gated", answered: 0, total: 1, humanGate: true, humanNeeded: true })
    expect(h.results[0]!.humanNeeded).toBe(true)
  })

  test("a configured playbook replaces the default instruction", async () => {
    h = createHarness({
      engine: [{ answers: [["sqlite"]], confidences: [0.99] }],
      config: { escalation: { text: "Comment on the PR, push WIP as a draft, end your turn.", file: "", deferred: "decide" } },
    })
    const result = await run(h, [question("HUMAN_GATE: Merge it?")])
    expect(result.output.endsWith("Comment on the PR, push WIP as a draft, end your turn.")).toBe(true)
    expect(result.output).not.toContain(DEFAULT_ESCALATION)
  })

  test('escalation.deferred "escalate" in a profile makes an unconfident question need a human', async () => {
    h = createHarness({
      engine: [{ answers: [["sqlite"], ["postgres"]], confidences: [0.9, 0.2] }],
      subagents: { context: null },
      config: { profiles: { build: { escalation: { deferred: "escalate", text: "Ask on the issue." } } } },
    })
    const result = await run(h, [question("Q one?"), question("Q two?")])
    expect(result.title).toBe("Asked 2 questions (human needed)")
    expect(result.output.endsWith("Ask on the issue.")).toBe(true)
    expect(result.metadata.autoQuestion).toMatchObject({ outcome: "partial", humanGate: false, humanNeeded: true })
    // Another agent keeps the default: decide it yourself.
    const other = await run(h, [question("Q one?"), question("Q two?")], "explore")
    expect(other.metadata.autoQuestion.humanNeeded).toBe(false)
  })

  test("appends the result trailer when resultTrailer is on", async () => {
    h = createHarness({ engine: [{ answers: [["sqlite"]], confidences: [0.9] }], config: { resultTrailer: true } })
    const result = (await headlessQuestionTool(h.deps).execute({ questions: [question("Q?")] } as any, ctx() as any)) as any
    expect(result.metadata.answers[0][0]).toBe("sqlite")
    expect(result.metadata.answers[0][1]).toStartWith("AUTO_QUESTION_RESULT ")
  })

  test("rejects bad arguments before running anything", async () => {
    h = createHarness({ engine: [{ answers: [["sqlite"]], confidences: [0.9] }] })
    await expect(headlessQuestionTool(h.deps).execute({ questions: [] } as any, ctx() as any)).rejects.toThrow(/non-empty/)
    expect(h.engineRequests).toHaveLength(0)
  })
})

describe("parseQuestionArgs", () => {
  test("accepts the built-in tool's arguments", () => {
    expect(
      parseQuestionArgs({ questions: [{ question: "Q?", header: "H", options: [{ label: "A", description: "a" }], multiple: true }] }),
    ).toEqual([{ question: "Q?", header: "H", options: [{ label: "A", description: "a" }], multiple: true }])
  })

  test("forgives common malformed shapes", () => {
    const expected = [{ question: "Q?", header: "", options: [{ label: "A", description: "" }, { label: "B", description: "" }] }]
    expect(parseQuestionArgs({ questions: JSON.stringify([{ question: "Q?", options: ["A", "B"] }]) })).toEqual(expected)
    expect(parseQuestionArgs({ questions: { question: "Q?", options: '["A","B"]' } })).toEqual(expected)
    expect(parseQuestionArgs({ question: "Q?", options: [{ value: "A" }, { label: "B" }] })).toEqual(expected)
    expect(parseQuestionArgs({ questions: [{ question: "Q?", options: ["A", "B"], multiple: "true" }] })[0]!.multiple).toBe(true)
    expect(parseQuestionArgs({ questions: ["Q?"] })).toEqual([{ question: "Q?", header: "", options: [] }])
  })

  test("throws only when there is no question text", () => {
    expect(() => parseQuestionArgs({})).toThrow(/questions/)
    expect(() => parseQuestionArgs({ questions: [] })).toThrow(/non-empty/)
    expect(() => parseQuestionArgs({ questions: [{ question: "", options: [] }] })).toThrow(/questions\[0\]\.question/)
  })

  test("formatOutput says Unanswered for an empty reply", () => {
    const record = { questions: [{ outcome: "deferred" as const }] as any, humanNeeded: false }
    expect(formatOutput([question("Q?")], [[]], record)).toContain('"Q?"="Unanswered"')
  })
})

describe("escalationPlaybook", () => {
  const dir = mkdtempSync(join(tmpdir(), "aq-esc-"))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const esc = (over: Partial<{ text: string; file: string }>) => ({ escalation: { text: "", file: "", deferred: "decide" as const, ...over } })

  test("file, else text, else the default", () => {
    const file = join(dir, "playbook.md")
    writeFileSync(file, "  From the file.  \n")
    expect(escalationPlaybook(esc({ file, text: "From text." }))).toBe("From the file.")
    expect(escalationPlaybook(esc({ text: " From text. " }))).toBe("From text.")
    expect(escalationPlaybook(esc({}))).toBe(DEFAULT_ESCALATION)
  })

  test("an unreadable or empty file falls back to the default, not the text", () => {
    expect(escalationPlaybook(esc({ file: join(dir, "missing.md"), text: "From text." }))).toBe(DEFAULT_ESCALATION)
    const empty = join(dir, "empty.md")
    writeFileSync(empty, "\n")
    expect(escalationPlaybook(esc({ file: empty }))).toBe(DEFAULT_ESCALATION)
  })
})

describe("allowQuestionHeadless", () => {
  const config = {
    humanGatedAgents: ["curator"],
    contextGathering: { agent: "auto-question-ctx", model: "", timeoutMs: 1 },
    agentDecision: { agent: "auto-question-decide", model: "", timeoutMs: 1 },
  }

  test("allows question globally and on agents without a rule, human-gated ones included; denies it for the plugin's subagents", () => {
    const opencode: { permission?: unknown; agent?: Record<string, unknown> } = {
      permission: { bash: "ask" },
      agent: {
        reviewer: { permission: { "*": "deny", read: "allow" } },
        helper: { prompt: "h" },
        mine: { permission: { question: "deny" } },
        open: { permission: "allow" },
        curator: {},
      },
    }
    registerAgents(opencode as { agent?: Record<string, unknown> }, loadBundledAgents())
    const r = allowQuestionHeadless(opencode, config)
    expect(r.global).toBe("added")
    expect(opencode.permission).toEqual({ bash: "ask", question: "allow" })
    expect(r.allowed.sort()).toEqual(["curator", "helper", "reviewer"])
    expect(r.denied.sort()).toEqual(["auto-question-ctx", "auto-question-decide"])
    expect(r.kept.sort()).toEqual(["autonomy", "mine", "open"])
    expect(r.gated).toEqual(["curator"])
    const reviewer = opencode.agent!.reviewer as { permission: Record<string, string> }
    expect(Object.entries(reviewer.permission)).toEqual([["*", "deny"], ["read", "allow"], ["question", "allow"]])
    expect((opencode.agent!["auto-question-ctx"] as any).permission.question).toBe("deny")
    // A human-gated agent can ask, so it gets HUMAN_GATE_UNANSWERED and the playbook (issue #36).
    expect(opencode.agent!.curator).toEqual({ permission: { question: "allow" } })
  })

  test("a human-gated agent with its own question rule keeps it", () => {
    const opencode: { permission?: unknown; agent?: Record<string, unknown> } = {
      agent: { curator: { permission: { question: "deny" } } },
    }
    const r = allowQuestionHeadless(opencode, config)
    expect(r).toMatchObject({ allowed: [], kept: ["curator"], gated: [] })
    expect(opencode.agent!.curator).toEqual({ permission: { question: "deny" } })
  })

  test("keeps a configured global rule and leaves a blanket permission alone", () => {
    const set: { permission?: unknown } = { permission: { question: "deny" } }
    expect(allowQuestionHeadless(set, config).global).toBe("kept")
    expect(set.permission).toEqual({ question: "deny" })
    const blanket: { permission?: unknown } = { permission: "allow" }
    expect(allowQuestionHeadless(blanket, config).global).toBe("blanket")
    const none: { permission?: unknown } = {}
    expect(allowQuestionHeadless(none, config).global).toBe("added")
    expect(none.permission).toEqual({ question: "allow" })
  })
})

describe("headless setting", () => {
  test(`${HEADLESS_ENV} values`, () => {
    for (const v of ["1", "true", "YES", " on "]) expect(headlessFromEnv({ [HEADLESS_ENV]: v })).toBe(true)
    for (const v of ["0", "false", "No", "off"]) expect(headlessFromEnv({ [HEADLESS_ENV]: v })).toBe(false)
    expect(headlessFromEnv({})).toBeUndefined()
    expect(headlessFromEnv({ [HEADLESS_ENV]: "  " })).toBeUndefined()
    expect(() => headlessFromEnv({ [HEADLESS_ENV]: "maybe" })).toThrow(HEADLESS_ENV)
  })

  test(`${ESCALATION_ENV} sets the playbook file; a relative file in a config resolves against it`, () => {
    expect(loadConfig("/nonexistent/auto-question.jsonc", () => {}, {}).escalation).toEqual({ text: "", file: "", deferred: "decide" })
    expect(loadConfig("/nonexistent/auto-question.jsonc", () => {}, { [ESCALATION_ENV]: "/etc/playbook.md" }).escalation.file).toBe("/etc/playbook.md")
    const dir = mkdtempSync(join(tmpdir(), "aq-esc-cfg-"))
    try {
      const path = join(dir, "auto-question.jsonc")
      writeFileSync(path, JSON.stringify({ escalation: { file: "playbook.md" }, profiles: { build: { escalation: { file: "b.md" } } } }))
      const config = loadConfig(path, () => {}, {})
      expect(config.escalation.file).toBe(join(dir, "playbook.md"))
      expect((config.profiles.build!.escalation as { file: string }).file).toBe(join(dir, "b.md"))
      writeFileSync(path, JSON.stringify({ escalation: { deferred: "ask" } }))
      expect(() => loadConfig(path, () => {}, {})).toThrow(/escalation.deferred/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("defaults off, and the environment overrides the config", () => {
    expect(loadConfig("/nonexistent/auto-question.jsonc", () => {}, {}).headless).toBe(false)
    expect(loadConfig("/nonexistent/auto-question.jsonc", () => {}, { [HEADLESS_ENV]: "1" }).headless).toBe(true)
  })
})
