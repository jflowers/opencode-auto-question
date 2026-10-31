import type { Plugin } from "@opencode-ai/plugin"
import { log } from "./log"

type PluginInput = Parameters<Plugin>[0]

export interface SubagentOptions {
  parentSessionID: string
  agent: string
  prompt: string
  timeoutMs: number
  title: string
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms)
  })
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer))
}

/**
 * Run a subagent in a temporary child session and return its final text.
 * The child session inherits the parent's project directory, so per-project
 * tools (dewey MCP, bash, read, ...) are available. The synchronous
 * /session/{id}/message endpoint runs the full agent loop. The child session
 * is deleted after a delay.
 *
 * Returns null on any failure (creation error, timeout, empty response).
 */
export async function runSubagent(input: PluginInput, opts: SubagentOptions): Promise<string | null> {
  const httpClient = (input.client as any)._client
  let sessionID: string | undefined

  try {
    const created = await httpClient.post({
      url: "/session",
      body: { parentID: opts.parentSessionID, title: opts.title },
    })
    sessionID = created?.data?.id
    if (!sessionID) {
      log("warn", "subagent session creation returned no id", { title: opts.title })
      return null
    }

    const result: any = await withTimeout(
      httpClient.post({
        url: `/session/${sessionID}/message`,
        body: {
          agent: opts.agent,
          tools: { question: false },
          parts: [{ type: "text", text: opts.prompt }],
        },
      }),
      opts.timeoutMs,
    )
    if (!result) {
      log("warn", "subagent timed out", { sessionID, timeoutMs: opts.timeoutMs, title: opts.title })
      return null
    }

    const parts: Array<{ type?: string; text?: string }> = result?.data?.parts ?? []
    const text = parts
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("\n\n")
      .trim()
    return text || null
  } catch (e) {
    log("warn", "subagent run failed", { error: String(e), title: opts.title })
    return null
  } finally {
    // Delay the DELETE to let the server's SessionProcessor.cleanup finish
    // persisting final message state (step-start parts, token counts, etc.).
    // The synchronous /session/{id}/message POST returns before cleanup
    // completes; an immediate DELETE races with that background write and
    // causes FOREIGN KEY constraint errors.
    if (sessionID) {
      const id = sessionID
      setTimeout(async () => {
        try {
          await httpClient.delete({ url: `/session/${id}` })
        } catch (e) {
          log("debug", "subagent session cleanup failed", { sessionID: id, error: String(e) })
        }
      }, 5_000)
    }
  }
}
