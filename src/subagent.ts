import type { Plugin } from "@opencode-ai/plugin"
import { log } from "./log"
import { parseModelRef } from "./model"

type PluginInput = Parameters<Plugin>[0]

export interface SubagentOptions {
  parentSessionID: string
  agent: string
  /** "provider/model" overriding the agent's own model. */
  model?: string
  prompt: string
  timeoutMs: number
  title: string
  /** Wait before deleting the child session (tests shorten it). */
  cleanupDelayMs?: number
}

/** Default wait between the child session finishing (or being aborted) and its deletion. */
export const SUBAGENT_CLEANUP_DELAY_MS = 5_000

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
  return (await runSubagentDetailed(input, opts))?.text ?? null
}

/**
 * runSubagent, plus the model that produced the reply ("provider/model")
 * when the server reports it on the assistant message.
 */
export async function runSubagentDetailed(
  input: PluginInput,
  opts: SubagentOptions,
): Promise<{ text: string; model?: string } | null> {
  const httpClient = (input.client as any)._client
  let sessionID: string | undefined
  // True once the child session may still be running: a timeout or a failed
  // message call. It is aborted before it is deleted.
  let unfinished = false
  const model = opts.model ? parseModelRef(opts.model) : null

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
          ...(model ? { model } : {}),
          tools: { question: false },
          parts: [{ type: "text", text: opts.prompt }],
        },
      }),
      opts.timeoutMs,
    )
    if (!result) {
      unfinished = true
      log("warn", "subagent timed out", { sessionID, timeoutMs: opts.timeoutMs, title: opts.title })
      return null
    }

    const parts: Array<{ type?: string; text?: string }> = result?.data?.parts ?? []
    const text = parts
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("\n\n")
      .trim()
    if (!text) return null
    const info = result?.data?.info
    const replyModel =
      typeof info?.providerID === "string" && typeof info?.modelID === "string"
        ? `${info.providerID}/${info.modelID}`
        : undefined
    return replyModel ? { text, model: replyModel } : { text }
  } catch (e) {
    unfinished = sessionID !== undefined
    log("warn", "subagent run failed", { error: String(e), title: opts.title })
    return null
  } finally {
    if (sessionID) cleanUp(httpClient, sessionID, unfinished, opts.cleanupDelayMs ?? SUBAGENT_CLEANUP_DELAY_MS)
  }
}

/**
 * Delete the child session in the background, without delaying the caller.
 *
 * A child that may still be running (timeout, failed call) is aborted
 * first: deleting a session whose agent loop is still writing parts and
 * messages makes those writes fail with FOREIGN KEY errors. The DELETE is
 * then delayed either way, so the server's SessionProcessor.cleanup can
 * finish persisting final state (step-start parts, token counts): the
 * synchronous /session/{id}/message POST, and an abort, return before that
 * cleanup completes.
 */
function cleanUp(httpClient: any, sessionID: string, abort: boolean, delayMs: number): void {
  void (async () => {
    if (abort) {
      try {
        await httpClient.post({ url: `/session/${sessionID}/abort` })
        log("debug", "aborted unfinished subagent session", { sessionID })
      } catch (e) {
        log("debug", "subagent session abort failed", { sessionID, error: String(e) })
      }
    }
    setTimeout(async () => {
      try {
        await httpClient.delete({ url: `/session/${sessionID}` })
      } catch (e) {
        log("debug", "subagent session cleanup failed", { sessionID, error: String(e) })
      }
    }, delayMs)
  })()
}
