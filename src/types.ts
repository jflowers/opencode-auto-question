/**
 * Shared types for the auto-question plugin.
 *
 * Question shapes mirror the opencode v1.19 `question.asked` /
 * `question.v2.asked` event payloads (packages/schema/src/v1/question.ts).
 */

export interface QuestionOption {
  label: string
  description: string
}

export interface QuestionInfo {
  question: string
  header: string
  options: QuestionOption[]
  multiple?: boolean
  custom?: boolean
}

export interface QuestionRequest {
  /** Starts with "que_" */
  id: string
  sessionID: string
  questions: QuestionInfo[]
  tool?: { messageID?: string; callID?: string }
}

export type EngineName = "jev" | "llm"

export interface JevConfig {
  model: string
  baseUrl: string
  apiKey: string
  timeoutMs: number
}

export interface LlmConfig {
  /** OpenAI-compatible base URL, e.g. https://api.enmaas.devshift.net/v1 */
  baseUrl: string
  apiKey: string
  model: string
  timeoutMs: number
}

export interface ContextGatheringConfig {
  agent: string
  timeoutMs: number
}

export interface Config {
  enabled: boolean
  /** Session agent names that trigger auto-answering. */
  agents: string[]
  engine: "jev" | "llm" | "auto"
  jev: JevConfig
  llm: LlmConfig
  /** Pass 1 (no context) answers at or above this confidence immediately. */
  confidenceThreshold: number
  /** After pass 2, answers at or above this confidence are sent; below goes to the human. */
  fallbackThreshold: number
  contextGathering: ContextGatheringConfig
  /** Fetch the assistant message text (model reasoning) that triggered the question tool call. */
  immediateContext: boolean
  /** Inject a summary message into the session history after auto-answering or deferring to human. */
  sessionSummary: boolean
  /** Hard cap for the entire auto-answer attempt per question request. */
  handlerTimeoutMs: number
  verbose: boolean
}

export interface Decision {
  ok: boolean
  /** One array of selected labels (or a single custom answer) per question. */
  answers: string[][]
  /** One confidence in [0,1] per question. */
  confidences: number[]
  engine: EngineName
  error?: string
}
