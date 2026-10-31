import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Config } from "./types"

export class ConfigError extends Error {}

export function defaultConfigPath(): string {
  return join(homedir(), ".config", "opencode", "auto-question.jsonc")
}

export const DEFAULT_CONFIG: Config = {
  enabled: true,
  agents: ["autonomy"],
  engine: "auto",
  jev: {
    model: "typesafe/jev-1.14",
    baseUrl: "https://openrouter.ai/api/alpha/decisions",
    apiKey: "{env:OPENROUTER_API_KEY}",
    timeoutMs: 15_000,
  },
  llm: {
    baseUrl: "https://api.enmaas.devshift.net/v1",
    apiKey: "{env:ENMAAS_KEY}",
    model: "rits/zai-org/glm-5-3",
    timeoutMs: 60_000,
  },
  confidenceThreshold: 0.6,
  fallbackThreshold: 0.35,
  contextGathering: {
    agent: "auto-question-ctx",
    timeoutMs: 30_000,
  },
  agentDecision: {
    agent: "auto-question-decide",
    timeoutMs: 60_000,
  },
  guidance: {
    enabled: true,
    projectPath: ".opencode/auto-question/guidance",
    globalPath: "~/.config/opencode/auto-question/guidance",
    maxChars: 20_000,
  },
  immediateContext: true,
  sessionSummary: true,
  handlerTimeoutMs: 120_000,
  verbose: false,
}

/**
 * Strip line comments and block comments from JSONC text while preserving
 * comment-like sequences inside JSON strings.
 */
export function stripJsonComments(text: string): string {
  let result = ""
  let inString = false
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (inString) {
      result += ch
      if (ch === "\\") {
        result += text[i + 1] ?? ""
        i += 2
        continue
      }
      if (ch === '"') inString = false
      i++
      continue
    }
    if (ch === '"') {
      inString = true
      result += ch
      i++
      continue
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++
      continue
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++
      i += 2
      continue
    }
    result += ch
    i++
  }
  return result
}

/** Recursively replace `{env:VAR}` in string values with process.env.VAR. */
export function interpolateEnv(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => process.env[name] ?? "")
  }
  if (Array.isArray(value)) return value.map(interpolateEnv)
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = interpolateEnv(v)
    return out
  }
  return value
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(merged[key])) {
      merged[key] = deepMerge(merged[key] as Record<string, unknown>, value)
    } else {
      merged[key] = value
    }
  }
  return merged
}

/** Deep-merge user config over defaults. Arrays and scalars replace. */
export function mergeConfig(base: Config, override: Record<string, unknown>): Config {
  return deepMerge(base as unknown as Record<string, unknown>, override) as unknown as Config
}

function clamp01(n: unknown, fallback: number): number {
  const v = typeof n === "number" && Number.isFinite(n) ? n : fallback
  return Math.min(1, Math.max(0, v))
}

/** Load, parse, interpolate, and validate the plugin config. Throws ConfigError. */
export function loadConfig(path: string = defaultConfigPath()): Config {
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch {
    throw new ConfigError(`config file not readable: ${path}`)
  }

  let raw: unknown
  try {
    raw = JSON.parse(stripJsonComments(text))
  } catch (e) {
    throw new ConfigError(`config file is not valid JSONC: ${String(e)}`)
  }
  if (!isPlainObject(raw)) throw new ConfigError("config root must be an object")

  const config = mergeConfig(DEFAULT_CONFIG, interpolateEnv(raw) as Record<string, unknown>)

  if (typeof config.enabled !== "boolean") throw new ConfigError("enabled must be a boolean")
  if (!Array.isArray(config.agents) || config.agents.length === 0 || !config.agents.every((a) => typeof a === "string")) {
    throw new ConfigError("agents must be a non-empty array of strings")
  }
  if (config.engine !== "jev" && config.engine !== "llm" && config.engine !== "auto") {
    throw new ConfigError("engine must be one of: jev, llm, auto")
  }
  config.confidenceThreshold = clamp01(config.confidenceThreshold, 0.6)
  config.fallbackThreshold = clamp01(config.fallbackThreshold, 0.35)
  if (typeof config.handlerTimeoutMs !== "number" || config.handlerTimeoutMs < 1000) {
    config.handlerTimeoutMs = DEFAULT_CONFIG.handlerTimeoutMs
  }
  if (typeof config.verbose !== "boolean") config.verbose = false
  if (typeof config.immediateContext !== "boolean") config.immediateContext = true
  if (typeof config.sessionSummary !== "boolean") config.sessionSummary = true

  for (const engine of ["jev", "llm"] as const) {
    const block = config[engine]
    if (typeof block.baseUrl !== "string" || !block.baseUrl.startsWith("http")) {
      throw new ConfigError(`${engine}.baseUrl must be an http(s) URL`)
    }
    if (typeof block.model !== "string" || block.model.length === 0) {
      throw new ConfigError(`${engine}.model must be a non-empty string`)
    }
    if (typeof block.apiKey !== "string") block.apiKey = ""
    if (typeof block.timeoutMs !== "number" || block.timeoutMs < 1000) {
      block.timeoutMs = DEFAULT_CONFIG[engine].timeoutMs
    }
  }

  const cg = config.contextGathering
  if (typeof cg.agent !== "string" || cg.agent.length === 0) {
    throw new ConfigError("contextGathering.agent must be a non-empty string")
  }
  if (typeof cg.timeoutMs !== "number" || cg.timeoutMs < 1000) {
    cg.timeoutMs = DEFAULT_CONFIG.contextGathering.timeoutMs
  }

  const ad = config.agentDecision
  if (typeof ad.agent !== "string" || ad.agent.length === 0) {
    throw new ConfigError("agentDecision.agent must be a non-empty string")
  }
  if (typeof ad.timeoutMs !== "number" || ad.timeoutMs < 1000) {
    ad.timeoutMs = DEFAULT_CONFIG.agentDecision.timeoutMs
  }

  const g = config.guidance
  if (typeof g.enabled !== "boolean") g.enabled = true
  if (typeof g.projectPath !== "string" || g.projectPath.length === 0) {
    g.projectPath = DEFAULT_CONFIG.guidance.projectPath
  }
  if (typeof g.globalPath !== "string" || g.globalPath.length === 0) {
    g.globalPath = DEFAULT_CONFIG.guidance.globalPath
  }
  if (typeof g.maxChars !== "number" || g.maxChars < 1000) {
    g.maxChars = DEFAULT_CONFIG.guidance.maxChars
  }

  return config
}
