# opencode-auto-question

opencode plugin that auto-answers the `question` tool for autonomous agents.
Jev (OpenRouter Decisions API) or LLM JSON-contract decision engines, two-pass
confidence gate with subagent context gathering, human fallback.

- Plugin entry: `src/index.ts` (V1 plugin API, opencode 1.19.x)
- Config: `~/.config/opencode/auto-question.jsonc` (template in `config/`)
- Agents: `agents/*.md` (symlinked into `~/.config/opencode/agents/`)
- Log: `~/.local/share/opencode-auto-question/log.txt`

Verify changes with `bun run typecheck && bun test`. Runtime imports are
type-only (`import type`); the host provides the plugin SDK.
