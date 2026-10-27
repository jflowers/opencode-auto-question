import { describe, expect, test } from "bun:test"
import { DEFAULT_CONFIG, interpolateEnv, loadConfig, mergeConfig, stripJsonComments } from "./config"

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
  test("missing file throws ConfigError", () => {
    expect(() => loadConfig("/nonexistent/auto-question.jsonc")).toThrow()
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
})
