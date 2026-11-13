import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * The agents this plugin ships in `agents/*.md`. The plugin registers them
 * through opencode's `config` hook, so an npm install needs no symlinks.
 * Markdown agents (global `~/.config/opencode/agents/` and project
 * `.opencode/agents/`) are already in the config when the hook runs, so a
 * user's own definition of the same name always wins.
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

/**
 * Add each bundled agent the config doesn't already define. Returns the names
 * added and the names skipped because the user defines them.
 */
export function registerAgents(
  config: { agent?: Record<string, unknown> },
  agents: Record<string, AgentDefinition>,
): { added: string[]; kept: string[] } {
  config.agent ??= {}
  const added: string[] = []
  const kept: string[] = []
  for (const [name, def] of Object.entries(agents)) {
    if (config.agent[name] !== undefined) {
      kept.push(name)
      continue
    }
    config.agent[name] = { ...def }
    added.push(name)
  }
  return { added, kept }
}
