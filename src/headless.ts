import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import type { ToolContext, ToolDefinition, ToolResult } from "@opencode-ai/plugin"
import { configForAgent, expandHome } from "./config"
import { gatherContext } from "./context"
import { isHumanGatedAgent } from "./gate"
import { loadGuidance } from "./guidance"
import { decideWithAgent } from "./engines/agent"
import { appendResult, log } from "./log"
import { avoidAskerModel } from "./model"
import {
  decide,
  getImmediateContext,
  HUMAN_GATE_UNANSWERED,
  humanGateReason,
  logDecision,
  NO_SECOND_OPINION,
  oneLine,
  REASONING_LABEL,
  withTimeout,
  type HandlerDeps,
} from "./orchestrator"
import { formatTrailer, withTrailer, type QuestionResult, type ResultRecord } from "./result"
import type { Config, Decision, QuestionInfo, QuestionRequest } from "./types"

/**
 * Headless mode (issue #32): the plugin's own `question` tool, registered
 * under the built-in tool's name so it replaces it. It answers inside the
 * tool call, for every agent, so no question form is ever shown and nothing
 * waits for a human. Each question is decided on its own: a confident answer
 * is returned, the rest get a NO_SECOND_OPINION: marker. A human gate marks
 * every question HUMAN_GATE_UNANSWERED.
 */
export const QUESTION_TOOL = "question"

const DESCRIPTION = [
  "Use this tool when you need to ask the user questions during execution. This allows you to:",
  "1. Gather user preferences or requirements",
  "2. Clarify ambiguous instructions",
  "3. Get decisions on implementation choices as you work",
  "4. Offer choices to the user about what direction to take.",
  "",
  "This session runs unattended: an automated decision engine answers instead of a human, inside this call.",
  "",
  "Usage notes:",
  "- Answers are returned as arrays of labels; set `multiple: true` to allow selecting more than one",
  '- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label',
  `- An answer starting with ${NO_SECOND_OPINION}: or ${HUMAN_GATE_UNANSWERED}: is not an answer; follow the instructions the result gives for it`,
].join("\n")

/**
 * The built-in tool's arguments as plain JSON Schema (see second-opinion.ts
 * for why not Zod). execute() validates.
 */
const ARGS = {
  questions: {
    type: "array",
    minItems: 1,
    description: "Questions to ask",
    items: {
      type: "object",
      properties: {
        question: { type: "string", description: "Complete question" },
        header: { type: "string", description: "Very short label (max 30 chars)" },
        options: {
          type: "array",
          description: "Available choices",
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "Display text (1-5 words, concise)" },
              description: { type: "string", description: "Explanation of choice" },
            },
            required: ["label", "description"],
          },
        },
        multiple: { type: "boolean", description: "Allow selecting multiple choices" },
      },
      required: ["question", "header", "options"],
    },
  },
}

/** Parse a JSON string, or return the value unchanged. */
function maybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value
  const t = value.trim()
  if (!t.startsWith("[") && !t.startsWith("{")) return value
  try {
    return JSON.parse(t)
  } catch {
    return value
  }
}

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value
  if (value === "true") return true
  if (value === "false") return false
  return undefined
}

/**
 * Validate and normalize tool arguments. Forgiving about shapes models
 * commonly get wrong (some send malformed `question` arguments): `questions`
 * as a JSON string or a single object, a lone question at the top level,
 * `options` as a JSON string or plain strings, a missing header, `multiple`
 * as a string. Throws, with a message the calling model can act on, only
 * when there is no question text to work with.
 */
