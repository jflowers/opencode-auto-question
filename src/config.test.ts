import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  DEFAULT_CONFIG,
  configSources,
  defaultConfigPath,
  interpolateEnv,
  loadConfig,
  mergeConfig,
  stripJsonComments,
} from "./config"

describe("stripJsonComments", () => {
  test("strips line comments", () => {
    const text = `{\n  // a comment\n  "a": 1\n}`
    expect(JSON.parse(stripJsonComments(text))).toEqual({ a: 1 })
  })

  test("strips block comments", () => {
    const text = `{ /* multi\nline */ "a": 1 }`
    expect(JSON.parse(stripJsonComments(text))).toEqual({ a: 1 })
  })

  test("preserves comment-like sequences inside strings", () => {
    const text = `{"a": "http://x//y/*z*/", "b": 2}`
    expect(JSON.parse(stripJsonComments(text))).toEqual({ a: "http://x//y/*z*/", b: 2 })
  })

  test("handles escaped quotes in strings", () => {
    const text = `{"a": "he said \\"hi\\" // not a comment"}`
    expect(JSON.parse(stripJsonComments(text))).toEqual({ a: 'he said "hi" // not a comment' })
  })
})

describe("interpolateEnv", () => {
  test("replaces {env:VAR}", () => {
    process.env.AQ_TEST_VAR = "secret"
    expect(interpolateEnv("{env:AQ_TEST_VAR}")).toBe("secret")
  })

  test("missing env becomes empty string", () => {
    expect(interpolateEnv("{env:AQ_MISSING_VAR_XYZ}")).toBe("")
  })

  test("recurses into objects and arrays", () => {
    process.env.AQ_TEST_VAR = "k"
    expect(interpolateEnv({ a: "{env:AQ_TEST_VAR}", b: ["{env:AQ_TEST_VAR}", 1] })).toEqual({ a: "k", b: ["k", 1] })
  })
})

describe("mergeConfig", () => {
  test("deep-merges objects, replaces scalars and arrays", () => {
    const merged = mergeConfig(DEFAULT_CONFIG, { agents: ["foo"], jev: { model: "m2" } })
    expect(merged.agents).toEqual(["foo"])
    expect(merged.jev.model).toBe("m2")
    expect(merged.jev.baseUrl).toBe(DEFAULT_CONFIG.jev.baseUrl)
    expect(merged.llm.model).toBe(DEFAULT_CONFIG.llm.model)
  })
})

describe("loadConfig", () => {
  test("a missing file runs on the defaults", () => {
    const config = loadConfig("/nonexistent/auto-question.jsonc")
    expect(config.agents).toEqual(["autonomy"])
    expect(config.registerAgents).toBe(true)
    expect(config.engine).toBe("auto")
  })

  test("a path that exists but can't be read as a file throws ConfigError", () => {
    expect(() => loadConfig(import.meta.dir)).toThrow(/not readable/)
  })

  test("defaults point at public endpoints only", () => {
    expect(DEFAULT_CONFIG.llm.baseUrl).toBe("https://openrouter.ai/api/v1")
    expect(DEFAULT_CONFIG.llm.apiKey).toBe("{env:OPENROUTER_API_KEY}")
  })

  test("rejects a non-boolean registerAgents", () => {
    expect(() => loadConfig(`${import.meta.dir}/fixtures/register-invalid.jsonc`)).toThrow(/registerAgents must be a boolean/)
  })

  test("loads jsonc with comments and interpolation", () => {
    process.env.AQ_TEST_KEY = "k123"
    const path = `${import.meta.dir}/fixtures/test-config.jsonc`
    const config = loadConfig(path)
    expect(config.agents).toEqual(["autonomy", "custom-agent"])
    expect(config.jev.apiKey).toBe("k123")
    expect(config.confidenceThreshold).toBe(0.7)
    expect(config.llm.baseUrl).toBe(DEFAULT_CONFIG.llm.baseUrl)
  })

  test("clamps thresholds into [0,1]", () => {
    const path = `${import.meta.dir}/fixtures/out-of-range.jsonc`
    const config = loadConfig(path)
    expect(config.confidenceThreshold).toBe(1)
    expect(config.fallbackThreshold).toBe(0)
  })

  test("defaults include agentDecision and guidance blocks", () => {
    expect(DEFAULT_CONFIG.agentDecision).toEqual({ agent: "auto-question-decide", timeoutMs: 60_000 })
    expect(DEFAULT_CONFIG.guidance).toEqual({
      enabled: true,
      projectPath: ".opencode/auto-question/guidance",
      globalPath: "~/.config/opencode/auto-question/guidance",
      maxChars: 20_000,
    })
  })

  test("guidance overrides merge and invalid values reset to defaults", () => {
    const path = `${import.meta.dir}/fixtures/guidance-config.jsonc`
    const config = loadConfig(path)
    expect(config.guidance.enabled).toBe(false)
    expect(config.guidance.projectPath).toBe("docs/questions")
    expect(config.agentDecision.agent).toBe("custom-decider")
    // timeoutMs below floor resets to the default
    expect(config.agentDecision.timeoutMs).toBe(DEFAULT_CONFIG.agentDecision.timeoutMs)
    // maxChars below floor resets to the default
    expect(config.guidance.maxChars).toBe(DEFAULT_CONFIG.guidance.maxChars)
  })
})

