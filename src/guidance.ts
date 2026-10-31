import { readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import type { Config } from "./types"
import { log } from "./log"

function expandHome(p: string): string {
  if (p === "~" || p.startsWith("~/")) return join(homedir(), p.slice(2))
  return p
}

function readGuidanceDir(dir: string): Array<{ name: string; text: string }> {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  const docs: Array<{ name: string; text: string }> = []
  for (const name of entries.filter((n) => n.endsWith(".md")).sort()) {
    try {
      const text = readFileSync(join(dir, name), "utf8").trim()
      if (text) docs.push({ name, text })
    } catch (e) {
      log("warn", "failed to read guidance file", { file: join(dir, name), error: String(e) })
    }
  }
  return docs
}

/**
 * Load guidance documents for the pass-0 decision agent. Global docs load
 * first, project docs after (more specific, later). Returns null when there
 * is no guidance or loading is disabled — never throws, so guidance problems
 * cannot break the plugin.
 */
export function loadGuidance(projectDir: string, config: Config): string | null {
  if (!config.guidance.enabled) return null

  const projectDirAbs = isAbsolute(config.guidance.projectPath)
    ? config.guidance.projectPath
    : join(projectDir, config.guidance.projectPath)
  const docs = [
    ...readGuidanceDir(expandHome(config.guidance.globalPath)),
    ...readGuidanceDir(projectDirAbs),
  ]
  if (docs.length === 0) return null

  let text = docs.map((d) => d.text).join("\n\n---\n\n")
  if (text.length > config.guidance.maxChars) {
    text = text.slice(0, config.guidance.maxChars) + "\n\n(guidance truncated)"
  }
  log("info", "loaded project guidance", {
    chars: text.length,
    docs: docs.length,
    files: docs.map((d) => d.name),
  })
  return text
}
