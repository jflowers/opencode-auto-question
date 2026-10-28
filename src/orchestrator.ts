import type { Config, Decision, QuestionRequest } from "./types"
import type { Plugin } from "@opencode-ai/plugin"
import { AgentTracker, isAutonomousAgent } from "./detect"
import { gatherContext } from "./context"
import { decideWithJev, resolveJevCarrier } from "./engines/jev"
import { decideWithLlm } from "./engines/llm"
import { log } from "./log"

type PluginInput = Parameters<Plugin>[0]

export interface HandlerDeps {
  input: PluginInput
  config: Config
  tracker: AgentTracker
  settled: Set<string>
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms)
  })
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer))
}

function minConfidence(decision: Decision): number {
  if (decision.confidences.length === 0) return 0
  return Math.min(...decision.confidences)
}

async function decide(config: Config, questions: QuestionRequest["questions"], context: string | null): Promise<Decision> {
  const order = config.engine === "auto" ? (["jev", "llm"] as const) : ([config.engine] as const)
  let last: Decision | undefined

  for (const engine of order) {
    if (engine === "jev") {
      if (!resolveJevCarrier(config)) {
        last = {
          ok: false,
          answers: [],
          confidences: [],
          engine: "jev",
          error: "jev unavailable: no apiKey in config and no OPENCODE_API_KEY / OPENROUTER_API_KEY in env",
        }
        continue
      }
      const decision = await decideWithJev(config, questions, context)
      if (decision.ok) return decision
      last = decision
      log("warn", "jev decision failed", { error: decision.error })
    } else {
      const decision = await decideWithLlm(config, questions, context)
      if (decision.ok) return decision
      last = decision
      log("warn", "llm decision failed", { error: decision.error })
    }
  }

  return last ?? { ok: false, answers: [], confidences: [], engine: "llm", error: "no engine ran" }
}

function logDecision(pass: string, requestID: string, decision: Decision): void {
  if (decision.ok) {
    log("info", `decision ${pass}`, {
      requestID,
      engine: decision.engine,
      answers: decision.answers,
      confidences: decision.confidences,
      minConfidence: minConfidence(decision),
    })
  } else {
    log("warn", `decision ${pass} failed`, { requestID, engine: decision.engine, error: decision.error })
  }
}

async function reply(deps: HandlerDeps, request: QuestionRequest, decision: Decision, version: "v1" | "v2", pass: string): Promise<void> {
  const httpClient = (deps.input.client as any)._client
  const url =
    version === "v1"
      ? `/question/${request.id}/reply`
      : `/api/session/${request.sessionID}/question/${request.id}/reply`
  try {
    await httpClient.post({ url, body: { answers: decision.answers } })
    log("info", "auto-answered", {
      requestID: request.id,
      sessionID: request.sessionID,
      engine: decision.engine,
      pass,
      answers: decision.answers,
      confidences: decision.confidences,
    })
  } catch (e) {
    // The human likely answered first (request removed from the pending map → 404).
    log("warn", "reply failed — human may have answered first", { requestID: request.id, error: String(e) })
  }
}

/** Max characters of immediate context to include (safety valve for huge messages). */
const IMMEDIATE_CONTEXT_MAX_CHARS = 20_000

/**
 * Fetch the text parts of the assistant message that triggered the question
 * tool call. This contains the model's reasoning, tables, recommendations —
 * everything the human would see above the form in the TUI.
 */
async function getImmediateContext(httpClient: any, request: QuestionRequest): Promise<string | null> {
  const messageID = request.tool?.messageID
  if (!messageID) return null
  try {
    const result = await httpClient.get({ url: `/session/${request.sessionID}/message` })
    const messages: any[] = result?.data ?? []
    const msg = messages.find((m: any) => m?.info?.id === messageID)
    if (!msg || !Array.isArray(msg.parts)) return null
    const texts = msg.parts
      .filter((p: any) => p?.type === "text" && typeof p.text === "string")
      .map((p: any) => p.text as string)
    let joined = texts.join("\n").trim()
    if (!joined) return null
    if (joined.length > IMMEDIATE_CONTEXT_MAX_CHARS) {
      joined = joined.slice(-IMMEDIATE_CONTEXT_MAX_CHARS)
    }
    return joined
  } catch (e) {
    log("debug", "failed to fetch immediate context", { error: String(e) })
    return null
  }
}

async function decideAndReply(deps: HandlerDeps, request: QuestionRequest, version: "v1" | "v2"): Promise<void> {
  const { config } = deps

  // Fetch the model's reasoning text from the same assistant message that
  // called the question tool — tables, recommendations, detailed options, etc.
  let immediateCtx: string | null = null
  if (config.immediateContext) {
    const httpClient = (deps.input.client as any)._client
    immediateCtx = await getImmediateContext(httpClient, request)
    if (immediateCtx) {
      log("debug", "fetched immediate context", { requestID: request.id, chars: immediateCtx.length })
    }
  }

  // Pass 1: decide with immediate context (model reasoning) only.
  const pass1Context = immediateCtx
    ? `Agent's reasoning before asking:\n${immediateCtx}`
    : null
  let decision = await decide(config, request.questions, pass1Context)
  logDecision("pass 1", request.id, decision)

  if (decision.ok && minConfidence(decision) >= config.confidenceThreshold) {
    await reply(deps, request, decision, version, "pass 1")
    return
  }

  // Pass 2: gather additional context with a subagent, combine with immediate
  // context, and re-decide. A pass-2 decision supersedes pass 1; if pass 2
  // errors, pass 1 is kept for thresholding.
  log("info", "low confidence — gathering context", {
    requestID: request.id,
    minConfidence: decision.ok ? minConfidence(decision) : null,
    threshold: config.confidenceThreshold,
  })
  const gathered = await gatherContext(deps.input, config, request)
  let pass = "pass 1 (no gathered context)"
  if (gathered || immediateCtx) {
    const parts: string[] = []
    if (immediateCtx) parts.push(`Agent's reasoning before asking:\n${immediateCtx}`)
    if (gathered) parts.push(`Additional context from knowledge sources:\n${gathered}`)
    const combinedContext = parts.join("\n\n")

    const second = await decide(config, request.questions, combinedContext)
    if (second.ok) {
      decision = second
      pass = "pass 2"
    }
    logDecision("pass 2", request.id, second)
  }

  if (decision.ok && minConfidence(decision) >= config.fallbackThreshold) {
    await reply(deps, request, decision, version, pass)
    return
  }

  log("info", "below fallback threshold — leaving for human", {
    requestID: request.id,
    minConfidence: decision.ok ? minConfidence(decision) : null,
    threshold: config.fallbackThreshold,
  })
}

/** Entry point for question.asked / question.v2.asked events. Fire-and-forget. */
export async function handleQuestionAsked(
  deps: HandlerDeps,
  request: QuestionRequest,
  version: "v1" | "v2",
): Promise<void> {
  const { input, config, tracker, settled } = deps
  if (settled.has(request.id)) return

  const agent = await tracker.resolve(input.client, request.sessionID)
  log("info", "question asked", {
    requestID: request.id,
    sessionID: request.sessionID,
    agent,
    questions: request.questions.length,
  })

  if (!isAutonomousAgent(agent, config)) {
    log("debug", "session not autonomous — leaving for human", { requestID: request.id, agent })
    return
  }

  const outcome = await withTimeout(decideAndReply(deps, request, version), config.handlerTimeoutMs)
  if (outcome === "timeout") {
    log("warn", "handler timed out — leaving for human", { requestID: request.id })
  }
}
