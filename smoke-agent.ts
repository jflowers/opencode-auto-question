/**
 * Smoke test for the pass-0 guidance agent: creates a temp project with a
 * guidance doc, mocks the raw HTTP client and fetch (decision engines), then
 * simulates questions in an "autonomy" session.
 *
 * Scenario 1: confident covered answer with custom text → replied in pass 0.
 * Scenario 2: covered but low confidence → deferred to human (no reply).
 * Scenario 3: not covered → falls through to pass 1 (engine) → replied.
 *
 * Run: OPENROUTER_API_KEY=smoke bun run smoke-agent.ts
 */
import pluginModule from "./src/index"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? "smoke"

const projectDir = mkdtempSync(join(tmpdir(), "aq-smoke-agent-"))
const guidanceDir = join(projectDir, ".opencode/auto-question/guidance")
mkdirSync(guidanceDir, { recursive: true })
writeFileSync(
  join(guidanceDir, "uncommitted-files.md"),
  [
    "# Uncommitted files before new work",
    "",
    "When the agent asks what to do about uncommitted files before starting something new,",
    "investigate with git status whether those files are dewey learnings. If they are dewey",
    'learnings, answer with the custom text: "please create a chore PR for the dewey learnings',
    'and then continue"',
    "If they are not dewey learnings, the guidance does not apply: covered false, low confidence.",
    "",
  ].join("\n"),
)

const httpCalls: Array<{ url: string; body: any }> = []
let agentText = ""
const mockClient: any = {
  session: {
    messages: async () => ({
      data: [{ info: { role: "user", agent: "autonomy", sessionID: "ses_auto" }, parts: [] }],
    }),
  },
}
mockClient._client = {
  get: async () => ({ data: [] }),
  post: async (req: any) => {
    httpCalls.push({ url: req.url, body: req.body })
    if (req.url === "/session") return { data: { id: "ses_child" } }
    if (req.url === "/session/ses_child/message") {
      return { data: { parts: [{ type: "text", text: agentText }] } }
    }
    return { data: {} }
  },
  delete: async () => ({ data: undefined }),
}

const realFetch = globalThis.fetch
globalThis.fetch = (async (url: any, init?: any) => {
  const u = String(url)
  if (u.includes("openrouter.ai") || u.includes("opencode.ai/zen")) {
    const body = JSON.parse(init!.body)
    console.log("jev call:", JSON.stringify(body.questions))
    return new Response(
      JSON.stringify({
        id: "dec_1",
        model: body.model,
        answers: {
          q0: { type: "choice", choice: "sqlite", confidence: 0.92, probabilities: { sqlite: 0.92, postgres: 0.08 } },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }
  if (u.includes("enmaas")) {
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: '{"answers": [["sqlite"]], "confidences": [0.92]}' } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }
  return realFetch(url, init)
}) as any

const input = {
  client: mockClient,
  project: "",
  directory: projectDir,
  worktree: projectDir,
  serverUrl: new URL("http://localhost"),
  experimental_workspace: { register: () => {} },
  $: {} as any,
} as any

const hooks = await pluginModule.server(input, {})

await hooks.event({
  event: {
    id: "evt_1",
    type: "message.updated",
    properties: { info: { role: "user", agent: "autonomy", sessionID: "ses_auto" } },
  },
})

function uncommittedQuestion(id: string) {
  return {
    id,
    sessionID: "ses_auto",
    questions: [
      {
        question: "What should I do about the uncommitted files before starting something new?",
        header: "Uncommitted files",
        options: [
          { label: "commit them", description: "Commit onto the current branch" },
          { label: "stash them", description: "Stash for later" },
        ],
      },
    ],
  }
}

async function ask(properties: any): Promise<void> {
  await hooks.event({ event: { id: `evt_${properties.id}`, type: "question.asked", properties } })
  await new Promise((resolve) => setTimeout(resolve, 1500))
}

function replyFor(id: string) {
  return httpCalls.find((c) => c.url === `/question/${id}/reply`)
}

function summaries(): string[] {
  return httpCalls
    .filter((c) => c.url === "/session/ses_auto/message" && c.body?.noReply === true)
    .map((c) => c.body.parts[0].text as string)
}

// --- Scenario 1: confident covered custom answer → pass 0 reply ------------
agentText = JSON.stringify({
  answers: [["please create a chore PR for the dewey learnings and then continue"]],
  confidences: [0.9],
  covered: true,
})
await ask(uncommittedQuestion("que_agent_1"))

const reply1 = replyFor("que_agent_1")
if (!reply1) throw new Error("scenario 1: no reply was sent")
if (JSON.stringify(reply1.body) !== JSON.stringify({
  answers: [["please create a chore PR for the dewey learnings and then continue"]],
})) {
  throw new Error(`scenario 1: unexpected reply body: ${JSON.stringify(reply1.body)}`)
}

const childCreate = httpCalls.find((c) => c.url === "/session")
if (!childCreate || childCreate.body.parentID !== "ses_auto") {
  throw new Error("scenario 1: child session was not created with parentID ses_auto")
}
const childMessage = httpCalls.find((c) => c.url === "/session/ses_child/message")
if (!childMessage || childMessage.body.agent !== "auto-question-decide" || childMessage.body.tools?.question !== false) {
  throw new Error("scenario 1: decision agent message malformed")
}
const s1summary = summaries().find((t) => t.includes("pass 0"))
console.log("scenario 1 summary:", s1summary ?? "(none)")

// --- Scenario 2: covered but low confidence → deferred to human ------------
agentText = JSON.stringify({
  answers: [["commit them"]],
  confidences: [0.3],
  covered: true,
})
await ask(uncommittedQuestion("que_agent_2"))

if (replyFor("que_agent_2")) throw new Error("scenario 2: reply must NOT be sent for covered low confidence")
const s2summary = summaries().find((t) => t.includes("guidance covered the question"))
console.log("scenario 2 summary:", s2summary ?? "(none)")
if (!s2summary) console.log("  (sessionSummary may be disabled in the local config — soft check)")

// --- Scenario 3: not covered → falls through to pass 1 engine --------------
agentText = JSON.stringify({
  answers: [["stash them"]],
  confidences: [0.2],
  covered: false,
})
await ask({
  id: "que_agent_3",
  sessionID: "ses_auto",
  questions: [
    {
      question: "Which database?",
      header: "Database",
      options: [
        { label: "postgres", description: "Relational, mature" },
        { label: "sqlite", description: "Embedded, zero-config" },
      ],
    },
  ],
})

const reply3 = replyFor("que_agent_3")
if (!reply3) throw new Error("scenario 3: no reply was sent after falling through to pass 1")
if (JSON.stringify(reply3.body) !== JSON.stringify({ answers: [["sqlite"]] })) {
  throw new Error(`scenario 3: unexpected reply body: ${JSON.stringify(reply3.body)}`)
}
const s3summary = summaries().find((t) => t.includes("pass 1"))
console.log("scenario 3 summary:", s3summary ?? "(none)")

globalThis.fetch = realFetch
rmSync(projectDir, { recursive: true, force: true })

console.log("AGENT SMOKE OK — pass 0 replies, covered deferral, and fall-through all verified")