export function parseQuestionArgs(raw: unknown): QuestionInfo[] {
  const a = (maybeJson(raw) ?? {}) as Record<string, unknown>
  let list = maybeJson(a.questions)
  if (list === undefined && typeof a.question === "string") list = [a]
  if (list !== null && typeof list === "object" && !Array.isArray(list)) list = [list]
  if (!Array.isArray(list) || list.length === 0) throw new Error("questions must be a non-empty array")
  return list.map((q, i) => {
    const item = (maybeJson(q) ?? {}) as Record<string, unknown>
    const text = typeof item === "string" ? item : item.question
    if (typeof text !== "string" || text.trim() === "") throw new Error(`questions[${i}].question must be a non-empty string`)
    const rawOptions = typeof item === "string" ? [] : maybeJson(item.options)
    const options = (Array.isArray(rawOptions) ? rawOptions : []).flatMap((o) => {
      if (typeof o === "string") return o.trim() ? [{ label: o.trim(), description: "" }] : []
      const opt = (o ?? {}) as Record<string, unknown>
      const label = typeof opt.label === "string" ? opt.label : typeof opt.value === "string" ? opt.value : ""
      if (label.trim() === "") return []
      return [{ label, description: typeof opt.description === "string" ? opt.description : "" }]
    })
    const header = typeof item === "string" ? "" : item.header
    const multiple = typeof item === "string" ? undefined : asBoolean(item.multiple)
    return {
      question: text,
      header: typeof header === "string" ? header : header === undefined || header === null ? "" : String(header),
      options,
      ...(multiple !== undefined ? { multiple } : {}),
    }
  })
}

/** One question's progress while deciding; `done` once it has its final result. */
interface Slot extends QuestionResult {
  done: boolean
  rationale: string | null
}

function pendingSlot(): Slot {
  return {
    done: false,
    outcome: "deferred",
    answer: null,
    reply: [],
    confidence: null,
    threshold: null,
    pass: null,
    engine: null,
    model: null,
    reason: null,
    rationale: null,
  }
}

function fromDecision(slot: Slot, decision: Decision): void {
  slot.engine = decision.engine
  slot.model = decision.model ?? null
}

function accept(slot: Slot, decision: Decision, j: number, threshold: number, pass: string): void {
  fromDecision(slot, decision)
  slot.done = true
  slot.outcome = "answered"
  slot.answer = [...(decision.answers[j] ?? [])]
  slot.reply = [...slot.answer]
  slot.confidence = decision.confidences[j] ?? null
  slot.threshold = threshold
  slot.pass = pass
  slot.rationale = decision.rationale ?? null
}

function defer(slot: Slot, decision: Decision | null, j: number, threshold: number, pass: string, reason: string): void {
  if (decision) fromDecision(slot, decision)
  slot.done = true
  slot.outcome = "deferred"
  slot.confidence = decision?.ok ? (decision.confidences[j] ?? null) : null
  slot.threshold = threshold
  slot.pass = pass
  slot.reason = reason
  const details: string[] = []
  if (slot.confidence !== null) details.push(`confidence ${slot.confidence.toFixed(2)} < ${threshold.toFixed(2)}`)
  details.push(pass)
  const why = reason === "low confidence" ? "" : ` — ${oneLine(reason)}`
  slot.reply = [`${NO_SECOND_OPINION}: deferred${why} (${details.join(", ")})`]
}

/** True when the decision answered question j at or above the threshold. */
function confident(decision: Decision, j: number, threshold: number): boolean {
  if (!decision.ok) return false
  const answer = decision.answers[j]
  const confidence = decision.confidences[j]
  return Array.isArray(answer) && answer.length > 0 && typeof confidence === "number" && confidence >= threshold
}

function subRequest(request: QuestionRequest, indices: number[]): QuestionRequest {
  return { ...request, questions: indices.map((i) => request.questions[i]!) }
}

/**
 * Decide each question of a request on its own, writing results into
 * `slots` as they become final (so a caller that times out can keep what
 * was already decided). Pass 0 (guidance) and pass 1 decide every question
 * still open; pass 2 gathers context and re-asks only the questions pass 1
 * left below confidenceThreshold, holding them to fallbackThreshold.
 */
