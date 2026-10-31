import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadGuidance } from "./guidance"
import { DEFAULT_CONFIG } from "./config"
import type { Config } from "./types"

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "aq-guidance-"))
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Config with the global guidance dir pointed somewhere nonexistent. */
function configWith(guidanceOverrides: Record<string, unknown> = {}): Config {
  return {
    ...DEFAULT_CONFIG,
    guidance: {
      ...DEFAULT_CONFIG.guidance,
      globalPath: "/nonexistent/aq-test-global",
      ...guidanceOverrides,
    },
  }
}

describe("loadGuidance", () => {
  test("returns null when no guidance dir exists", () => {
    withTempDir((dir) => {
      expect(loadGuidance(dir, configWith())).toBeNull()
    })
  })

  test("returns null when disabled", () => {
    withTempDir((dir) => {
      const guidanceDir = join(dir, ".opencode/auto-question/guidance")
      mkdirSync(guidanceDir, { recursive: true })
      writeFileSync(join(guidanceDir, "a.md"), "Be helpful.")
      expect(loadGuidance(dir, configWith({ enabled: false }))).toBeNull()
    })
  })

  test("loads project docs sorted with --- separator", () => {
    withTempDir((dir) => {
      const guidanceDir = join(dir, ".opencode/auto-question/guidance")
      mkdirSync(guidanceDir, { recursive: true })
      writeFileSync(join(guidanceDir, "b-second.md"), "Second doc.")
      writeFileSync(join(guidanceDir, "a-first.md"), "First doc.")
      expect(loadGuidance(dir, configWith())).toBe("First doc.\n\n---\n\nSecond doc.")
    })
  })

  test("merges global docs before project docs", () => {
    withTempDir((dir) => {
      const globalDir = join(dir, "global")
      const projectDir = join(dir, "project")
      mkdirSync(globalDir, { recursive: true })
      mkdirSync(join(projectDir, ".opencode/auto-question/guidance"), { recursive: true })
      writeFileSync(join(globalDir, "g.md"), "Global doc.")
      writeFileSync(join(projectDir, ".opencode/auto-question/guidance", "p.md"), "Project doc.")
      expect(loadGuidance(projectDir, configWith({ globalPath: globalDir }))).toBe(
        "Global doc.\n\n---\n\nProject doc.",
      )
    })
  })

  test("ignores non-markdown and empty files", () => {
    withTempDir((dir) => {
      const guidanceDir = join(dir, ".opencode/auto-question/guidance")
      mkdirSync(guidanceDir, { recursive: true })
      writeFileSync(join(guidanceDir, "notes.txt"), "not markdown")
      writeFileSync(join(guidanceDir, "empty.md"), "   \n")
      writeFileSync(join(guidanceDir, "real.md"), "Real doc.")
      expect(loadGuidance(dir, configWith())).toBe("Real doc.")
    })
  })

  test("caps at maxChars with truncation marker", () => {
    withTempDir((dir) => {
      const guidanceDir = join(dir, ".opencode/auto-question/guidance")
      mkdirSync(guidanceDir, { recursive: true })
      writeFileSync(join(guidanceDir, "big.md"), "x".repeat(500))
      const text = loadGuidance(dir, configWith({ maxChars: 100 }))!
      expect(text.length).toBeLessThanOrEqual(100 + "\n\n(guidance truncated)".length)
      expect(text).toContain("(guidance truncated)")
    })
  })

  test("absolute projectPath is used as-is", () => {
    withTempDir((dir) => {
      const absDir = join(dir, "abs-guidance")
      mkdirSync(absDir, { recursive: true })
      writeFileSync(join(absDir, "doc.md"), "Absolute doc.")
      const text = loadGuidance("/some/other/project", configWith({ projectPath: absDir }))!
      expect(text).toBe("Absolute doc.")
    })
  })
})
