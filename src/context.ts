import type { Config, QuestionRequest } from "./types"
import type { Plugin } from "@opencode-ai/plugin"
import { log } from "./log"

type PluginInput = Parameters<Plugin>[0]

function buildContextPrompt(request: QuestionRequest): string {
  const questions = request.questions
    .map((q, i) => {
      const opts = q.options.map((o) => `   - "${o.label}": ${o.description ?? ""}`).join("\n")
      return `${i + 1}. ${q.question}\n${opts}`
    })
    .join("\n\n")
  return [
    "An autonomous coding agent is about to answer these clarifying questions on behalf of the user:",
    "",
    questions,
    "",
    "Search available knowledge sources (session history search, knowledge graphs, and any other searchable tools available to you) for context that would help the user answer: prior decisions, user preferences, precedents, related past work, project constraints.",
    "",
    "Return a concise summary (under 500 words) of the most relevant findings, as plain facts. Do not answer the questions yourself. Do not ask any questions.",
    'If nothing relevant is found, respond with exactly: "No relevant context found."',
  ].join("\n")
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms)
  })
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer))
}

/**
 * Gather decision context by prompting a dedicated subagent in a temporary
 * child session. The child session inherits the current project directory,
 * so per-project tools (dewey MCP, session-search, ...) are available. The
 * synchronous /session/{id}/message endpoint runs the full agent loop.
 */
export async function gatherContext(
  input: PluginInput,
  config: Config,
  request: QuestionRequest,
): Promise<string | null> {
  const httpClient = (input.client as any)._client
  let sessionID: string | undefined

  try {
    const created = await httpClient.post({
      url: "/session",
      body: { parentID: request.sessionID, title: "auto-question: context gathering" },
    })
    sessionID = created?.data?.id
    if (!sessionID) {
      log("warn", "context session creation returned no id")
      return null
    }

    const result: any = await withTimeout(
      httpClient.post({
        url: `/session/${sessionID}/message`,
        body: {
          agent: config.contextGathering.agent,
          tools: { question: false },
          parts: [{ type: "text", text: buildContextPrompt(request) }],
        },
      }),
      config.contextGathering.timeoutMs,
    )
    if (!result) {
      log("warn", "context gathering timed out", { sessionID, timeoutMs: config.contextGathering.timeoutMs })
      return null
    }

    const parts: Array<{ type?: string; text?: string }> = result?.data?.parts ?? []
    const text = parts
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("\n\n")
      .trim()
    if (!text || text === "No relevant context found.") {
      log("info", "context gathering found nothing", { sessionID })
      return null
    }
    return text
  } catch (e) {
    log("warn", "context gathering failed", { error: String(e) })
    return null
  } finally {
    if (sessionID) {
      try {
        await httpClient.delete({ url: `/session/${sessionID}` })
      } catch (e) {
        log("debug", "context session cleanup failed", { sessionID, error: String(e) })
      }
    }
  }
}
