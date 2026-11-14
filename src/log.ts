import { appendFileSync, mkdirSync, statSync, truncateSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const LOG_DIR = join(homedir(), ".local", "share", "opencode-auto-question")
const LOG_FILE = join(LOG_DIR, "log.txt")
/** One JSON result record per line (see src/result.ts). */
export const RESULTS_FILE = join(LOG_DIR, "results.jsonl")
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

/** Append one line, truncating the file first once it passes MAX_BYTES. Never throws. */
function appendLine(file: string, line: string): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    try {
      if (statSync(file).size > MAX_BYTES) truncateSync(file)
    } catch {
      // first write or stat failure — nothing to rotate
    }
    appendFileSync(file, line)
  } catch {
    // logging must never break the plugin
  }
}

export function log(level: "debug" | "info" | "warn" | "error", message: string, data?: unknown): void {
  if (level === "debug" && !verbose) return
  appendLine(LOG_FILE, `${new Date().toISOString()} [${level}] ${message}${data === undefined ? "" : ` ${safeStringify(data)}`}\n`)
}

/** Write one result record to results.jsonl as a single JSON line. */
export function appendResult(record: unknown): void {
  appendLine(RESULTS_FILE, `${safeStringify(record)}\n`)
}
