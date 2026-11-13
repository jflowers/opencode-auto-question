import { describe, expect, test } from "bun:test"
import { BUNDLED_AGENTS, bundledAgentsDir, loadBundledAgents, parseAgentMarkdown, registerAgents } from "./agents"

describe("bundled agents", () => {
  test("the shipped agents/ directory is found from the source tree", () => {
    expect(bundledAgentsDir()).toEndWith("/agents/")
  })

  test("every bundled agent parses with its prompt and frontmatter", () => {
    const agents = loadBundledAgents()
    expect(Object.keys(agents)).toEqual([...BUNDLED_AGENTS])
    expect(agents.autonomy).toMatchObject({
      mode: "primary",
      permission: { question: "allow", plan_enter: "allow", external_directory: "allow" },
    })
    expect(agents.autonomy!.prompt).toStartWith("You are the autonomous build agent.")
    for (const name of ["auto-question-ctx", "auto-question-decide"] as const) {
      expect(agents[name]).toMatchObject({ mode: "subagent", hidden: true })
      expect(agents[name]!.prompt.length).toBeGreaterThan(100)
      expect(agents[name]!.prompt).not.toContain("---")
    }
  })

  test("a missing agents directory throws", () => {
    expect(() => loadBundledAgents("/nonexistent/agents/")).toThrow()
  })
})

describe("parseAgentMarkdown", () => {
  test("scalars, booleans, quotes and one nested mapping", () => {
    const def = parseAgentMarkdown(
      '---\ndescription: "Has: a colon"\nmode: subagent\nhidden: true\npermission:\n  question: allow\n  edit: deny\n---\n\nBody text.\n',
    )
    expect(def).toEqual({
      description: "Has: a colon",
      mode: "subagent",
      hidden: true,
      permission: { question: "allow", edit: "deny" },
      prompt: "Body text.",
    })
  })

  test("rejects what it does not understand instead of dropping it", () => {
    expect(() => parseAgentMarkdown("no frontmatter")).toThrow(/missing frontmatter/)
    expect(() => parseAgentMarkdown("---\nmodel: x/y\n---\nb")).toThrow(/unsupported frontmatter key "model"/)
    expect(() => parseAgentMarkdown("---\n  question: allow\n---\nb")).toThrow(/without a parent key/)
    expect(() => parseAgentMarkdown("---\n- item\n---\nb")).toThrow(/unsupported frontmatter line/)
    expect(() => parseAgentMarkdown("---\nhidden: maybe\n---\nb")).toThrow(/hidden must be true or false/)
  })
})

describe("registerAgents", () => {
  const agents = { a: { prompt: "A" }, b: { prompt: "B", mode: "subagent" } }

  test("adds every agent to an empty config", () => {
    const config: { agent?: Record<string, unknown> } = {}
    expect(registerAgents(config, agents)).toEqual({ added: ["a", "b"], filledIn: [] })
    expect(config.agent).toEqual({ a: { prompt: "A" }, b: { prompt: "B", mode: "subagent" } })
  })

  test("a user's settings win over the bundled ones", () => {
    const config = { agent: { a: { prompt: "mine", model: "x/y" } } as Record<string, unknown> }
    expect(registerAgents(config, agents)).toEqual({ added: ["b"], filledIn: ["a"] })
    expect(config.agent.a).toEqual({ prompt: "mine", model: "x/y" })
  })

  test("a permissions-only override keeps the bundled prompt, mode and other permissions", () => {
    // The shape of a project overlay's .opencode/opencode.json (dewey,
    // unbound-force, ...): it only narrows external_directory for autonomy.
    const overlay = {
      permission: {
        external_directory: { "*": "deny", "~/Projects/github/unbound-force/dewey/**": "allow", "/tmp/**": "allow" },
      },
    }
    const config = { agent: { autonomy: overlay } as Record<string, unknown> }
    const bundled = loadBundledAgents()
    expect(registerAgents(config, { autonomy: bundled.autonomy! })).toEqual({ added: [], filledIn: ["autonomy"] })
    expect(config.agent.autonomy).toEqual({
      description: bundled.autonomy!.description,
      mode: "primary",
      prompt: bundled.autonomy!.prompt,
      permission: {
        question: "allow",
        plan_enter: "allow",
        external_directory: overlay.permission.external_directory,
      },
    })
  })

  test("nested settings merge key by key, and the user's value wins on a conflict", () => {
    const config = {
      agent: { a: { permission: { question: "deny", edit: "ask" } } } as Record<string, unknown>,
    }
    registerAgents(config, { a: { prompt: "A", permission: { question: "allow", plan_enter: "allow" } } })
    expect(config.agent.a).toEqual({
      prompt: "A",
      permission: { question: "deny", plan_enter: "allow", edit: "ask" },
    })
  })

  test("a disabled agent stays disabled", () => {
    const config = { agent: { a: { disable: true } } as Record<string, unknown> }
    registerAgents(config, agents)
    expect(config.agent.a).toEqual({ prompt: "A", disable: true })
  })

  test("registered definitions are copies, not the shared originals", () => {
    const shared = { a: { prompt: "A", permission: { question: "allow" } } }
    const config: { agent?: Record<string, unknown> } = {}
    registerAgents(config, shared)
    expect(config.agent!.a).not.toBe(shared.a)
    ;(config.agent!.a as { permission: Record<string, string> }).permission.question = "deny"
    expect(shared.a.permission.question).toBe("allow")
  })
})
