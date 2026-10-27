import type { QuestionInfo } from "./types"

/**
 * Mapping between question-tool payloads and the two decision engines.
 *
 * Jev Decisions API primitives:
 *   choice — "which option?" → { type: "choice", instructions, criteria: {label: description} }
 *   noul   — "yes/no?"        → { type: "noul", instructions }
 * Single-select questions map to one choice question; multi-select questions
 * map to one noul question per option.
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

function parseNoul(answer: unknown): boolean | null {
  const a = answer as { noul?: unknown; choice?: unknown; answer?: unknown } | undefined
  if (!a || typeof a !== "object") return null
  if (typeof a.noul === "boolean") return a.noul
  if (a.choice === true || a.choice === "yes" || a.choice === "true") return true
  if (a.choice === false || a.choice === "no" || a.choice === "false") return false
  if (typeof a.answer === "boolean") return a.answer
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
      const yes = parseNoul(answers[key])
      if (yes === null) return null
      if (yes) result[entry.questionIndex].push(entry.label)
      const a = answers[key] as { confidence?: unknown } | undefined
      confidences[entry.questionIndex] = Math.max(confidences[entry.questionIndex], clamp01(a?.confidence))
    }
  }

  return { answers: result, confidences }
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
  questions.forEach((q, i) => {
    lines.push(`${i + 1}. ${q.question}`)
    const opts = q.options.map((o) => `   - "${o.label}": ${o.description ?? ""}`).join("\n")
    if (opts) lines.push(opts)
    lines.push(`   (select ${q.multiple ? "all that apply" : "one"}${q.custom === false ? "" : "; custom answer allowed"})`)
  })

  return { system, user: lines.join("\n") }
}

export function parseLlmResponse(
  text: string,
  questionCount: number,
): { answers: string[][]; confidences: number[] } | null {
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

  const p = payload as { answers?: unknown; confidences?: unknown }
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
