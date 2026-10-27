import type { Config, Decision, QuestionInfo } from "../types"
import { buildJevQuestions, parseJevResponse } from "../mapping"
import { log } from "../log"

function buildState(context: string | null): string {
  const framing =
    "An autonomous AI coding agent is asking its user a clarifying question mid-task. Answer as the user would."
  return context ? `${framing}\n\nRelevant context:\n${context}` : framing
}

export async function decideWithJev(
  config: Config,
  questions: QuestionInfo[],
  context: string | null,
): Promise<Decision> {
  const set = buildJevQuestions(questions)
  if (!set) {
    return { ok: false, answers: [], confidences: [], engine: "jev", error: "questions not mappable to Jev primitives" }
  }

  let json: { answers?: Record<string, unknown> }
  try {
    const response = await fetch(config.jev.baseUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.jev.apiKey}`,
      },
      body: JSON.stringify({ model: config.jev.model, state: buildState(context), questions: set.questions }),
      signal: AbortSignal.timeout(config.jev.timeoutMs),
    })
    if (!response.ok) {
      const body = await response.text().catch(() => "")
      return {
        ok: false,
        answers: [],
        confidences: [],
        engine: "jev",
        error: `Jev API ${response.status}: ${body.slice(0, 300)}`,
      }
    }
    json = (await response.json()) as { answers?: Record<string, unknown> }
  } catch (e) {
    return { ok: false, answers: [], confidences: [], engine: "jev", error: String(e) }
  }

  const parsed = parseJevResponse(set, questions, json.answers ?? {})
  if (!parsed) {
    log("debug", "jev response unparsable", { response: json })
    return { ok: false, answers: [], confidences: [], engine: "jev", error: "unparsable Jev response" }
  }

  return { ok: true, answers: parsed.answers, confidences: parsed.confidences, engine: "jev" }
}