describe("configSources", () => {
  test("no env vars: only the global file, optional", () => {
    expect(configSources({})).toEqual([{ path: defaultConfigPath(), required: false }])
  })

  test("OPENCODE_CONFIG_DIR adds its auto-question.jsonc after the global file", () => {
    expect(configSources({ OPENCODE_CONFIG_DIR: "/opt/gh-hud/opencode" })).toEqual([
      { path: defaultConfigPath(), required: false },
      { path: "/opt/gh-hud/opencode/auto-question.jsonc", required: false },
    ])
  })

  test("OPENCODE_CONFIG_DIR pointing at the global dir does not load the file twice", () => {
    expect(configSources({ OPENCODE_CONFIG_DIR: join(homedir(), ".config", "opencode") })).toHaveLength(1)
  })

  test("AUTO_QUESTION_CONFIG is used alone and is required", () => {
    expect(configSources({ AUTO_QUESTION_CONFIG: "/etc/aq.jsonc", OPENCODE_CONFIG_DIR: "/opt/x" })).toEqual([
      { path: "/etc/aq.jsonc", required: true },
    ])
  })

  test("blank variables are ignored", () => {
    expect(configSources({ AUTO_QUESTION_CONFIG: " ", OPENCODE_CONFIG_DIR: "" })).toHaveLength(1)
  })
})

describe("loadConfig with several sources", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "aq-config-"))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const write = (name: string, value: unknown): string => {
    const path = join(dir, name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(value))
    return path
  }

  test("a later file deep-merges over an earlier one", () => {
    const global = write("global/auto-question.jsonc", { agents: ["autonomy"], llm: { model: "a" }, confidenceThreshold: 0.7 })
    const local = write("local/auto-question.jsonc", { agents: ["hud-supervisor"], llm: { model: "b" } })
    const config = loadConfig([
      { path: global, required: false },
      { path: local, required: false },
    ])
    expect(config.agents).toEqual(["hud-supervisor"])
    expect(config.llm.model).toBe("b")
    expect(config.llm.baseUrl).toBe(DEFAULT_CONFIG.llm.baseUrl)
    expect(config.confidenceThreshold).toBe(0.7)
  })

  test("a missing optional source is skipped", () => {
    const local = write("local/auto-question.jsonc", { llm: { model: "b" } })
    const config = loadConfig([
      { path: join(dir, "nope.jsonc"), required: false },
      { path: local, required: false },
    ])
    expect(config.llm.model).toBe("b")
  })

  test("a missing required source throws", () => {
    expect(() => loadConfig([{ path: join(dir, "nope.jsonc"), required: true }])).toThrow(/not found.*AUTO_QUESTION_CONFIG/)
  })

  test("a relative guidance.globalPath resolves against its own file's directory", () => {
    const global = write("global/auto-question.jsonc", { guidance: { globalPath: "g" } })
    const local = write("local/auto-question.jsonc", { guidance: { globalPath: "auto-question/guidance" } })
    expect(loadConfig([{ path: global, required: false }]).guidance.globalPath).toBe(join(dir, "global", "g"))
    expect(
      loadConfig([
        { path: global, required: false },
        { path: local, required: false },
      ]).guidance.globalPath,
    ).toBe(join(dir, "local", "auto-question", "guidance"))
  })

  test("absolute and ~ guidance paths, and projectPath, are left as written", () => {
    const local = write("local/auto-question.jsonc", {
      guidance: { globalPath: "~/g", projectPath: ".opencode/q" },
    })
    const config = loadConfig([{ path: local, required: false }])
    expect(config.guidance.globalPath).toBe("~/g")
    expect(config.guidance.projectPath).toBe(".opencode/q")
  })

  test("a human-gated agent added by a later file is still dropped", () => {
    const global = write("global/auto-question.jsonc", { agents: ["autonomy"] })
    const local = write("local/auto-question.jsonc", { agents: ["autonomy", "Curator"] })
    const warnings: string[] = []
    const config = loadConfig(
      [
        { path: global, required: false },
        { path: local, required: false },
      ],
      (m) => warnings.push(m),
    )
    expect(config.agents).toEqual(["autonomy"])
    expect(warnings).toHaveLength(1)
  })

  test("loading never changes DEFAULT_CONFIG", () => {
    const before = structuredClone(DEFAULT_CONFIG)
    const local = write("local/auto-question.jsonc", { llm: { apiKey: 5, timeoutMs: 1 } })
    loadConfig([{ path: local, required: false }])
    expect(DEFAULT_CONFIG).toEqual(before)
  })
})
