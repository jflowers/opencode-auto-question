import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { appendResult, log, LOG_DIR_ENV, logDir } from "./log"

describe("log location", () => {
  test("tests write to the preload's temp dir, never the real log", () => {
    const dir = process.env[LOG_DIR_ENV]
    expect(dir).toBeTruthy()
    expect(logDir()).toBe(dir!)
    expect(logDir()).not.toBe(join(homedir(), ".local", "share", "opencode-auto-question"))
    log("info", "log location test")
    appendResult({ test: true })
    expect(readFileSync(join(dir!, "log.txt"), "utf8")).toContain("log location test")
    expect(existsSync(join(dir!, "results.jsonl"))).toBe(true)
  })

  test(`without ${LOG_DIR_ENV}, the default dir`, () => {
    const saved = process.env[LOG_DIR_ENV]
    try {
      delete process.env[LOG_DIR_ENV]
      expect(logDir()).toBe(join(homedir(), ".local", "share", "opencode-auto-question"))
      process.env[LOG_DIR_ENV] = "  "
      expect(logDir()).toBe(join(homedir(), ".local", "share", "opencode-auto-question"))
    } finally {
      process.env[LOG_DIR_ENV] = saved
    }
  })
})
