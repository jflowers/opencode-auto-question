import { appendFileSync, mkdirSync, statSync, truncateSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const LOG_DIR = join(homedir(), ".local", "share", "opencode-auto-question")
const LOG_FILE = join(LOG_DIR, "log.txt")
const MAX_BYTES = 2_000_000

let verbose = false

export function setVerbose(value: boolean): void {
  verbose = value
}

function safeStringify(data: unknown): string {
  try {
    return JSON.stringify(data)
  } catch {
    return String(data)
  }
}

export function log(level: "debug" | "info" | "warn" | "error", message: string, data?: unknown): void {
  if (level === "debug" && !verbose) return
  const line = `${new Date().toISOString()} [${level}] ${message}${data === undefined ? "" : ` ${safeStringify(data)}`}\n`
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    try {
      if (statSync(LOG_FILE).size > MAX_BYTES) truncateSync(LOG_FILE)
    } catch {
      // first write or stat failure — nothing to rotate
    }
    appendFileSync(LOG_FILE, line)
  } catch {
    // logging must never break the plugin
  }
}
