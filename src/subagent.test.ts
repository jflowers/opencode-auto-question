import { describe, expect, test } from "bun:test"
import { runSubagentDetailed, type SubagentOptions } from "./subagent"

type Call = { method: "post" | "delete"; url: string }

/** A fake opencode HTTP client; `message` decides how the prompt call behaves. */
function fakeClient(message: "reply" | "hang" | "throw") {
  const calls: Call[] = []
  let deleted!: () => void
  const deletedOnce = new Promise<void>((resolve) => (deleted = resolve))
  const httpClient = {
    post: async ({ url }: { url: string }) => {
      calls.push({ method: "post", url })
      if (url === "/session") return { data: { id: "child_1" } }
      if (url === "/session/child_1/message") {
        if (message === "hang") return new Promise(() => {})
        if (message === "throw") throw new Error("socket hang up")
        return { data: { parts: [{ type: "text", text: "done" }], info: { providerID: "p", modelID: "m" } } }
      }
      return { data: true }
    },
    delete: async ({ url }: { url: string }) => {
      calls.push({ method: "delete", url })
      deleted()
      return { data: true }
    },
  }
  return { input: { client: { _client: httpClient } } as any, calls, deletedOnce }
}

const opts = (timeoutMs = 1000): SubagentOptions => ({
  parentSessionID: "ses_1",
  agent: "auto-question-ctx",
  prompt: "p",
  timeoutMs,
  title: "auto-question: context gathering",
  cleanupDelayMs: 0,
})

const after = (calls: Call[]) => calls.filter((c) => c.url !== "/session" && c.url !== "/session/child_1/message")

describe("runSubagentDetailed cleanup", () => {
  test("a finished subagent is deleted without an abort", async () => {
    const f = fakeClient("reply")
    expect(await runSubagentDetailed(f.input, opts())).toEqual({ text: "done", model: "p/m" })
    await f.deletedOnce
    expect(after(f.calls)).toEqual([{ method: "delete", url: "/session/child_1" }])
  })

  test("a timed-out subagent is aborted before it is deleted", async () => {
    const f = fakeClient("hang")
    expect(await runSubagentDetailed(f.input, opts(10))).toBeNull()
    await f.deletedOnce
    expect(after(f.calls)).toEqual([
      { method: "post", url: "/session/child_1/abort" },
      { method: "delete", url: "/session/child_1" },
    ])
  })

  test("a failed message call is aborted before it is deleted", async () => {
    const f = fakeClient("throw")
    expect(await runSubagentDetailed(f.input, opts())).toBeNull()
    await f.deletedOnce
    expect(after(f.calls)).toEqual([
      { method: "post", url: "/session/child_1/abort" },
      { method: "delete", url: "/session/child_1" },
    ])
  })
})
