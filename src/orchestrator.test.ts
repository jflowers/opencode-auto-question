import { describe, expect, test } from "bun:test"
import { buildSummaryBody } from "./orchestrator"

describe("buildSummaryBody", () => {
  const info = {
    agent: "autonomy",
    model: { providerID: "opencode", modelID: "glm-5.3", variant: "high" },
    system: "You are autonomous.",
    format: { type: "text" },
  }

  test("copies agent, model, variant, system and format from the last user message", () => {
    const body = buildSummaryBody(info, "summary")!
    expect(body["agent"]).toBe("autonomy")
    expect(body["model"]).toEqual({ providerID: "opencode", modelID: "glm-5.3" })
    expect(body["variant"]).toBe("high")
    expect(body["system"]).toBe("You are autonomous.")
    expect(body["format"]).toEqual({ type: "text" })
    expect(body["noReply"]).toBe(true)
  })

  test("marks the summary part ignored so the model never sees it", () => {
    const body = buildSummaryBody(info, "summary")!
    expect(body["parts"]).toEqual([{ type: "text", text: "summary", ignored: true }])
  })

  test("omits optional fields when the user message lacks them", () => {
    const body = buildSummaryBody({ agent: "autonomy", model: { providerID: "p", modelID: "m" } }, "s")!
    expect(body["variant"]).toBeUndefined()
    expect(body["system"]).toBeUndefined()
    expect(body["format"]).toBeUndefined()
  })

  test("returns null when there is no user message", () => {
    expect(buildSummaryBody(null, "s")).toBeNull()
  })

  test("returns null when agent or model is missing or malformed", () => {
    expect(buildSummaryBody({}, "s")).toBeNull()
    expect(buildSummaryBody({ agent: "", model: { providerID: "p", modelID: "m" } }, "s")).toBeNull()
    expect(buildSummaryBody({ agent: "autonomy" }, "s")).toBeNull()
    expect(buildSummaryBody({ agent: "autonomy", model: {} }, "s")).toBeNull()
    expect(buildSummaryBody({ agent: "autonomy", model: { providerID: "p" } }, "s")).toBeNull()
  })
})
