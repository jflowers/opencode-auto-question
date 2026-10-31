import type { QuestionInfo } from "./types"

/**
 * Mapping between question-tool payloads and the decision engines.
 *
 * Jev Decisions API primitives:
 *   choice — "which option?" → { type: "choice", instructions, criteria: {label: description} }
 *   noul   — "yes/no?"        → { type: "noul", instructions } — the answer's
 *            `noul` field is a probability in [0,1] (e.g. {"noul": 0.93}), not
 *            a boolean; an option is selected when noul > 0.5 (exactly 0.5 is
 *            maximal uncertainty and selects nothing).
 * Single-select questions map to one choice question; multi-select questions
 * map to one noul question per option. Multi-select question confidence is the
 * weakest option certainty: min over options of max(p, 1 - p), so a borderline
 * option (p ≈ 0.5) lowers the whole question's confidence.
 */

export interface JevLayoutEntry {
  kind: "choice" | "noul"
  questionIndex: number
  optionIndex?: number
  label: string
}

export interface JevQuestionSet {
  questions: Record<string, unknown>
  layout: JevLayoutEntry[]
}

export function buildJevQuestions(questions: QuestionInfo[]): JevQuestionSet | null {
  const out: Record<string, unknown> = {}
  const layout: JevLayoutEntry[] = []

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]
    if (!Array.isArray(q.options) || q.options.length === 0) return null

    if (q.multiple) {
      for (let j = 0; j < q.options.length; j++) {
        const opt = q.options[j]
        const key = `q${i}_o${j}`
        out[key] = {
          type: "noul",
          instructions: `Question: "${q.question}" — should the option "${opt.label}" be selected? ${opt.description ?? ""}`.trim(),
        }
        layout.push({ kind: "noul", questionIndex: i, optionIndex: j, label: opt.label })
      }
    } else {
      const criteria: Record<string, string> = {}
      const seen = new Set<string>()
      for (const opt of q.options) {
        let key = opt.label
        let n = 1
        while (seen.has(key)) key = `${opt.label} (#${++n})`
        seen.add(key)
        criteria[key] = opt.description ?? ""
      }
      out[`q${i}`] = { type: "choice", instructions: q.question, criteria }
      layout.push({ kind: "choice", questionIndex: i, label: "" })
    }
  }

  return { questions: out, layout }
}

