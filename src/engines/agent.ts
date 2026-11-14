import type { Config, Decision, QuestionRequest } from "../types"
import { buildAgentPrompt, parseAgentResponse } from "../mapping"
import { runSubagentDetailed } from "../subagent"
import type { Plugin } from "@opencode-ai/plugin"

type PluginInput = Parameters<Plugin>[0]

/**
 * Pass 0: run the tool-using decision agent in a temporary child session.
 * The agent investigates the workspace per the project guidance and returns
 * the final answers (including custom "Type your own answer" text) plus a
 * self-reported `covered` flag saying whether the guidance addressed the
 * questions.
 */
export async function decideWithAgent(
  input: PluginInput,
  config: Config,
  request: QuestionRequest,
  immediateCtx: string | null,
  guidance: string,
  contextLabel?: string,
): Promise<Decision> {
  const prompt = buildAgentPrompt(request.questions, guidance, immediateCtx, contextLabel)
  const reply = await runSubagentDetailed(input, {
    parentSessionID: request.sessionID,
    agent: config.agentDecision.agent,
    ...(config.agentDecision.model ? { model: config.agentDecision.model } : {}),
    prompt,
    timeoutMs: config.agentDecision.timeoutMs,
    title: "auto-question: decision",
  })

  const text = reply?.text
  if (!text) {
    return {
      ok: false,
      answers: [],
      confidences: [],
      engine: "agent",
      error: "decision agent produced no response (timeout or empty)",
    }
  }

  const parsed = parseAgentResponse(text, request.questions.length)
  if (!parsed) {
    return {
      ok: false,
      answers: [],
      confidences: [],
      engine: "agent",
      error: "unparsable decision agent response",
    }
  }

  return {
    ok: true,
    answers: parsed.answers,
    confidences: parsed.confidences,
    engine: "agent",
    guidanceCovered: parsed.covered,
    model: reply.model ?? (config.agentDecision.model || `agent:${config.agentDecision.agent}`),
    ...(parsed.rationale ? { rationale: parsed.rationale } : {}),
  }
}
