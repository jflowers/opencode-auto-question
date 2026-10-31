import type { Config, QuestionRequest } from "./types"
import type { Plugin } from "@opencode-ai/plugin"
import { runSubagent } from "./subagent"
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

/**
 * Gather decision context by prompting a dedicated subagent in a temporary
 * child session (see runSubagent).
 */
export async function gatherContext(
  input: PluginInput,
  config: Config,
  request: QuestionRequest,
): Promise<string | null> {
  const text = await runSubagent(input, {
    parentSessionID: request.sessionID,
    agent: config.contextGathering.agent,
    prompt: buildContextPrompt(request),
    timeoutMs: config.contextGathering.timeoutMs,
    title: "auto-question: context gathering",
  })
  if (!text) return null
  if (text === "No relevant context found.") {
    log("info", "context gathering found nothing", { requestID: request.id })
    return null
  }
  return text
}
