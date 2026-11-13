import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { PROFILE_KEYS, type Config, type ProfileConfig } from "./types"
import { BUILTIN_HUMAN_GATED_AGENTS, gatedAgentOverlap, isHumanGatedAgent, mergeGatedAgents } from "./gate"

export class ConfigError extends Error {}

export const CONFIG_FILE_NAME = "auto-question.jsonc"

export function defaultConfigPath(): string {
  return join(homedir(), ".config", "opencode", CONFIG_FILE_NAME)
}

/** One config file to load, in order. Later files win. */
export interface ConfigSource {
  path: string
  /** A missing required file is an error; a missing optional one is skipped. */
  required: boolean
}

/**
 * The config files to load, lowest precedence first.
 *
 * - `AUTO_QUESTION_CONFIG` names one file, used alone over the defaults
 *   (neither the global file nor the config dir is read). It must exist.
 * - Otherwise the global file, then `$OPENCODE_CONFIG_DIR/auto-question.jsonc`
 *   when that variable is set. Either may be missing.
 */
export function configSources(env: Record<string, string | undefined> = process.env): ConfigSource[] {
  const explicit = env.AUTO_QUESTION_CONFIG?.trim()
  if (explicit) return [{ path: resolve(expandHome(explicit)), required: true }]
  const sources: ConfigSource[] = [{ path: defaultConfigPath(), required: false }]
  const configDir = env.OPENCODE_CONFIG_DIR?.trim()
  if (configDir) {
    const path = resolve(expandHome(configDir), CONFIG_FILE_NAME)
    if (path !== defaultConfigPath()) sources.push({ path, required: false })
  }
  return sources
}

function expandHome(p: string): string {
  if (p === "~" || p.startsWith("~/")) return join(homedir(), p.slice(2))
  return p
}