export async function decidePerQuestion(deps: HandlerDeps, request: QuestionRequest, slots: Slot[]): Promise<void> {
  const { config } = deps
  const open = () => slots.flatMap((s, i) => (s.done ? [] : [i]))

  let immediateCtx: string | null = null
  if (config.immediateContext) {
    immediateCtx = await getImmediateContext((deps.input.client as any)._client, request)
    if (immediateCtx) log("info", "fetched immediate context", { requestID: request.id, chars: immediateCtx.length })
  }
  const reasoning = immediateCtx ? `${REASONING_LABEL}\n${immediateCtx}` : null

  // Pass 0: project guidance. Covered but not confident means the generic
  // engines must not override project policy for the questions left.
  const guidance = loadGuidance(deps.projectDir, config)
  if (guidance) {
    const d = await decideWithAgent(deps.input, config, request, immediateCtx, guidance, REASONING_LABEL)
    logDecision("pass 0 (guidance agent)", request.id, d)
    if (d.ok) {
      slots.forEach((s, i) => confident(d, i, config.confidenceThreshold) && accept(s, d, i, config.confidenceThreshold, "pass 0"))
      if (d.guidanceCovered) {
        for (const i of open()) {
          defer(
            slots[i]!,
            d,
            i,
            config.confidenceThreshold,
            "pass 0",
            "project guidance covered the question but the decision agent was not confident",
          )
        }
        return
      }
    }
  }

  // Pass 1: the questions still open, with the asking message as context.
  const pass1 = open()
  if (pass1.length === 0) return
  const first = await decide(config, subRequest(request, pass1).questions, reasoning)
  logDecision("pass 1", request.id, first)
  pass1.forEach((i, j) => confident(first, j, config.confidenceThreshold) && accept(slots[i]!, first, j, config.confidenceThreshold, "pass 1"))

  // Pass 2: gather context for the questions pass 1 left, and re-ask only those.
  const pass2 = open()
  if (pass2.length === 0) return
  log("info", "low confidence — gathering context", { requestID: request.id, questions: pass2.length })
  const sub = subRequest(request, pass2)
  const gathered = await gatherContext(deps.input, config, sub, null)
  let pass = "pass 1 (no gathered context)"
  if (gathered || reasoning) {
    const parts: string[] = []
    if (reasoning) parts.push(reasoning)
    if (gathered) parts.push(`Additional context from knowledge sources:\n${gathered}`)
    const second = await decide(config, sub.questions, parts.join("\n\n"))
    logDecision("pass 2", request.id, second)
    if (second.ok) {
      pass2.forEach((i, j) => {
        const slot = slots[i]!
        if (confident(second, j, config.fallbackThreshold)) accept(slot, second, j, config.fallbackThreshold, "pass 2")
        else defer(slot, second, j, config.fallbackThreshold, "pass 2", second.answers[j]?.length ? "low confidence" : "no answer")
      })
      return
    }
    pass = "pass 1 (pass 2 failed)"
  }
  // Nothing new was learned: the pass-1 decision is still held to confidenceThreshold.
  const jOf = new Map(pass1.map((i, j) => [i, j]))
  for (const i of pass2) {
    const reason = first.ok ? (first.answers[jOf.get(i)!]?.length ? "low confidence" : "no answer") : (first.error ?? "decision failed")
    defer(slots[i]!, first, jOf.get(i)!, config.confidenceThreshold, pass, reason)
  }
}

/** Mark every question with the same final result. */
function markAll(slots: Slot[], outcome: QuestionResult["outcome"], reason: string, reply: string): void {
  for (const s of slots) {
    s.done = true
    s.outcome = outcome
    s.reason = reason
    s.reply = [reply]
  }
}

