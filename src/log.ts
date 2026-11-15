import { appendFileSync, mkdirSync, statSync, truncateSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

/** Environment variable that moves log.txt and results.jsonl to another directory. */
export const LOG_DIR_ENV = "AUTO_QUESTION_LOG_DIR"

/**
 * Where log.txt and results.jsonl go: $AUTO_QUESTION_LOG_DIR when set, else
 * ~/.local/share/opencode-auto-question. Read on every write, so the test
 * preload (src/test-preload.ts) can point it at a temp dir.
 */
export function logDir(): string {
  return process.env[LOG_DIR_ENV]?.trim() || join(homedir(), ".local", "share", "opencode-auto-question")
}

/** One JSON result record per line (see src/result.ts). */
export function resultsFile(): string {
  return join(logDir(), "results.jsonl")
}

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
    mkdirSync(dirname(file), { recursive: true })
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
  appendLine(join(logDir(), "log.txt"), `${new Date().toISOString()} [${level}] ${message}${data === undefined ? "" : ` ${safeStringify(data)}`}\n`)
}

/** Write one result record to results.jsonl as a single JSON line. */
export function appendResult(record: unknown): void {
  appendLine(resultsFile(), `${safeStringify(record)}\n`)
}
