import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * The agents this plugin ships in `agents/*.md`. The plugin registers them
 * through opencode's `config` hook, so an npm install needs no symlinks.
 * Markdown agents (global `~/.config/opencode/agents/` and project
 * `.opencode/agents/`) and `agent` entries from opencode.json are already in
 * the config when the hook runs. A user's settings for an agent of the same
 * name win; the bundled definition only fills in what they leave out.
 */
export const BUNDLED_AGENTS = ["autonomy", "auto-question-ctx", "auto-question-decide"] as const

/** The shipped `agents/` directory: one level above `src/` or `dist/`. */
export function bundledAgentsDir(): string {
  return fileURLToPath(new URL("../agents/", import.meta.url))
}

export interface AgentDefinition {
  description?: string
  mode?: string
  hidden?: boolean
  permission?: Record<string, string | boolean>
  prompt: string
}

type Scalar = string | boolean

function parseScalar(raw: string): Scalar {
  const value = raw.trim()
  if (value === "true") return true
  if (value === "false") return false
  const quoted = /^(["'])(.*)\1$/.exec(value)
  return quoted ? quoted[2]! : value
}

/**
 * Parse the frontmatter subset the bundled agents use: `key: value` lines and
 * one level of indented `key: value` lines under a `key:` line. Anything else
 * is an error, so a future edit to an agent file can't be silently dropped.
 */
export function parseAgentMarkdown(text: string, source = "agent"): AgentDefinition {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!match) throw new Error(`${source}: missing frontmatter`)
  const fields: Record<string, Scalar | Record<string, Scalar>> = {}
  let nested: Record<string, Scalar> | null = null
  for (const line of match[1]!.split(/\r?\n/)) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue
    const indented = /^\s+([A-Za-z0-9_.*-]+):\s*(.*)$/.exec(line)
    if (indented) {
      if (!nested) throw new Error(`${source}: indented line without a parent key: ${line.trim()}`)
      nested[indented[1]!] = parseScalar(indented[2]!)
      continue
    }
    const top = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (!top) throw new Error(`${source}: unsupported frontmatter line: ${line}`)
    if (top[2]!.trim() === "") {
      nested = {}
      fields[top[1]!] = nested
    } else {
      nested = null
      fields[top[1]!] = parseScalar(top[2]!)
    }
  }
  const def: AgentDefinition = { prompt: match[2]!.trim() }
  for (const [key, value] of Object.entries(fields)) {
    if (key === "description" || key === "mode") {
      if (typeof value !== "string") throw new Error(`${source}: ${key} must be a string`)
      def[key] = value
    } else if (key === "hidden") {
      if (typeof value !== "boolean") throw new Error(`${source}: hidden must be true or false`)
      def.hidden = value
    } else if (key === "permission") {
      if (typeof value !== "object") throw new Error(`${source}: permission must be a mapping`)
      def.permission = value
    } else {
      throw new Error(`${source}: unsupported frontmatter key "${key}"`)
    }
  }
  return def
}

/** Read and parse every bundled agent. Throws if any file is missing or malformed. */
export function loadBundledAgents(dir = bundledAgentsDir()): Record<string, AgentDefinition> {
  const out: Record<string, AgentDefinition> = {}
  for (const name of BUNDLED_AGENTS) {
    const path = join(dir, `${name}.md`)
    out[name] = parseAgentMarkdown(readFileSync(path, "utf8"), path)
  }
  return out
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** `override` merged over `base`, recursively for objects; override wins. */
function fillIn(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override)) {
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? fillIn(out[key] as Record<string, unknown>, value) : value
  }
  return out
}

/**
 * Register the bundled agents. An agent the config doesn't define is added
 * as is. An agent it does define keeps every setting it has, and the bundled
 * definition fills in the rest: a project config that only narrows
 * `autonomy`'s permissions (e.g. `external_directory`) still gets its prompt,
 * mode and `question: allow`. This is how opencode itself layers an
 * opencode.json entry over a markdown agent of the same name.
 *
 * Returns the names added and the names filled in under an existing entry.
 */
export function registerAgents(
  config: { agent?: Record<string, unknown> },
  agents: Record<string, AgentDefinition>,
): { added: string[]; filledIn: string[] } {
  config.agent ??= {}
  const added: string[] = []
  const filledIn: string[] = []
  for (const [name, def] of Object.entries(agents)) {
    const bundled = structuredClone(def) as unknown as Record<string, unknown>
    const existing = config.agent[name]
    if (existing === undefined || existing === null) {
      config.agent[name] = bundled
      added.push(name)
    } else if (isPlainObject(existing)) {
      config.agent[name] = fillIn(bundled, existing)
      filledIn.push(name)
    }
  }
  return { added, filledIn }
}