/** The record for a headless request. */
export function buildHeadlessResult(
  request: QuestionRequest,
  slots: Slot[],
  agent: string | undefined,
  deferred: Config["escalation"]["deferred"] = "decide",
  now: Date = new Date(),
): ResultRecord {
  const answered = slots.filter((s) => s.outcome === "answered")
  let outcome: ResultRecord["outcome"]
  if (slots.some((s) => s.outcome === "gated")) outcome = "gated"
  else if (answered.length === slots.length) outcome = "answered"
  else if (answered.length > 0) outcome = "partial"
  else outcome = slots.some((s) => s.outcome === "timeout") ? "timeout" : "deferred"

  const passes = [...new Set(answered.map((s) => s.pass).filter((p): p is string => p !== null))]
  const passNumbers = passes.map((p) => Number(/^pass (\d)/.exec(p)?.[1])).filter((n) => Number.isFinite(n))
  const last = [...slots].reverse().find((s) => s.engine !== null)
  const confidences = answered.map((s) => s.confidence).filter((c): c is number => c !== null)
  const unanswered = slots.length - answered.length
  return {
    v: 1,
    time: now.toISOString(),
    requestID: request.id,
    sessionID: request.sessionID,
    agent: agent ?? null,
    source: "headless",
    outcome,
    action: "returned",
    answer: request.questions.length === 1 && answered.length === 1 ? answered[0]!.answer!.join(", ") : null,
    answers: answered.length > 0 ? slots.map((s) => s.answer ?? []) : null,
    confidence: confidences.length > 0 ? Math.min(...confidences) : null,
    confidences: null,
    threshold: null,
    pass: passNumbers.length > 0 ? Math.max(...passNumbers) : null,
    passDetail: passes.length > 0 ? passes.join(", ") : null,
    engine: last?.engine ?? null,
    model: last?.model ?? null,
    rationale: answered.find((s) => s.rationale)?.rationale ?? null,
    reason:
      outcome === "gated"
        ? (slots[0]!.reason ?? null)
        : unanswered === 0
          ? null
          : unanswered === 1 && slots.length === 1
            ? slots[0]!.reason
            : `${unanswered} of ${slots.length} questions not answered`,
    questions: slots.map(({ done: _d, rationale: _r, ...q }) => q),
    humanNeeded: humanNeeded(slots, deferred),
  }
}

/**
 * True when a human must decide: a human gate, or (with escalation.deferred
 * "escalate") any question left unanswered.
 */
export function humanNeeded(slots: Pick<QuestionResult, "outcome">[], deferred: Config["escalation"]["deferred"]): boolean {
  if (slots.some((s) => s.outcome === "gated")) return true
  return deferred === "escalate" && slots.some((s) => s.outcome !== "answered")
}

/** The instruction an agent gets when a human must decide and no playbook is configured. */
export const DEFAULT_ESCALATION =
  "Stop now. End your turn by naming each decision a human needs to make, with its options and your recommendation."

/** Most playbook characters passed to the agent. */
const ESCALATION_MAX_CHARS = 10_000

/** The playbook for `config`: its file, else its text, else the default instruction. */
export function escalationPlaybook(config: Pick<Config, "escalation">): string {
  const { file, text } = config.escalation
  if (file) {
    try {
      const content = readFileSync(expandHome(file), "utf8").trim()
      if (content) return content.slice(0, ESCALATION_MAX_CHARS)
      log("warn", "escalation file is empty — using the default instruction", { file })
    } catch (e) {
      log("warn", "escalation file unreadable — using the default instruction", { file, error: String(e) })
    }
    return DEFAULT_ESCALATION
  }
  return text.trim() ? text.trim().slice(0, ESCALATION_MAX_CHARS) : DEFAULT_ESCALATION
}

function pairs(questions: QuestionInfo[], replies: string[][]): string {
  return questions
    .map((q, i) => `"${q.question}"="${replies[i]?.length ? replies[i]!.join(", ") : "Unanswered"}"`)
    .join(", ")
}

/**
 * The tool output. Every question answered: the built-in tool's wording.
 * A human needed: the answers, then "don't decide these yourself" and the
 * playbook. Otherwise (unconfident questions the agent may decide): the
 * answers, then an instruction to decide those itself and say so.
 */
export function formatOutput(
  questions: QuestionInfo[],
  replies: string[][],
  record: Pick<ResultRecord, "questions" | "humanNeeded">,
  playbook: () => string = () => DEFAULT_ESCALATION,
): string {
  const results = record.questions ?? []
  const answered = results.filter((q) => q.outcome === "answered").length
  if (answered === questions.length) {
    return `User has answered your questions: ${pairs(questions, replies)}. You can now continue with the user's answers in mind.`
  }
  const head = `Auto-answered ${answered} of ${questions.length} question${questions.length > 1 ? "s" : ""}: ${pairs(questions, replies)}.`
  if (record.humanNeeded) {
    return [
      head,
      "",
      `A human must decide the questions answered with ${HUMAN_GATE_UNANSWERED}: or ${NO_SECOND_OPINION}:. Do not decide them yourself and do not act on a guess about them.`,
      "",
      playbook(),
    ].join("\n")
  }
  return [
    head,
    "",
    `The questions answered with ${NO_SECOND_OPINION}: got no confident answer. Decide them yourself from the evidence, and say in your reply that you did.`,
  ].join("\n")
}

