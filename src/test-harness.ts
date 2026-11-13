/**
 * Test-only harness for driving handleQuestionAsked end to end without a
 * server or network: a fake opencode HTTP client (question replies, session
 * summaries, child sessions for subagents, session messages) and a stubbed
 * global fetch serving the LLM engine's chat-completions contract.
 *
 * Not a *.test.ts file, so bun does not run it directly.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_CONFIG } from "./config"
import { AgentTracker } from "./detect"
import type { HandlerDeps } from "./orchestrator"
import type { Config, QuestionInfo, QuestionRequest } from "./types"

type EngineDecision = { answers: string[][]; confidences: number[] }

/**
 * One LLM engine response: a decision, an HTTP error status, a fetch that
 * never settles, or a decision that arrives after a delay.
 */
export type EngineReply = EngineDecision | { status: number } | "hang" | { delayMs: number; reply: EngineDecision }

/** Subagent replies keyed by child-session title prefix ("auto-question: decision" / "...: context gathering"). */
export type SubagentReplies = Partial<Record<"decision" | "context", string | null>>

export interface HarnessOptions {
  /** Session agent recorded by the tracker; undefined leaves it unknown. */
  agent?: string
  /** LLM engine replies, consumed in order; the last one repeats. */
  engine?: EngineReply[]
  subagents?: SubagentReplies
  /** Guidance markdown written to the project guidance dir (enables pass 0). */
  guidance?: string
  /** Assistant message text served for request.tool.messageID (immediate context). */
  assistantText?: string
  config?: Partial<Config>
}

export interface Harness {
  deps: HandlerDeps
  /** Every POST to the opencode HTTP client, in order. */
  posts: Array<{ url: string; body: any }>
  /** Bodies of every LLM chat-completions request. */
  engineRequests: any[]
  replies(): Array<{ url: string; body: any }>
  summaries(): string[]
  /** Titles of child sessions created for subagents. */
  childSessions(): string[]
  cleanup(): void
}

export function question(text: string, header = "Choice"): QuestionInfo {
  return {
    question: text,
    header,
    options: [
      { label: "sqlite", description: "embedded" },
      { label: "postgres", description: "server" },
    ],
  }
}

export function request(questions: QuestionInfo[], tool?: QuestionRequest["tool"]): QuestionRequest {
  return { id: "que_1", sessionID: "ses_1", questions, ...(tool ? { tool } : {}) }
}

const realFetch = globalThis.fetch

export function createHarness(opts: HarnessOptions = {}): Harness {
  const projectDir = mkdtempSync(join(tmpdir(), "aq-harness-"))
  try {
    if (opts.guidance !== undefined) {
      const dir = join(projectDir, ".opencode", "auto-question", "guidance")
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, "guidance.md"), opts.guidance)
    }
  } catch (e) {
    // The caller never receives a harness to clean up, so clean up here.
    rmSync(projectDir, { recursive: true, force: true })
    throw e
  }

  const posts: Array<{ url: string; body: any }> = []
  const engineRequests: any[] = []
  const childTitles = new Map<string, string>()
  const engine = opts.engine ?? []
  let engineCall = 0

  // Installed as globalThis.fetch only once setup is complete (see the end of
  // this function), so a throw during setup cannot leak the stub to other tests.
  const stubFetch = (async (_url: unknown, init?: { body?: string }) => {
    engineRequests.push(init?.body ? JSON.parse(init.body) : null)
    const reply = engine[Math.min(engineCall++, engine.length - 1)]
    if (reply === undefined) throw new Error("no engine reply configured")
    if (reply === "hang") return new Promise<Response>(() => {})
    if ("status" in reply) return new Response("upstream error", { status: reply.status })
    let decision: EngineDecision
    if ("delayMs" in reply) {
      await new Promise((resolve) => setTimeout(resolve, reply.delayMs))
      decision = reply.reply
    } else {
      decision = reply
    }
    const content = JSON.stringify(decision)
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })
  }) as unknown as typeof fetch

  const userInfo = { role: "user", agent: opts.agent ?? "autonomy", model: { providerID: "p", modelID: "m" } }
  const httpClient = {
    get: async ({ url }: { url: string }) => {
      if (url === "/session/ses_1/message") {
        const messages: any[] = [{ info: userInfo, parts: [] }]
        if (opts.assistantText !== undefined) {
          messages.push({ info: { id: "msg_a", role: "assistant" }, parts: [{ type: "text", text: opts.assistantText }] })
        }
        return { data: messages }
      }
      return { data: [] }
    },
    post: async ({ url, body }: { url: string; body: any }) => {
      posts.push({ url, body })
      if (url === "/session") {
        const id = `child_${childTitles.size + 1}`
        childTitles.set(id, String(body?.title ?? ""))
        return { data: { id } }
      }
      const child = /^\/session\/(child_\d+)\/message$/.exec(url)
      if (child) {
        const title = childTitles.get(child[1]!) ?? ""
        const key = title.endsWith("decision") ? "decision" : "context"
        const text = opts.subagents?.[key]
        return { data: { parts: text ? [{ type: "text", text }] : [] } }
      }
      return { data: {} }
    },
    delete: async () => ({ data: {} }),
  }

  const config: Config = {
    ...structuredClone(DEFAULT_CONFIG),
    engine: "llm",
    llm: { ...DEFAULT_CONFIG.llm, apiKey: "test-key" },
    guidance: { ...DEFAULT_CONFIG.guidance, globalPath: join(projectDir, "no-global-guidance") },
    immediateContext: false,
    sessionSummary: true,
    ...opts.config,
  }
  const tracker = new AgentTracker()
  if (opts.agent !== undefined) tracker.trackMessage({ sessionID: "ses_1", role: "user", agent: opts.agent })
  const client = {
    _client: httpClient,
    // AgentTracker.resolve fallback when no agent was tracked.
    session: { messages: async () => ({ data: [] }) },
  }
  const deps: HandlerDeps = { input: { client } as any, config, tracker, settled: new Set(), projectDir }

  globalThis.fetch = stubFetch

  const isReply = (p: { url: string }) => p.url.endsWith("/reply")
  const isSummary = (p: { url: string; body: any }) => p.url === "/session/ses_1/message" && p.body?.noReply === true
  return {
    deps,
    posts,
    engineRequests,
    replies: () => posts.filter(isReply),
    summaries: () => posts.filter(isSummary).map((p) => p.body.parts[0].text as string),
    childSessions: () => [...childTitles.values()],
    cleanup: () => {
      globalThis.fetch = realFetch
      rmSync(projectDir, { recursive: true, force: true })
    },
  }
}
