# opencode-auto-question

An [opencode](https://opencode.ai) plugin that auto-answers the `question` tool when running with an autonomous agent — an AI decision engine answers on behalf of the human, with tool-assisted context gathering.

## How it works

```
question.asked event
        │
        ▼
Session agent in config "agents" list? ── NO ──▶ human answers (TUI form)
        │ YES
        ▼
╔══ PASS 1: fast decision ══════════════════════╗
║ Jev Choice/Noul (OpenCode Zen or OpenRouter)  ║
║ or LLM JSON contract (chat completions)       ║
║ state = immediate context + question + options ║
╚═══════════════════════════════════════════════╝
        │
  confidence ≥ confidenceThreshold (0.6)? ── YES ──▶ reply
        │ NO
        ▼
╔══ PASS 2: context-enriched decision ══════════╗
║ temp child session with a context-gathering   ║
║ subagent (has dewey, session-search, ...)     ║
║ → re-decide with gathered context as state    ║
╚═══════════════════════════════════════════════╝
        │
  confidence ≥ fallbackThreshold (0.35)? ── YES ──▶ reply
        │ NO
        ▼
   human answers (TUI form)
```

Every failure mode (API errors, timeouts, unparsable responses, config problems) degrades to the human answering via the normal TUI form.

## Install

```bash
# 1. Symlink agents
mkdir -p ~/.config/opencode/agents
ln -s "$PWD/agents/autonomy.md" ~/.config/opencode/agents/autonomy.md
ln -s "$PWD/agents/auto-question-ctx.md" ~/.config/opencode/agents/auto-question-ctx.md

# 2. Copy config (edit to taste)
cp config/auto-question.jsonc ~/.config/opencode/auto-question.jsonc

# 3. Register the plugin — add to the "plugin" array in ~/.config/opencode/opencode.jsonc:
#    "/absolute/path/to/opencode-auto-question"

# 4. Restart opencode
```

Switch a session to the `autonomy` agent, then trigger any question — the decision engine answers it.

> **Important — custom agents need permission overrides to match `build`**: opencode's base permission ruleset denies `question` and `plan_enter` for every agent, and sets `external_directory` to `ask`; the built-in `build` agent overrides `question` and `plan_enter` back to allow, but custom agents do not (without `question: allow` the model never sees the question tool; without `plan_enter: allow` the agent cannot enter plan mode like build; without `external_directory: allow` every cross-repo file access prompts for human approval, blocking unattended sessions). `agents/autonomy.md` includes the required frontmatter:
>
> ```yaml
> permission:
>   question: allow
>   plan_enter: allow
>   external_directory: allow
> ```
>
> If you use a different autonomous agent, add the same overrides to its frontmatter.

## Config

`~/.config/opencode/auto-question.jsonc` (JSONC with `{env:VAR}` interpolation). See [config/auto-question.jsonc](config/auto-question.jsonc) for all options:

| Option | Default | Meaning |
|---|---|---|
| `agents` | `["autonomy"]` | Session agents that trigger auto-answering |
| `engine` | `"auto"` | `"jev"`, `"llm"`, or `"auto"` (jev first, llm fallback) |
| `jev` | auto-discovered | Carrier: explicit `apiKey`+`baseUrl`+`model` in config, else `OPENCODE_API_KEY` → OpenCode Zen (`jev-1.13`, ~$0.000013/call), else `OPENROUTER_API_KEY` → OpenRouter (`typesafe/jev-1.14`) |
| `confidenceThreshold` | `0.6` | Pass 1 answers at or above this immediately |
| `fallbackThreshold` | `0.35` | After pass 2, below this goes to the human |
| `immediateContext` | `true` | Fetch the model's reasoning text from the assistant message that called the question tool (tables, recommendations, etc.) and include as context for the decision engine |
| `contextGathering.agent` | `"auto-question-ctx"` | Subagent that gathers context |
| `handlerTimeoutMs` | `120000` | Hard cap per question request |

## Notes

- Built for the opencode **1.19.x V1 plugin API**. It listens for `question.asked` (live on 1.19.0) and `question.v2.asked` (same payload shape) and replies over the server's question endpoints, so no tool interception is needed.
- **Jev carriers**: explicit config values always win; otherwise the plugin auto-discovers — `OPENCODE_API_KEY` (from `opencode /connect`) routes to OpenCode Zen with `jev-1.13` (~$0.000013/call; `jev-1.13-free` works only after allowing free endpoints in the workspace Privacy settings); `OPENROUTER_API_KEY` routes to the OpenRouter Decisions API with `typesafe/jev-1.14`. Zen serves bare model IDs; OpenRouter needs the prefixed slug (`jev-latest` is not valid on Zen — pin a version). Guard rail: an OpenRouter key (`sk-or-...`) placed in `OPENCODE_API_KEY` is detected and routed to OpenRouter (with a warning in the log) instead of failing at Zen with 401.
- **Noul semantics**: Jev multi-select (`noul`) answers are probabilities in `[0,1]`, not booleans. An option is selected when `noul > 0.5` (exactly 0.5 is maximal uncertainty and selects nothing); question confidence is the weakest option certainty (`min over options of max(p, 1-p)`), so a borderline option triggers context gathering.
- Session-agent detection uses user-message events plus a session-messages fallback (the v1.19 session type has no agent field).
- Context gathering creates a temporary child session (deleted afterwards) that inherits the project directory, so per-project tools like dewey MCP are available to the context subagent.
- Decisions and errors are logged to `~/.local/share/opencode-auto-question/log.txt` (set `"verbose": true` for debug detail).
- If the human answers first, the plugin's reply fails harmlessly (the pending request is gone) and it moves on.

## Development

```bash
bun install
bun run typecheck   # tsc --noEmit
bun test            # unit tests (no network)
```
