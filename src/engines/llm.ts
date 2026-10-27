import type { Config, Decision, QuestionInfo } from "../types"
import { buildLlmMessages, parseLlmResponse } from "../mapping"

async function postChatCompletion(
  config: Config,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; text: string }> {
  const response = await fetch(`${config.llm.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.llm.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.llm.timeoutMs),
  })
  const text = await response.text().catch(() => "")
  return { ok: response.ok, status: response.status, text }
}

function extractContent(text: string): string | null {
  try {
    const json = JSON.parse(text)
    const content = json?.choices?.[0]?.message?.content
    return typeof content === "string" ? content : null
  } catch {
    return null
  }
}

export async function decideWithLlm(
  config: Config,
  questions: QuestionInfo[],
  context: string | null,
): Promise<Decision> {
  if (!config.llm.apiKey) {
    return { ok: false, answers: [], confidences: [], engine: "llm", error: "llm apiKey missing" }
  }

  const { system, user } = buildLlmMessages(questions, context)
  const base = {
    model: config.llm.model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0,
  }

  let result: { ok: boolean; status: number; text: string }
  try {
    result = await postChatCompletion(config, { ...base, response_format: { type: "json_object" } })
    if (!result.ok && result.status === 400) {
      // Some OpenAI-compatible endpoints reject response_format — retry without it.
      result = await postChatCompletion(config, base)
    }
  } catch (e) {
    return { ok: false, answers: [], confidences: [], engine: "llm", error: String(e) }
  }

  if (!result.ok) {
    return { ok: false, answers: [], confidences: [], engine: "llm", error: `LLM API ${result.status}: ${result.text.slice(0, 300)}` }
  }

  const content = extractContent(result.text)
  if (!content) {
    return { ok: false, answers: [], confidences: [], engine: "llm", error: "no message content in LLM response" }
  }

  const parsed = parseLlmResponse(content, questions.length)
  if (!parsed) {
    return { ok: false, answers: [], confidences: [], engine: "llm", error: "unparsable LLM JSON contract response" }
  }

  return { ok: true, answers: parsed.answers, confidences: parsed.confidences, engine: "llm" }
}
