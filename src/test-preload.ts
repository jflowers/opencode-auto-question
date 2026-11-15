/**
 * Loaded before every test file (bunfig.toml): sends log.txt and
 * results.jsonl to a temp dir, so test runs never write to the real log in
 * ~/.local/share/opencode-auto-question.
 */
import { afterAll } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LOG_DIR_ENV } from "./log"

const dir = mkdtempSync(join(tmpdir(), "aq-test-log-"))
process.env[LOG_DIR_ENV] = dir
// A hook registered in a preload runs once, after every test file.
afterAll(() => rmSync(dir, { recursive: true, force: true }))
