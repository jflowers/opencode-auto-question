import { randomUUID } from "node:crypto"
import type { ToolContext, ToolDefinition, ToolResult } from "@opencode-ai/plugin"
import { configForAgent } from "./config"
import { isHumanGatedAgent, isHumanGatedRequest } from "./gate"
import { appendResult, log } from "./log"
import { avoidAskerModel } from "./model"
import { decideOutcome, type HandlerDeps, type Outcome } from "./orchestrator"
import { buildResult, compactResult, type ResultRecord } from "./result"
import type { QuestionInfo, QuestionRequest } from "./types"

/** Name the tool is registered under (and the permission key that allows it). */
export const SECOND_OPINION_TOOL = "second_opinion"

/** Heading for the caller's facts in engine and agent prompts. */
const FACTS_LABEL = "Case facts supplied by the asking agent (its own reasoning and recommendation are deliberately left out):"

export interface SecondOpinionArgs {
  question: string
  options: Array<{ label: string; description?: string }>
  facts: string
}

const DESCRIPTION = [
  "Get an independent second opinion on a decision before acting on it.",
  "Give the question, the options, and only the case facts: the evidence another reviewer needs (repo, failing check, PRs, log lines).",
  "Leave out your own reasoning and recommendation, so the second opinion is not anchored on them.",
  "Returns JSON: {outcome, answer, confidence, pass, engine, model, rationale, reason}.",
  'answer is the chosen option label, or null when no confident answer was reached (see reason). It never asks a human.',
].join(" ")

/**
 * Argument schema as plain JSON Schema. opencode 1.19 passes non-Zod plugin
 * args through as-is (every property required, no validation), which keeps
 * the plugin free of a runtime Zod dependency; execute() validates instead.
 */
const ARGS = {
  question: { type: "string", description: "The decision to make, as one question." },
  options: {
    type: "array",
    minItems: 2,
    description: "The possible answers. The second opinion picks exactly one label.",
    items: {
      type: "object",
      properties: {
        label: { type: "string", description: "Short option label, returned as the answer." },
        description: { type: "string", description: "What choosing this option means." },
      },
      required: ["label"],
    },
  },
  facts: {
    type: "string",
    description: "The case facts only: no reasoning, no recommendation. Empty string if there are none.",
  },
}

/** Validate and normalize tool arguments; throws with a message the calling model can act on. */
export function parseSecondOpinionArgs(raw: unknown): SecondOpinionArgs {
  const a = (raw ?? {}) as Record<string, unknown>
  if (typeof a.question !== "string" || a.question.trim() === "") throw new Error("question must be a non-empty string")
  if (!Array.isArray(a.options) || a.options.length < 2) throw new Error("options must be an array of at least 2 options")
  const options = a.options.map((o, i) => {
    const opt = (o ?? {}) as Record<string, unknown>
    if (typeof opt.label !== "string" || opt.label.trim() === "") throw new Error(`options[${i}].label must be a non-empty string`)
    if (opt.description !== undefined && typeof opt.description !== "string") {
      throw new Error(`options[${i}].description must be a string`)
    }
    return { label: opt.label.trim(), ...(opt.description ? { description: opt.description } : {}) }
  })
  const labels = new Set(options.map((o) => o.label.toLowerCase()))
  if (labels.size !== options.length) throw new Error("option labels must be unique")
  if (a.facts !== undefined && typeof a.facts !== "string") throw new Error("facts must be a string")
  return { question: a.question.trim(), options, facts: typeof a.facts === "string" ? a.facts.trim() : "" }
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms)
  })
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer))
}

/**
 * Run the decision pipeline for one second_opinion call and return its
 * record. The engine and context subagent see only the question, options
 * and facts — never the caller's message — and nothing waits for a human.
 */
export async function runSecondOpinion(
  deps: HandlerDeps,
  args: SecondOpinionArgs,
  ctx: Pick<ToolContext, "sessionID" | "agent" | "directory">,
): Promise<ResultRecord> {
  const info: QuestionInfo = {
    question: args.question,
    header: "Second opinion",
    options: args.options.map((o) => ({ label: o.label, description: o.description ?? "" })),
    multiple: false,
    custom: false,
  }
  // No tool.messageID: the asking message is never fetched.
  const request: QuestionRequest = { id: `so_${randomUUID()}`, sessionID: ctx.sessionID, questions: [info] }
  const agent = ctx.agent || undefined

  let outcome: Outcome
  if (isHumanGatedAgent(agent, deps.config.humanGatedAgents)) {
    outcome = { kind: "gated", reason: `agent "${agent}" is human-gated` }
  } else if (isHumanGatedRequest(request)) {
    outcome = { kind: "gated", reason: "question carries the HUMAN_GATE: marker" }
  } else {
    const askerModel = await deps.tracker.resolveModel(deps.input.client, ctx.sessionID)
    const config = avoidAskerModel(configForAgent(deps.config, agent), askerModel, request.id)
    const scoped: HandlerDeps = { ...deps, config, projectDir: ctx.directory || deps.projectDir }
    const timeoutMs = scoped.config.handlerTimeoutMs
    const result = await withTimeout(
      decideOutcome(scoped, request, { text: args.facts || null, label: FACTS_LABEL }),
      timeoutMs,
    )
    outcome = result === "timeout" ? { kind: "timeout", timeoutMs } : result
  }

  const record = buildResult(request, outcome, agent, deps.config.onDefer)
  record.source = "second_opinion"
  record.action = "returned"
  ;(deps.recordResult ?? appendResult)(record)
  log("info", "second opinion", {
    requestID: request.id,
    sessionID: request.sessionID,
    agent,
    outcome: record.outcome,
    answer: record.answer,
    confidence: record.confidence,
    pass: record.pass,
  })
  return record
}

/** The tool definition registered through the plugin's `tool` hook. */
export function secondOpinionTool(deps: HandlerDeps): ToolDefinition {
  const definition = {
    description: DESCRIPTION,
    args: ARGS,
    async execute(raw: unknown, ctx: ToolContext): Promise<ToolResult> {
      const args = parseSecondOpinionArgs(raw)
      const record = await runSecondOpinion(deps, args, ctx)
      const output = JSON.stringify(compactResult(record))
      const title = record.answer === null ? `second opinion: none (${record.outcome})` : `second opinion: ${record.answer}`
      return { title, output, metadata: { result: record } }
    },
  }
  // The SDK types args as a Zod shape; plain JSON Schema is the supported
  // non-Zod form (see ARGS).
  return definition as unknown as ToolDefinition
}

/**
 * With the tool enabled, deny it globally unless the user configured a
 * global rule, so only agents that allow it (`second_opinion: allow`) see it.
 * Returns what it did, for the log.
 */
export function defaultDenySecondOpinion(opencodeConfig: { permission?: unknown }): "added" | "kept" | "blanket" {
  const p = opencodeConfig.permission
  if (p === undefined || p === null) {
    opencodeConfig.permission = { [SECOND_OPINION_TOOL]: "deny" }
    return "added"
  }
  if (typeof p !== "object" || Array.isArray(p)) return "blanket"
  const perm = p as Record<string, unknown>
  if (SECOND_OPINION_TOOL in perm) return "kept"
  perm[SECOND_OPINION_TOOL] = "deny"
  return "added"
}