export const DEFAULT_CONFIG: Config = {
  enabled: true,
  agents: ["autonomy"],
  humanGatedAgents: [...BUILTIN_HUMAN_GATED_AGENTS],
  engine: "auto",
  jev: {
    model: "typesafe/jev-1.14",
    baseUrl: "https://openrouter.ai/api/alpha/decisions",
    apiKey: "{env:OPENROUTER_API_KEY}",
    timeoutMs: 15_000,
  },
  llm: {
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: "{env:OPENROUTER_API_KEY}",
    model: "openrouter/auto",
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
  registerAgents: true,
  profiles: {},
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

/**
 * Read one config file: parsed, interpolated, with a relative
 * `guidance.globalPath` resolved against the file's own directory (so a
 * config dir can ship its guidance next to it). `guidance.projectPath` stays
 * relative to the project. Returns null for a missing optional file.
 */
export function readConfigFile(source: ConfigSource): Record<string, unknown> | null {
  const { path } = source
  // No config file is a supported setup (an npm install with only an API key
  // in the environment): run on the defaults. A file that exists but can't be
  // read is still an error.
  if (!existsSync(path)) {
    if (source.required) throw new ConfigError(`config file not found: ${path} (from AUTO_QUESTION_CONFIG)`)
    return null
  }
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
    throw new ConfigError(`config file is not valid JSONC (${path}): ${String(e)}`)
  }
  if (!isPlainObject(raw)) throw new ConfigError(`config root must be an object (${path})`)

  const values = interpolateEnv(raw) as Record<string, unknown>
  const dir = dirname(path)
  resolveGlobalPath(values, dir)
  if (isPlainObject(values.profiles)) {
    for (const profile of Object.values(values.profiles)) {
      if (isPlainObject(profile)) resolveGlobalPath(profile, dir)
    }
  }
  return values
}

/** Resolve a relative `guidance.globalPath` in `block` against `dir`, in place. */
function resolveGlobalPath(block: Record<string, unknown>, dir: string): void {
  const guidance = block.guidance
  if (!isPlainObject(guidance) || typeof guidance.globalPath !== "string") return
  const p = guidance.globalPath
  if (p.length > 0 && !isAbsolute(p) && p !== "~" && !p.startsWith("~/")) {
    block.guidance = { ...guidance, globalPath: resolve(dir, p) }
  }
}

/**
 * Load, parse, interpolate, and validate the plugin config. Throws ConfigError
 * for invalid config. Problems the loader can repair without weakening a
 * guarantee are repaired and reported through `warn` instead, so one bad entry
 * does not turn the whole plugin off.
 *
 * `sources` defaults to configSources(): the global file, then the
 * OPENCODE_CONFIG_DIR file, each deep-merged over the last. A single path is
 * one optional file.
 */
export function loadConfig(
  sources: string | ConfigSource[] = configSources(),
  warn: (message: string) => void = () => {},
): Config {
  const list = typeof sources === "string" ? [{ path: sources, required: false }] : sources
  let config = structuredClone(DEFAULT_CONFIG)
  for (const source of list) {
    const values = readConfigFile(source)
    if (values) config = mergeConfig(config, values)
  }

  if (typeof config.enabled !== "boolean") throw new ConfigError("enabled must be a boolean")
  if (!Array.isArray(config.agents) || config.agents.length === 0 || !config.agents.every((a) => typeof a === "string")) {
    throw new ConfigError("agents must be a non-empty array of strings")
  }
  if (!Array.isArray(config.humanGatedAgents) || !config.humanGatedAgents.every((a) => typeof a === "string")) {
    throw new ConfigError("humanGatedAgents must be an array of strings")
  }
  // The built-in gated agents cannot be removed by configuration.
  config.humanGatedAgents = mergeGatedAgents(BUILTIN_HUMAN_GATED_AGENTS, config.humanGatedAgents)
  // A gated agent listed for auto-answering is dropped, not fatal: failing the
  // whole load would leave every other agent's questions unanswered too (a
  // fleet-wide stall for unattended sessions). Dropping it keeps the gate.
  const overlap = gatedAgentOverlap(config.agents, config.humanGatedAgents)
  if (overlap.length > 0) {
    config.agents = config.agents.filter((a) => !isHumanGatedAgent(a, config.humanGatedAgents))
    warn(
      `agents includes human-gated agent(s) ${overlap.map((a) => JSON.stringify(a)).join(", ")}: ` +
        "their questions are deliberate human gates and are never auto-answered, so " +
        `${overlap.length === 1 ? "it was" : "they were"} ignored. ` +
        `Remove ${overlap.length === 1 ? "it" : "them"} from "agents" in the auto-question config.` +
        (config.agents.length === 0 ? " No auto-answered agents remain." : ""),
    )
  }
  if (typeof config.verbose !== "boolean") config.verbose = false
  if (typeof config.registerAgents !== "boolean") throw new ConfigError("registerAgents must be a boolean")
  normalizeBehavior(config, "")

  config.profiles = normalizeProfiles(config, warn)
  return config
}

/**
 * Validate and repair the keys a profile can override, in place. Throws
 * ConfigError for values that cannot be repaired; `prefix` names the profile
 * in the message.
 */
function normalizeBehavior(c: Config, prefix: string): void {
  if (c.engine !== "jev" && c.engine !== "llm" && c.engine !== "auto") {
    throw new ConfigError(prefix + "engine must be one of: jev, llm, auto")
  }
  c.confidenceThreshold = clamp01(c.confidenceThreshold, 0.6)
  c.fallbackThreshold = clamp01(c.fallbackThreshold, 0.35)
  if (typeof c.handlerTimeoutMs !== "number" || c.handlerTimeoutMs < 1000) {
    c.handlerTimeoutMs = DEFAULT_CONFIG.handlerTimeoutMs
  }
  if (typeof c.immediateContext !== "boolean") c.immediateContext = true
  if (typeof c.sessionSummary !== "boolean") c.sessionSummary = true

  for (const engine of ["jev", "llm"] as const) {
    const block = c[engine]
    if (typeof block.baseUrl !== "string" || !block.baseUrl.startsWith("http")) {
      throw new ConfigError(prefix + `${engine}.baseUrl must be an http(s) URL`)
    }
    if (typeof block.model !== "string" || block.model.length === 0) {
      throw new ConfigError(prefix + `${engine}.model must be a non-empty string`)
    }
    if (typeof block.apiKey !== "string") block.apiKey = ""
    if (typeof block.timeoutMs !== "number" || block.timeoutMs < 1000) {
      block.timeoutMs = DEFAULT_CONFIG[engine].timeoutMs
    }
  }

  const cg = c.contextGathering
  if (typeof cg.agent !== "string" || cg.agent.length === 0) {
    throw new ConfigError(prefix + "contextGathering.agent must be a non-empty string")
  }
  if (typeof cg.timeoutMs !== "number" || cg.timeoutMs < 1000) {
    cg.timeoutMs = DEFAULT_CONFIG.contextGathering.timeoutMs
  }

  const ad = c.agentDecision
  if (typeof ad.agent !== "string" || ad.agent.length === 0) {
    throw new ConfigError(prefix + "agentDecision.agent must be a non-empty string")
  }
  if (typeof ad.timeoutMs !== "number" || ad.timeoutMs < 1000) {
    ad.timeoutMs = DEFAULT_CONFIG.agentDecision.timeoutMs
  }

  const g = c.guidance
  if (typeof g.enabled !== "boolean") g.enabled = true
  // An empty path means no guidance from that dir.
  if (typeof g.projectPath !== "string") g.projectPath = DEFAULT_CONFIG.guidance.projectPath
  if (typeof g.globalPath !== "string") g.globalPath = DEFAULT_CONFIG.guidance.globalPath
  if (g.inheritedGlobalPath !== undefined && typeof g.inheritedGlobalPath !== "string") delete g.inheritedGlobalPath
  if (typeof g.maxChars !== "number" || g.maxChars < 1000) {
    g.maxChars = DEFAULT_CONFIG.guidance.maxChars
  }
}

/**
 * Check `profiles` at load: drop keys a profile may not set (with a warning),
 * and validate each profile merged over the base so a bad value fails the
 * load rather than the first question from that agent.
 */
function normalizeProfiles(config: Config, warn: (message: string) => void): Record<string, ProfileConfig> {
  const raw: unknown = config.profiles
  if (raw === undefined) return {}
  if (!isPlainObject(raw)) throw new ConfigError("profiles must be an object keyed by agent name")
  const allowed = new Set<string>(PROFILE_KEYS)
  const out: Record<string, ProfileConfig> = {}
  const seen = new Set<string>()
  for (const [name, value] of Object.entries(raw)) {
    if (!isPlainObject(value)) throw new ConfigError(`profiles.${name} must be an object`)
    const key = name.toLowerCase()
    if (seen.has(key)) throw new ConfigError(`profiles has more than one entry for agent "${name}" (names are case-insensitive)`)
    seen.add(key)
    const kept: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      if (allowed.has(k)) kept[k] = v
      else warn(`profiles.${name}.${k} is not a profile setting and was ignored (profiles can set: ${PROFILE_KEYS.join(", ")})`)
    }
    const guidance = kept.guidance
    if (isPlainObject(guidance) && "inheritGlobal" in guidance && typeof guidance.inheritGlobal !== "boolean") {
      throw new ConfigError(`profiles.${name}.guidance.inheritGlobal must be a boolean`)
    }
    if (isPlainObject(guidance) && "inheritedGlobalPath" in guidance) {
      const { inheritedGlobalPath: _, ...rest } = guidance
      kept.guidance = rest
      warn(`profiles.${name}.guidance.inheritedGlobalPath is internal and was ignored`)
    }
    if (isHumanGatedAgent(name, config.humanGatedAgents)) {
      warn(`profiles.${name}: "${name}" is human-gated, so its questions are never auto-answered and this profile is unused`)
    } else if (!config.agents.some((a) => a.toLowerCase() === key)) {
      warn(`profiles.${name}: "${name}" is not in "agents", so this profile is unused`)
    }
    // Validate the merged result now (throws with the profile named).
    resolveProfile(config, kept as ProfileConfig, `profiles.${name}: `)
    out[name] = kept as ProfileConfig
  }
  return out
}

