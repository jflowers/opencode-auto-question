/**
 * Smoke test for the autonomous path: mocks fetch (Jev API) and the raw
 * HTTP client, then simulates a question in an "autonomy" session.
 * Verifies the two-pass orchestrator replies over the V1 question endpoint.
 * Run: OPENROUTER_API_KEY=smoke bun run smoke-autonomy.ts
 */
import pluginModule from "./src/index"

process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? "smoke"

const httpCalls: Array<{ url: string; body: any }> = []
const mockClient: any = {
  session: {
    messages: async () => ({
      data: [{ info: { role: "user", agent: "autonomy", sessionID: "ses_auto" }, parts: [] }],
    }),
  },
}
mockClient._client = {
  post: async (req: any) => {
    httpCalls.push({ url: req.url, body: req.body })
    return { data: { id: "ses_child" }, response: { ok: true } }
  },
  delete: async () => ({ data: undefined }),
}

const realFetch = globalThis.fetch
globalThis.fetch = (async (url: any, init?: any) => {
  if (String(url).includes("openrouter.ai")) {
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
      id: "que_auto_1",
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

await new Promise((resolve) => setTimeout(resolve, 2000))
globalThis.fetch = realFetch

const reply = httpCalls.find((c) => c.url.includes("/reply"))
console.log("reply calls:", JSON.stringify(httpCalls, null, 2))
if (!reply) throw new Error("no reply was sent")
if (reply.url !== "/question/que_auto_1/reply") throw new Error(`unexpected reply url: ${reply.url}`)
if (JSON.stringify(reply.body) !== JSON.stringify({ answers: [["sqlite"]] })) {
  throw new Error(`unexpected reply body: ${JSON.stringify(reply.body)}`)
}
console.log("AUTONOMY SMOKE OK — high-confidence Jev answer replied in pass 1")