/**
 * The stable summary in the tool part's metadata (`autoQuestion`), for tools
 * that judge a finished session. Its shape only changes with a new `v`.
 */
export function contractMetadata(record: ResultRecord): Record<string, unknown> {
  const results = record.questions ?? []
  return {
    v: 1,
    outcome: record.outcome,
    answered: results.filter((q) => q.outcome === "answered").length,
    total: results.length,
    humanGate: results.some((q) => q.outcome === "gated"),
    humanNeeded: record.humanNeeded === true,
  }
}

/** True when `agent` is one of the plugin's own subagents, which must never ask. */
function isInternalAgent(agent: string | undefined, config: Config): boolean {
  if (!agent) return false
  const a = agent.toLowerCase()
  return a === config.contextGathering.agent.toLowerCase() || a === config.agentDecision.agent.toLowerCase()
}

/** Decide one headless question call and return its record; never waits for a human. */
export async function runHeadlessQuestion(
  deps: HandlerDeps,
  questions: QuestionInfo[],
  ctx: Pick<ToolContext, "sessionID" | "agent" | "directory"> & { messageID?: string; callID?: string },
): Promise<ResultRecord> {
  const request: QuestionRequest = {
    id: `hq_${randomUUID()}`,
    sessionID: ctx.sessionID,
    questions,
    ...(ctx.messageID ? { tool: { messageID: ctx.messageID, ...(ctx.callID ? { callID: ctx.callID } : {}) } } : {}),
  }
  const agent = ctx.agent || undefined
  log("info", "question asked (headless)", { requestID: request.id, sessionID: request.sessionID, agent, questions: questions.length })

  let slots = questions.map(pendingSlot)
  const gate = humanGateReason(agent, request, deps.config)
  if (gate) {
    markAll(slots, "gated", gate, `${HUMAN_GATE_UNANSWERED}: ${gate}`)
  } else if (isInternalAgent(agent, deps.config)) {
    const reason = `agent "${agent}" is internal to auto-question and may not ask questions`
    markAll(slots, "deferred", reason, `${NO_SECOND_OPINION}: deferred — ${reason}`)
  } else {
    let config: Config | null = null
    try {
      config = configForAgent(deps.config, agent)
    } catch (e) {
      log("error", "profile config invalid", { requestID: request.id, agent, error: String(e) })
      const reason = "profile config invalid"
      markAll(slots, "deferred", reason, `${NO_SECOND_OPINION}: deferred — ${reason}`)
    }
    if (config) {
      const askerModel = await deps.tracker.resolveModel(deps.input.client, ctx.sessionID)
      config = avoidAskerModel(config, askerModel, request.id)
      const scoped: HandlerDeps = { ...deps, config, projectDir: ctx.directory || deps.projectDir }
      const timeoutMs = config.handlerTimeoutMs
      const work = decidePerQuestion(scoped, request, slots).catch((e) => {
        log("error", "headless decision failed", { requestID: request.id, error: String(e) })
      })
      if ((await withTimeout(work, timeoutMs)) === "timeout") {
        // Keep what was already decided; the work runs on but its late results are dropped.
        slots = slots.map((s) => ({ ...s, answer: s.answer ? [...s.answer] : null, reply: [...s.reply] }))
        const secs = Math.round(timeoutMs / 1000)
        for (const s of slots) {
          if (s.done) continue
          s.done = true
          s.outcome = "timeout"
          s.reason = `handler timed out after ${secs}s`
          s.reply = [`${NO_SECOND_OPINION}: deferred (handler timed out after ${secs}s)`]
        }
        log("warn", "handler timed out (headless)", { requestID: request.id })
      }
      for (const s of slots) {
        if (s.done) continue
        // Only if deciding threw before reaching a question.
        s.done = true
        s.reason = "decision failed"
        s.reply = [`${NO_SECOND_OPINION}: deferred — decision failed`]
      }
    }
  }

  const record = buildHeadlessResult(request, slots, agent, agentConfig(deps.config, agent).escalation.deferred)
  ;(deps.recordResult ?? appendResult)(record)
  log("info", "headless question", {
    requestID: request.id,
    sessionID: request.sessionID,
    agent,
    outcome: record.outcome,
    answered: `${record.questions!.filter((q) => q.outcome === "answered").length}/${questions.length}`,
    humanNeeded: record.humanNeeded,
  })
  return record
}