function resolveProfile(base: Config, profile: ProfileConfig, prefix: string): Config {
  const { inheritGlobal, ...guidance } = profile.guidance ?? {}
  const merged = mergeConfig(structuredClone(base), {
    ...profile,
    ...(profile.guidance ? { guidance } : {}),
  } as Record<string, unknown>)
  merged.profiles = {}
  const ownGlobal = typeof guidance.globalPath === "string" && guidance.globalPath !== base.guidance.globalPath
  if (inheritGlobal === false) {
    // Only the profile's own global dir, or none at all.
    if (!ownGlobal) merged.guidance.globalPath = ""
  } else if (ownGlobal) {
    merged.guidance.inheritedGlobalPath = base.guidance.globalPath
  }
  normalizeBehavior(merged, prefix)
  return merged
}

/**
 * The config for questions from `agent`: its profile (matched
 * case-insensitively) merged over the top-level config, or the top-level
 * config itself when it has none. The result has no profiles.
 */
export function configForAgent(config: Config, agent: string | undefined): Config {
  if (!agent) return config
  const key = agent.toLowerCase()
  const name = Object.keys(config.profiles ?? {}).find((n) => n.toLowerCase() === key)
  if (name === undefined) return config
  return resolveProfile(config, config.profiles[name]!, `profiles.${name}: `)
}
