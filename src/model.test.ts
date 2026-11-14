import { describe, expect, test } from "bun:test"
import { DEFAULT_CONFIG } from "./config"
import { AgentTracker } from "./detect"
import { avoidAskerModel, parseModelRef, sameModel } from "./model"
import type { Config } from "./types"

describe("parseModelRef", () => {
  test("splits at the first slash", () => {
    expect(parseModelRef("openrouter/qwen/qwen3-coder")).toEqual({ providerID: "openrouter", modelID: "qwen/qwen3-coder" })
    expect(parseModelRef("zai/glm-5.3")).toEqual({ providerID: "zai", modelID: "glm-5.3" })
  })

  test("needs both parts", () => {
    expect(parseModelRef("glm-5.3")).toBeNull()
    expect(parseModelRef("/glm-5.3")).toBeNull()
    expect(parseModelRef("zai/")).toBeNull()
  })
})

describe("sameModel", () => {
  test("compares the model name whatever the provider, case and variant", () => {
    expect(sameModel("z-ai/glm-5.3", "openrouter/z-ai/glm-5.3")).toBe(true)
    expect(sameModel("z-ai/glm-5.3", "zai/GLM-5.3")).toBe(true)
    expect(sameModel("z-ai/glm-5.3:free", "zai/glm-5.3")).toBe(true)
  })

  test("different models differ", () => {
    expect(sameModel("z-ai/glm-5.3", "z-ai/glm-5.2")).toBe(false)
    expect(sameModel("qwen/qwen3", "deepseek/deepseek-v4")).toBe(false)
    expect(sameModel("", "")).toBe(false)
  })
})

describe("avoidAskerModel", () => {
  const config = (llm: Partial<Config["llm"]>, engine: Config["engine"] = "auto"): Config => ({
    ...structuredClone(DEFAULT_CONFIG),
    engine,
    llm: { ...DEFAULT_CONFIG.llm, ...llm },
  })

  test("returns the same config when the asker is unknown or uses another model", () => {
    const c = config({ model: "z-ai/glm-5.3", alternateModels: ["qwen/qwen3"] })
    expect(avoidAskerModel(c, undefined, "r")).toBe(c)
    expect(avoidAskerModel(c, "anthropic/claude-sonnet-5-5", "r")).toBe(c)
  })

  test("skips alternates that are the asker's model too", () => {
    const c = config({ model: "z-ai/glm-5.3", alternateModels: ["zai/glm-5.3", "qwen/qwen3"] })
    const out = avoidAskerModel(c, "zai/glm-5.3", "r")
    expect(out.llm.model).toBe("qwen/qwen3")
    expect(c.llm.model).toBe("z-ai/glm-5.3")
  })

  test("keeps the model when no alternate differs", () => {
    const c = config({ model: "z-ai/glm-5.3", alternateModels: ["zai/glm-5.3"] })
    expect(avoidAskerModel(c, "zai/glm-5.3", "r")).toBe(c)
  })

  test("a jev-only config never runs the llm, so it is left alone", () => {
    const c = config({ model: "z-ai/glm-5.3", alternateModels: ["qwen/qwen3"] }, "jev")
    expect(avoidAskerModel(c, "zai/glm-5.3", "r")).toBe(c)
  })
})

describe("AgentTracker models", () => {
  test("tracks the latest assistant model, or a user message's model choice", async () => {
    const t = new AgentTracker()
    t.trackMessage({ sessionID: "s", role: "user", agent: "a", model: { providerID: "zai", modelID: "glm-5.3" } })
    expect(await t.resolveModel({}, "s")).toBe("zai/glm-5.3")
    t.trackMessage({ sessionID: "s", role: "assistant", providerID: "openrouter", modelID: "qwen/qwen3" })
    expect(await t.resolveModel({}, "s")).toBe("openrouter/qwen/qwen3")
    expect(t.get("s")).toBe("a")
  })

  test("falls back to the session's messages, newest first", async () => {
    const t = new AgentTracker()
    const client = {
      session: {
        messages: async () => ({
          data: [
            { info: { role: "assistant", providerID: "zai", modelID: "glm-5.2" } },
            { info: { role: "assistant", providerID: "zai", modelID: "glm-5.3" } },
            { info: { role: "user", agent: "a" } },
          ],
        }),
      },
    }
    expect(await t.resolveModel(client, "s")).toBe("zai/glm-5.3")
  })

  test("unknown when nothing names a model", async () => {
    const t = new AgentTracker()
    expect(await t.resolveModel({ session: { messages: async () => ({ data: [] }) } }, "s")).toBeUndefined()
    expect(await t.resolveModel({}, "s")).toBeUndefined()
  })
})
