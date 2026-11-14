import { log } from "./log"
import type { Config } from "./types"

/** "provider/model" split at the first slash, or null when it has no provider part. */
export function parseModelRef(ref: string): { providerID: string; modelID: string } | null {
  const i = ref.indexOf("/")
  if (i <= 0 || i === ref.length - 1) return null
  return { providerID: ref.slice(0, i), modelID: ref.slice(i + 1) }
}

/**
 * The model's own name: the last path segment, lowercased, without an
 * OpenRouter variant suffix. "openrouter/z-ai/glm-5.3", "zai/glm-5.3" and
 * "z-ai/glm-5.3:free" are all "glm-5.3".
 */
function modelName(ref: string): string {
  const last = ref.trim().toLowerCase().split("/").pop() ?? ""
  return last.replace(/:[^:]*$/, "")
}

/** True when two model references name the same model, whichever provider serves it. */
export function sameModel(a: string, b: string): boolean {
  const x = modelName(a)
  return x !== "" && x === modelName(b)
}

/**
 * When the LLM engine's model is the asking session's own model, a second
 * opinion from it shares the asker's blind spots. Use the first of
 * `llm.alternateModels` that differs from the asker; with none, keep the
 * model and warn. Returns `config` itself when nothing changes.
 */
export function avoidAskerModel(config: Config, askerModel: string | undefined, requestID: string): Config {
  if (!askerModel || config.engine === "jev") return config
  if (!sameModel(config.llm.model, askerModel)) return config
  const alternate = config.llm.alternateModels.find((m) => !sameModel(m, askerModel))
  if (!alternate) {
    log("warn", "llm model is the asking session's own model — set llm.alternateModels for an independent opinion", {
      requestID,
      model: config.llm.model,
      askerModel,
    })
    return config
  }
  log("info", "llm model matches the asking session's — using an alternate", {
    requestID,
    askerModel,
    model: alternate,
    instead: config.llm.model,
  })
  return { ...config, llm: { ...config.llm, model: alternate } }
}
