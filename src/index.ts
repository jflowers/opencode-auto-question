import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import { loadConfig } from "./config"
import { AgentTracker } from "./detect"
import { handleQuestionAsked, type HandlerDeps } from "./orchestrator"
import { log, setVerbose } from "./log"
import type { QuestionRequest } from "./types"

const SETTLED_MAX = 1000

interface EventPayload {
  id?: string
  type?: string
  properties?: any
}

function normalizeRequest(properties: any): QuestionRequest | null {
  if (!properties || typeof properties.id !== "string" || typeof properties.sessionID !== "string") return null
  if (!Array.isArray(properties.questions)) return null
  const questions = properties.questions.filter(
    (q: any) => q && typeof q.question === "string" && Array.isArray(q.options),
  )
  if (questions.length === 0) return null
  return { id: properties.id, sessionID: properties.sessionID, questions, tool: properties.tool }
}

function onEvent(deps: HandlerDeps, inflight: Set<string>, event: EventPayload): void {
  const { type, properties } = event
  if (!type) return

  switch (type) {
    case "message.updated":
      deps.tracker.trackMessage(properties?.info)
      break

    case "question.asked":
    case "question.v2.asked": {
      const request = normalizeRequest(properties)
      if (!request) {
        log("debug", "unrecognized question event payload", { type })
        return
      }
      if (inflight.has(request.id) || deps.settled.has(request.id)) return
      inflight.add(request.id)
      const version = type === "question.asked" ? "v1" : "v2"
      void handleQuestionAsked(deps, request, version).finally(() => inflight.delete(request.id))
      break
    }

    case "question.replied":
    case "question.rejected":
    case "question.v2.replied":
    case "question.v2.rejected": {
      const requestID = properties?.requestID ?? properties?.id
      if (typeof requestID === "string") {
        deps.settled.add(requestID)
        if (deps.settled.size > SETTLED_MAX) {
          for (const id of deps.settled) {
            deps.settled.delete(id)
            if (deps.settled.size <= SETTLED_MAX / 2) break
          }
        }
      }
      break
    }
  }
}

const plugin: Plugin = async (input) => {
  let config
  try {
    config = loadConfig()
  } catch (e) {
    log("warn", "config load failed — plugin inert", { error: String(e) })
    return {}
  }
  if (!config.enabled) {
    log("info", "auto-question disabled via config")
    return {}
  }

  setVerbose(config.verbose)
  log("info", "auto-question plugin loaded", {
    agents: config.agents,
    engine: config.engine,
    confidenceThreshold: config.confidenceThreshold,
    fallbackThreshold: config.fallbackThreshold,
  })

  const deps: HandlerDeps = {
    input,
    config,
    tracker: new AgentTracker(),
    settled: new Set<string>(),
  }
  const inflight = new Set<string>()

  return {
    event: async ({ event }) => {
      try {
        onEvent(deps, inflight, event)
      } catch (e) {
        log("error", "event handler error", { error: String(e) })
      }
    },
    dispose: async () => {
      log("info", "auto-question plugin disposed")
    },
  }
}

export default { id: "auto-question", server: plugin } satisfies PluginModule
