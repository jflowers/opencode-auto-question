import type { Config, Decision, QuestionInfo } from "../types"
import { buildJevQuestions, parseJevResponse } from "../mapping"
import { log } from "../log"

const ZEN_BASE_URL = "https://opencode.ai/zen/v1/systemone"
// Paid tier works out of the box (~$0.000013/call). The free tier
// (jev-1.13-free) requires allowing free endpoints in the workspace's
// Privacy settings on opencode.ai.
const ZEN_MODEL = "jev-1.13"
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/alpha/decisions"
const OPENROUTER_MODEL = "typesafe/jev-1.14"

export interface JevCarrier {
  carrier: "config" | "zen" | "openrouter"
  baseUrl: string
  model: string
  apiKey: string
  note?: string
}

/**
 * Resolve which Jev carrier to use. Explicit non-empty config values always
 * win. Otherwise auto-discover from the environment: OpenCode Zen
 * (OPENCODE_API_KEY, jev-1.13) first, then OpenRouter
 * (OPENROUTER_API_KEY, typesafe/jev-1.14). Zen serves bare model IDs;
 * OpenRouter requires the provider-prefixed slug.
 *
 * Self-heal: an OpenRouter key (sk-or-...) accidentally placed in
 * OPENCODE_API_KEY would 401 at Zen — route it to OpenRouter instead and
 * surface a note so the mixup is visible in logs.
 */
export function resolveJevCarrier(config: Config): JevCarrier | null {
  if (config.jev.apiKey) {
    return { carrier: "config", baseUrl: config.jev.baseUrl, model: config.jev.model, apiKey: config.jev.apiKey }
  }
  const opencodeKey = process.env.OPENCODE_API_KEY
  if (opencodeKey) {
    if (opencodeKey.startsWith("sk-or-")) {
      return {
        carrier: "openrouter",
        baseUrl: OPENROUTER_BASE_URL,
        model: OPENROUTER_MODEL,
        apiKey: opencodeKey,
        note: "OPENCODE_API_KEY holds an OpenRouter key (sk-or-...); routing to OpenRouter. Put your Zen key in OPENCODE_API_KEY and this key in OPENROUTER_API_KEY.",
      }
    }
    return { carrier: "zen", baseUrl: ZEN_BASE_URL, model: ZEN_MODEL, apiKey: opencodeKey }
  }
  if (process.env.OPENROUTER_API_KEY) {
    return { carrier: "openrouter", baseUrl: OPENROUTER_BASE_URL, model: OPENROUTER_MODEL, apiKey: process.env.OPENROUTER_API_KEY }
  }
  return null
}

function buildState(context: string | null): string {
  const framing =
    "An autonomous AI coding agent is asking its user a clarifying question mid-task. Answer as the user would."
  return context ? `${framing}\n\nRelevant context:\n${context}` : framing
}

export async function decideWithJev(
  config: Config,
  questions: QuestionInfo[],
  context: string | null,
): Promise<Decision> {
  const carrier = resolveJevCarrier(config)
  if (!carrier) {
    return {
      ok: false,
      answers: [],
      confidences: [],
      engine: "jev",
      error: "jev unavailable: set jev.apiKey in config, or export OPENCODE_API_KEY (Zen) / OPENROUTER_API_KEY",
    }
  }

  const set = buildJevQuestions(questions)
  if (!set) {
    return { ok: false, answers: [], confidences: [], engine: "jev", error: "questions not mappable to Jev primitives" }
  }

  let json: { answers?: Record<string, unknown> }
  try {
    const response = await fetch(carrier.baseUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${carrier.apiKey}`,
      },
      body: JSON.stringify({ model: carrier.model, state: buildState(context), questions: set.questions }),
      signal: AbortSignal.timeout(config.jev.timeoutMs),
    })
    if (!response.ok) {
      const body = await response.text().catch(() => "")
      return {
        ok: false,
        answers: [],
        confidences: [],
        engine: "jev",
        error: `Jev API (${carrier.carrier}) ${response.status}: ${body.slice(0, 300)}`,
      }
    }
    json = (await response.json()) as { answers?: Record<string, unknown> }
  } catch (e) {
    return { ok: false, answers: [], confidences: [], engine: "jev", error: String(e) }
  }

  const parsed = parseJevResponse(set, questions, json.answers ?? {})
  if (!parsed) {
    log("debug", "jev response unparsable", { carrier: carrier.carrier, response: json })
    return { ok: false, answers: [], confidences: [], engine: "jev", error: "unparsable Jev response" }
  }

  return { ok: true, answers: parsed.answers, confidences: parsed.confidences, engine: "jev" }
}
