import type { Config, Decision, QuestionRequest } from "./types"
import type { Plugin } from "@opencode-ai/plugin"
import { AgentTracker, isAutonomousAgent } from "./detect"
import { gatherContext } from "./context"
import { decideWithJev } from "./engines/jev"
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
      if (!config.jev.apiKey) {
        last = { ok: false, answers: [], confidences: [], engine: "jev", error: "jev apiKey missing" }
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

async function decideAndReply(deps: HandlerDeps, request: QuestionRequest, version: "v1" | "v2"): Promise<void> {
  const { config } = deps

  // Pass 1: fast decision, no context.
  let decision = await decide(config, request.questions, null)
  logDecision("pass 1", request.id, decision)

  if (decision.ok && minConfidence(decision) >= config.confidenceThreshold) {
    await reply(deps, request, decision, version, "pass 1")
    return
  }

  // Pass 2: gather context with a subagent, re-decide. A pass-2 decision
  // supersedes pass 1; if pass 2 errors, pass 1 is kept for thresholding.
  log("info", "low confidence — gathering context", {
    requestID: request.id,
    minConfidence: decision.ok ? minConfidence(decision) : null,
    threshold: config.confidenceThreshold,
  })
  const context = await gatherContext(deps.input, config, request)
  let pass = "pass 1 (no context)"
  if (context) {
    const second = await decide(config, request.questions, context)
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