function stripDedupSuffix(key: string): string {
  const match = /^(.*) \(#\d+\)$/.exec(key)
  return match ? match[1] : key
}

function parseNoul(answer: unknown): { yes: boolean; probability: number } | null {
  const a = answer as { noul?: unknown; choice?: unknown; answer?: unknown } | undefined
  if (!a || typeof a !== "object") return null
  // Jev noul answers are probabilities, e.g. {"noul": 0.93}. Exactly 0.5 is
  // maximal uncertainty — treated as "no" (conservative: fewer selections).
  if (typeof a.noul === "number" && Number.isFinite(a.noul)) {
    const probability = clamp01(a.noul)
    return { yes: probability > 0.5, probability }
  }
  // Defensive fallbacks for non-probability shapes.
  if (typeof a.noul === "boolean") return { yes: a.noul, probability: a.noul ? 1 : 0 }
  if (a.choice === true || a.choice === "yes" || a.choice === "true") return { yes: true, probability: 1 }
  if (a.choice === false || a.choice === "no" || a.choice === "false") return { yes: false, probability: 0 }
  if (typeof a.answer === "boolean") return { yes: a.answer, probability: a.answer ? 1 : 0 }
  return null
}

function clamp01(n: unknown): number {
  const v = typeof n === "number" && Number.isFinite(n) ? n : 0
  return Math.min(1, Math.max(0, v))
}

export function parseJevResponse(
  set: JevQuestionSet,
  questions: QuestionInfo[],
  answers: Record<string, unknown>,
): { answers: string[][]; confidences: number[] } | null {
  const result: string[][] = questions.map(() => [])
  const confidences: number[] = questions.map(() => 0)
  const multiCertainty: number[] = questions.map(() => 1)

  for (const entry of set.layout) {
    if (entry.kind === "choice") {
      const a = answers[`q${entry.questionIndex}`] as { choice?: unknown; confidence?: unknown } | undefined
      if (!a || typeof a.choice !== "string") return null
      const label = stripDedupSuffix(a.choice)
      const q = questions[entry.questionIndex]
      if (!q.options.some((o) => o.label === label)) return null
      result[entry.questionIndex] = [label]
      confidences[entry.questionIndex] = clamp01(a.confidence)
    } else {
      const key = `q${entry.questionIndex}_o${entry.optionIndex}`
      const parsed = parseNoul(answers[key])
      if (!parsed) return null
      if (parsed.yes) result[entry.questionIndex].push(entry.label)
      // Certainty of this option's yes/no judgment: 1 when p is 0 or 1, 0.5 when borderline.
      const certainty = Math.max(parsed.probability, 1 - parsed.probability)
      multiCertainty[entry.questionIndex] = Math.min(multiCertainty[entry.questionIndex], certainty)
    }
  }

  for (let i = 0; i < questions.length; i++) {
    if (questions[i].multiple) confidences[i] = multiCertainty[i]
  }

  return { answers: result, confidences }
}

function formatQuestions(questions: QuestionInfo[]): string {
  const lines: string[] = []
  questions.forEach((q, i) => {
    lines.push(`${i + 1}. ${q.question}`)
    const opts = q.options.map((o) => `   - "${o.label}": ${o.description ?? ""}`).join("\n")
    if (opts) lines.push(opts)
    lines.push(`   (select ${q.multiple ? "all that apply" : "one"}${q.custom === false ? "" : "; custom answer allowed"})`)
  })
  return lines.join("\n")
}

export function buildLlmMessages(
  questions: QuestionInfo[],
  context: string | null,
): { system: string; user: string } {
  const system = [
    "You are an autonomous decision engine answering clarifying questions on behalf of a senior software engineer who is running an AI coding agent (opencode) unattended.",
    "The coding agent has paused to ask its user a question. Choose the answer the user would most likely give.",
    "Rules:",
    "- Answer every question.",
    '- Select option labels exactly as written. For multi-select questions, include every label that applies.',
    "- If no option is clearly right and the question accepts custom answers, you may provide a short custom answer instead.",
    "- Estimate confidence for each answer between 0.0 and 1.0. Be honest: use low confidence when you are guessing.",
    '- Respond with ONLY a JSON object (no markdown fences) matching exactly: {"answers": [["selected label", ...], ...], "confidences": [0.0, ...]}',
    "- answers: one array per question, in order, holding the selected option label(s) or a single custom answer string.",
    "- confidences: one number per question, in order.",
  ].join("\n")

  const lines: string[] = []
  if (context) {
    lines.push("Context gathered from the project and session history:")
    lines.push(context)
    lines.push("")
  }
  lines.push("Questions from the coding agent:")
  lines.push(formatQuestions(questions))

  return { system, user: lines.join("\n") }
}

/**
 * Prompt for the pass-0 decision agent (its system prompt lives in the
 * agents/auto-question-decide.md definition; this is the task message).
 */
export function buildAgentPrompt(
  questions: QuestionInfo[],
  guidance: string,
  context: string | null,
): string {
  const lines: string[] = []
  lines.push("Project guidance for answering these questions (follow it exactly; it overrides your general judgment):")
  lines.push(guidance)
  lines.push("")
  if (context) {
    lines.push("The coding agent's reasoning before asking:")
    lines.push(context)
    lines.push("")
  }
  lines.push("Questions from the coding agent:")
  lines.push(formatQuestions(questions))
  lines.push("")
  lines.push("Investigate the workspace with your tools as the guidance instructs, then decide the answers the user would give.")
  lines.push('Respond with ONLY a JSON object (no markdown fences, no prose): {"answers": [["selected label", ...], ...], "confidences": [0.0, ...], "covered": true}')
  lines.push("- answers: one array per question, in order, holding the selected option label(s) or a single custom answer string.")
  lines.push("- confidences: one number per question, in order. Be honest: use low confidence when you are guessing.")
  lines.push("- covered: true when the project guidance addresses these questions, false when it does not.")
  return lines.join("\n")
}

function extractJsonPayload(text: string): Record<string, unknown> | null {
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    const stripped = text.replace(/```(?:json)?/g, "").trim()
    const first = stripped.indexOf("{")
    const last = stripped.lastIndexOf("}")
    if (first === -1 || last <= first) return null
    try {
      payload = JSON.parse(stripped.slice(first, last + 1))
    } catch {
      return null
    }
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null
  return payload as Record<string, unknown>
}

function parseAnswersConfidences(
  p: Record<string, unknown>,
  questionCount: number,
): { answers: string[][]; confidences: number[] } | null {
  if (!Array.isArray(p.answers) || p.answers.length !== questionCount) return null
  const answers: string[][] = []
  for (const entry of p.answers) {
    if (typeof entry === "string") {
      answers.push([entry])
    } else if (Array.isArray(entry) && entry.every((s) => typeof s === "string")) {
      answers.push(entry)
    } else {
      return null
    }
  }
  const confidences: number[] = []
  if (Array.isArray(p.confidences) && p.confidences.length === questionCount) {
    for (const c of p.confidences) confidences.push(clamp01(c))
  } else {
    confidences.push(...questionCount === 0 ? [] : Array(questionCount).fill(0))
  }

  return { answers, confidences }
}

export function parseLlmResponse(
  text: string,
  questionCount: number,
): { answers: string[][]; confidences: number[] } | null {
  const p = extractJsonPayload(text)
  if (!p) return null
  return parseAnswersConfidences(p, questionCount)
}

/** Like parseLlmResponse, plus the agent engine's "covered" flag. */
export function parseAgentResponse(
  text: string,
  questionCount: number,
): { answers: string[][]; confidences: number[]; covered: boolean } | null {
  const p = extractJsonPayload(text)
  if (!p) return null
  const parsed = parseAnswersConfidences(p, questionCount)
  if (!parsed) return null
  return { ...parsed, covered: p.covered === true }
}
