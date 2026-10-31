import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { resolveJevCarrier } from "./jev"
import type { Config } from "../types"

const base: Config = {
  enabled: true,
  agents: ["autonomy"],
  engine: "auto",
  jev: {
    model: "typesafe/jev-1.14",
    baseUrl: "https://openrouter.ai/api/alpha/decisions",
    apiKey: "",
    timeoutMs: 15000,
  },
  llm: { baseUrl: "https://example.test/v1", apiKey: "k", model: "m", timeoutMs: 1000 },
  confidenceThreshold: 0.6,
  fallbackThreshold: 0.35,
  contextGathering: { agent: "auto-question-ctx", timeoutMs: 30000 },
  agentDecision: { agent: "auto-question-decide", timeoutMs: 60000 },
  guidance: {
    enabled: true,
    projectPath: ".opencode/auto-question/guidance",
    globalPath: "~/.config/opencode/auto-question/guidance",
    maxChars: 20000,
  },
  handlerTimeoutMs: 120000,
  immediateContext: true,
  sessionSummary: true,
  verbose: false,
}

const KEYS = ["OPENCODE_API_KEY", "OPENROUTER_API_KEY"] as const
let saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const key of KEYS) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

describe("resolveJevCarrier", () => {
  test("explicit config apiKey wins", () => {
    process.env.OPENCODE_API_KEY = "sk-zen"
    const config = {
      ...base,
      jev: { ...base.jev, apiKey: "sk-explicit", model: "custom-model", baseUrl: "https://example.test" },
    }
    expect(resolveJevCarrier(config)).toEqual({
      carrier: "config",
      baseUrl: "https://example.test",
      model: "custom-model",
      apiKey: "sk-explicit",
    })
  })

  test("OPENCODE_API_KEY selects Zen with pinned model", () => {
    process.env.OPENCODE_API_KEY = "sk-zen"
    expect(resolveJevCarrier(base)).toEqual({
      carrier: "zen",
      baseUrl: "https://opencode.ai/zen/v1/systemone",
      model: "jev-1.13",
      apiKey: "sk-zen",
    })
  })

  test("OPENROUTER_API_KEY alone selects OpenRouter defaults", () => {
    process.env.OPENROUTER_API_KEY = "sk-or"
    const carrier = resolveJevCarrier(base)!
    expect(carrier.carrier).toBe("openrouter")
    expect(carrier.baseUrl).toBe("https://openrouter.ai/api/alpha/decisions")
    expect(carrier.model).toBe("typesafe/jev-1.14")
    expect(carrier.apiKey).toBe("sk-or")
  })

  test("Zen wins when both env keys are set", () => {
    process.env.OPENCODE_API_KEY = "sk-zen"
    process.env.OPENROUTER_API_KEY = "sk-or"
    expect(resolveJevCarrier(base)!.carrier).toBe("zen")
  })

  test("OpenRouter key in OPENCODE_API_KEY self-heals to OpenRouter", () => {
    process.env.OPENCODE_API_KEY = "sk-or-v1-abc123"
    const carrier = resolveJevCarrier(base)!
    expect(carrier.carrier).toBe("openrouter")
    expect(carrier.baseUrl).toBe("https://openrouter.ai/api/alpha/decisions")
    expect(carrier.model).toBe("typesafe/jev-1.14")
    expect(carrier.apiKey).toBe("sk-or-v1-abc123")
    expect(carrier.note).toContain("OPENROUTER_API_KEY")
  })

  test("OpenRouter key in OPENCODE_API_KEY takes precedence over OPENROUTER_API_KEY", () => {
    process.env.OPENCODE_API_KEY = "sk-or-v1-abc123"
    process.env.OPENROUTER_API_KEY = "sk-or-v1-other"
    expect(resolveJevCarrier(base)!.apiKey).toBe("sk-or-v1-abc123")
  })

  test("no keys and empty config apiKey returns null", () => {
    expect(resolveJevCarrier(base)).toBeNull()
  })
})
