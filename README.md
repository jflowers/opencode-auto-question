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
║ Jev Choice/Noul (OpenRouter Decisions API)    ║
║ or LLM JSON contract (chat completions)       ║
║ state = question + options only               ║
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

## Config

`~/.config/opencode/auto-question.jsonc` (JSONC with `{env:VAR}` interpolation). See [config/auto-question.jsonc](config/auto-question.jsonc) for all options:

| Option | Default | Meaning |
|---|---|---|
| `agents` | `["autonomy"]` | Session agents that trigger auto-answering |
| `engine` | `"auto"` | `"jev"`, `"llm"`, or `"auto"` (jev first, llm fallback) |
| `confidenceThreshold` | `0.6` | Pass 1 answers at or above this immediately |
| `fallbackThreshold` | `0.35` | After pass 2, below this goes to the human |
| `contextGathering.agent` | `"auto-question-ctx"` | Subagent that gathers context |
| `handlerTimeoutMs` | `120000` | Hard cap per question request |

## Notes

- Built for the opencode **1.19.x V1 plugin API**. It listens for `question.asked` (live on 1.19.0) and `question.v2.asked` (same payload shape) and replies over the server's question endpoints, so no tool interception is needed.
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
