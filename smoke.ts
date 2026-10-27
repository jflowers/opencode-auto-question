/**
 * Smoke test: loads the plugin with the real config file and a mock client,
 * then simulates a message.updated + question.asked sequence for a
 * non-autonomous agent (should no-op) and verifies hook wiring.
 * Run: bun run smoke.ts
 */
import pluginModule from "./src/index"

const calls: string[] = []
const mockClient = {
  session: {
    messages: async () => ({
      data: [
        { info: { role: "user", agent: "build", sessionID: "ses_test" }, parts: [] },
      ],
    }),
  },
}

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
console.log("hooks:", Object.keys(hooks))

if (typeof hooks.event !== "function") throw new Error("event hook missing")

// Simulate a user message event (agent tracking)
await hooks.event({
  event: {
    id: "evt_1",
    type: "message.updated",
    properties: { info: { role: "user", agent: "build", sessionID: "ses_test" } },
  },
})

// Simulate a question asked in a build session → not autonomous → human answers
await new Promise((resolve) => setTimeout(resolve, 50))
await hooks.event({
  event: {
    id: "evt_2",
    type: "question.asked",
    properties: {
      id: "que_smoke_1",
      sessionID: "ses_test",
      questions: [
        {
          question: "Which database?",
          header: "Database",
          options: [
            { label: "postgres", description: "Relational" },
            { label: "sqlite", description: "Embedded" },
          ],
        },
      ],
    },
  },
})
await new Promise((resolve) => setTimeout(resolve, 100))
console.log("smoke ok — check ~/.local/share/opencode-auto-question/log.txt")