/** The agent's profile merged over the config, or the config itself if the profile is invalid. */
function agentConfig(config: Config, agent: string | undefined): Config {
  try {
    return configForAgent(config, agent)
  } catch {
    return config
  }
}

/** The `question` tool registered through the plugin's `tool` hook in headless mode. */
export function headlessQuestionTool(deps: HandlerDeps): ToolDefinition {
  const definition = {
    description: DESCRIPTION,
    args: ARGS,
    async execute(raw: unknown, ctx: ToolContext): Promise<ToolResult> {
      const questions = parseQuestionArgs(raw)
      const record = await runHeadlessQuestion(deps, questions, ctx)
      let replies = record.questions!.map((q) => q.reply)
      const scoped = agentConfig(deps.config, ctx.agent || undefined)
      if (scoped.resultTrailer) replies = withTrailer(replies, formatTrailer(record))
      const answered = record.questions!.filter((q) => q.outcome === "answered").length
      const status = record.humanNeeded ? "human needed" : `auto-answered ${answered}/${questions.length}`
      return {
        title: `Asked ${questions.length} question${questions.length > 1 ? "s" : ""} (${status})`,
        output: formatOutput(questions, replies, record, () => escalationPlaybook(scoped)),
        metadata: { answers: replies, autoQuestion: contractMetadata(record), result: record },
      }
    },
  }
  return definition as unknown as ToolDefinition
}

/**
 * Headless mode lets every agent ask: `question: allow` globally (unless the
 * opencode config sets a global question rule) and on each defined agent
 * without its own question rule, so subagents can ask too. Human-gated
 * agents are left alone, and the plugin's own subagents get an explicit
 * deny so they can never ask. Run after the bundled agents are registered.
 */
export function allowQuestionHeadless(
  opencodeConfig: { permission?: unknown; agent?: Record<string, unknown> },
  config: Pick<Config, "humanGatedAgents" | "contextGathering" | "agentDecision">,
): { global: "added" | "kept" | "blanket"; allowed: string[]; kept: string[]; gated: string[]; denied: string[] } {
  const out = { global: "added" as "added" | "kept" | "blanket", allowed: [] as string[], kept: [] as string[], gated: [] as string[], denied: [] as string[] }
  const p = opencodeConfig.permission
  if (p === undefined || p === null) opencodeConfig.permission = { [QUESTION_TOOL]: "allow" }
  else if (typeof p !== "object" || Array.isArray(p)) out.global = "blanket"
  else if (QUESTION_TOOL in p) out.global = "kept"
  else (p as Record<string, unknown>)[QUESTION_TOOL] = "allow"

  for (const [name, def] of Object.entries(opencodeConfig.agent ?? {})) {
    if (isHumanGatedAgent(name, config.humanGatedAgents)) {
      out.gated.push(name)
      continue
    }
    if (def === null || typeof def !== "object" || Array.isArray(def)) {
      out.kept.push(name)
      continue
    }
    const action = isInternalAgent(name, config as Config) ? "deny" : "allow"
    const agent = def as Record<string, unknown>
    const perm = agent.permission
    if (perm === undefined || perm === null) {
      agent.permission = { [QUESTION_TOOL]: action }
    } else if (typeof perm !== "object" || Array.isArray(perm) || QUESTION_TOOL in perm) {
      out.kept.push(name)
      continue
    } else {
      // Added last, so it wins over a "*" rule earlier in the same block.
      ;(perm as Record<string, unknown>)[QUESTION_TOOL] = action
    }
    ;(action === "allow" ? out.allowed : out.denied).push(name)
  }
  return out
}
