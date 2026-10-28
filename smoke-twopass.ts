/**
 * Smoke test for the two-pass confidence gate: Jev pass 1 returns low
 * confidence, the context subagent runs in a temp child session, and Jev
 * pass 2 (with gathered context) answers confidently.
 * Run: bun run smoke-twopass.ts
 */
import pluginModule from "./src/index"

process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? "smoke"

const httpCalls: Array<{ method: string; url: string; body: any }> = []
const mockClient: any = { session: { messages: async () => ({ data: [] }) } }
mockClient._client = {
  post: async (req: any) => {
    httpCalls.push({ method: "POST", url: req.url, body: req.body })
    if (req.url === "/session") return { data: { id: "ses_ctx" } }
    if (req.url === "/session/ses_ctx/message") {
      return {
        data: {
          info: { id: "msg_1", role: "assistant" },
          parts: [{ type: "text", text: "Session history shows this project previously chose sqlite for its zero-config nature." }],
        },
      }
    }
    return { data: {} }
  },
  delete: async (req: any) => {
    httpCalls.push({ method: "DELETE", url: req.url, body: undefined })
    return { data: undefined }
  },
}

let jevCalls = 0
const jevStates: string[] = []
const realFetch = globalThis.fetch
globalThis.fetch = (async (url: any, init?: any) => {
  if (String(url).includes("openrouter.ai")) {
    jevCalls++
    const body = JSON.parse(init!.body)
    jevStates.push(String(body.state))
    const confidence = jevCalls === 1 ? 0.2 : 0.9
    return new Response(
      JSON.stringify({
        id: `dec_${jevCalls}`,
        model: body.model,
        answers: { q0: { type: "choice", choice: "sqlite", confidence } },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }
  return realFetch(url, init)
}) as any

const input = {
  client: mockClient,
  project: "",
  directory: process.cwd(),
  worktree: process.cwd(),
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
await hooks.event({
  event: {
    id: "evt_2",
    type: "question.asked",
    properties: {
      id: "que_two_1",
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
    },
  },
})

// Wait for the delayed session cleanup (DELETE fires after 5s via setTimeout).
await new Promise((resolve) => setTimeout(resolve, 6000))
globalThis.fetch = realFetch

const reply = httpCalls.find((c) => c.url.includes("/reply"))
console.log("http calls:", JSON.stringify(httpCalls.map((c) => `${c.method} ${c.url}`), null, 2))
console.log("jev calls:", jevCalls)
console.log("jev state 2 includes context:", jevStates[1]?.includes("sqlite for its zero-config"))

if (jevCalls !== 2) throw new Error(`expected 2 jev calls, got ${jevCalls}`)
if (!httpCalls.some((c) => c.url === "/session")) throw new Error("context session not created")
if (!httpCalls.some((c) => c.url === "/session/ses_ctx/message")) throw new Error("context subagent not prompted")
if (!httpCalls.some((c) => c.method === "DELETE" && c.url === "/session/ses_ctx")) throw new Error("context session not cleaned up")
if (!jevStates[1]?.includes("sqlite for its zero-config")) throw new Error("pass 2 state missing gathered context")
if (!reply) throw new Error("no reply was sent")
if (reply.url !== "/question/que_two_1/reply") throw new Error(`unexpected reply url: ${reply.url}`)
if (JSON.stringify(reply.body) !== JSON.stringify({ answers: [["sqlite"]] })) {
  throw new Error(`unexpected reply body: ${JSON.stringify(reply.body)}`)
}
console.log("TWOPASS SMOKE OK — low confidence triggered context gathering, pass 2 replied")
