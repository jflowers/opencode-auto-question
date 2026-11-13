import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import { loadBundledAgents, registerAgents, type AgentDefinition } from "./agents"
import { existsSync } from "node:fs"
import { configSources, loadConfig } from "./config"
import { AgentTracker } from "./detect"
import { handleQuestionAsked, markSettled, type HandlerDeps } from "./orchestrator"
import { resolveJevCarrier } from "./engines/jev"
import { log, setVerbose } from "./log"
import type { QuestionRequest } from "./types"


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
        markSettled(deps.settled, requestID)
      }
      break
    }
  }
}

const plugin: Plugin = async (input) => {
  let config
  try {
    const sources = configSources()
    config = loadConfig(sources, (message) => log("error", "config problem — repaired", { message }))
    log("info", "config files", {
      loaded: sources.filter((s) => existsSync(s.path)).map((s) => s.path),
      missing: sources.filter((s) => !existsSync(s.path)).map((s) => s.path),
    })
  } catch (e) {
    log("error", "config load failed — plugin inert", { error: String(e) })
    return {}
  }
  if (!config.enabled) {
    log("info", "auto-question disabled via config")
    return {}
  }

  setVerbose(config.verbose)
  const jevCarrier = resolveJevCarrier(config)
  if (jevCarrier?.note) log("warn", "jev carrier note", { note: jevCarrier.note })
  log("info", "auto-question plugin loaded", {
    agents: config.agents,
    engine: config.engine,
    jev: jevCarrier ? `${jevCarrier.carrier} (${jevCarrier.model})` : "unavailable",
    confidenceThreshold: config.confidenceThreshold,
    fallbackThreshold: config.fallbackThreshold,
    profiles: Object.keys(config.profiles),
  })

  const deps: HandlerDeps = {
    input,
    config,
    tracker: new AgentTracker(),
    settled: new Set<string>(),
    projectDir: typeof input.directory === "string" ? input.directory : process.cwd(),
  }
  const inflight = new Set<string>()

  let bundledAgents: Record<string, AgentDefinition> | null = null
  if (config.registerAgents) {
    try {
      bundledAgents = loadBundledAgents()
    } catch (e) {
      // Not fatal: the plugin still answers for agents defined elsewhere.
      log("error", "bundled agents unreadable — not registering them", { error: String(e) })
    }
  }

  return {
    config: async (opencodeConfig) => {
      if (!bundledAgents) return
      try {
        const { added, filledIn } = registerAgents(opencodeConfig as { agent?: Record<string, unknown> }, bundledAgents)
        log("info", "bundled agents", { added, filledInUnderUserSettings: filledIn })
      } catch (e) {
        log("error", "agent registration failed", { error: String(e) })
      }
    },
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

const V2_UNSUPPORTED =
  "auto-question supports opencode 1.x only for now; on this opencode (v2 plugin API) it is installed but inactive. " +
  "Questions are left for a human."

/**
 * opencode v2 entry point. v2 replaced the question tool's events with forms,
 * and its plugin context does not expose replying to a form, so there is
 * nothing to hook yet. Say so loudly rather than load silently and do nothing.
 */
async function setup(_ctx: unknown): Promise<void> {
  log("warn", V2_UNSUPPORTED)
  console.warn(`[auto-question] ${V2_UNSUPPORTED}`)
}

/**
 * One package for both plugin APIs, following opencode-dcp: 1.x hosts call
 * `server`, v2 hosts call `setup`.
 */
export default { id: "auto-question", server: plugin, setup } satisfies PluginModule & {
  setup: (ctx: unknown) => Promise<void>
}
