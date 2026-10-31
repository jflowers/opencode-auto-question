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
╔══ PASS 0: project guidance decision ═════════╗
║ Only when guidance docs exist:               ║
║ temp child session with a tool-using decision║
║ subagent (git, dewey, file reads, ...)       ║
║ investigates per .opencode/.../guidance/*.md ║
║ → can answer "Type your own answer" text     ║
╚══════════════════════════════════════════════╝
        │
  guidance agent ran? ── NO ──▶ pass 1
        │ YES
        ▼
  confidence ≥ confidenceThreshold (0.6)? ── YES ──▶ reply
        │ NO
        ▼
  guidance covered the question? ── YES ──▶ human answers (no generic
        │ NO                                    engine override)
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
ln -s "$PWD/agents/auto-question-decide.md" ~/.config/opencode/agents/auto-question-decide.md

# 2. Copy config (edit to taste)
cp config/auto-question.jsonc ~/.config/opencode/auto-question.jsonc

# 3. Register the plugin — add to the "plugin" array in ~/.config/opencode/opencode.jsonc:
#    "/absolute/path/to/opencode-auto-question"

# 4. Restart opencode
```

Switch a session to the `autonomy` agent, then trigger any question — the decision engine answers it.

> **Important — custom agents need permission overrides**: opencode's base permission ruleset denies `question` and `plan_enter` for every agent, and sets `external_directory` to `ask`. The built-in `build` agent overrides `question` and `plan_enter` back to allow but leaves `external_directory` as `ask` (humans click "Allow always"). Custom agents don't get any overrides automatically.
>
> Without these permissions:
> - `question: allow` — the model never sees the question tool
> - `plan_enter: allow` — the agent cannot enter plan mode
> - `external_directory: allow` — every cross-repo file access blocks the session waiting for human approval
>
> `agents/autonomy.md` includes the required frontmatter:
>
> ```yaml
> permission:
>   question: allow
>   plan_enter: allow
>   external_directory: allow
> ```
>
> If you use a different autonomous agent, add the same overrides to its frontmatter.

### Scoping `external_directory` per project

`external_directory: allow` in the agent definition grants access to **all files on the filesystem**. For tighter control, override the permission per project in `.opencode/opencode.json` (or `opencode.json` at the project root) instead of in the agent definition:

```json
{
  "agent": {
    "autonomy": {
      "permission": {
        "external_directory": {
          "~/Projects/github/my-org/**": "allow",
          "*": "ask"
        }
      }
    }
  }
}
```

This auto-allows access to sibling repos under the same org while prompting for anything else. Project-level config overrides the global agent definition.

**Pattern rules:**
- `~/` and `$HOME` expand to the home directory — these are the only supported variables
- Patterns must be absolute paths or use `~/`; relative paths (`../**`, `./**`) do not work
- Glob syntax: `*` matches a single segment, `**` matches any depth
- Last matching rule wins (put broad rules first, narrow rules last)

**Other permissions that may block unattended sessions:**

| Permission | Base default | Notes |
|---|---|---|
| `doom_loop` | `ask` | Prompts when the agent appears stuck in a retry loop |
| `read` (`.env` files) | `ask` for `*.env`, `*.env.*` | Prompts when reading environment files |

Add these to the agent or project config if they interrupt your autonomous workflows:

```yaml
# in agent frontmatter
permission:
  question: allow
  plan_enter: allow
  external_directory: allow
  doom_loop: allow
```

## Project guidance (pass 0)

Drop markdown files into `.opencode/auto-question/guidance/` in a project (and/or `~/.config/opencode/auto-question/guidance/` globally — global docs load first, project docs after) to steer how questions from autonomous agents are answered. When guidance exists, a tool-using decision agent runs **before** the Jev/LLM engines: it investigates the workspace with real tools (git, file reads, dewey MCP, session search) following your guidance, then answers — including "Type your own answer" custom replies, which Jev alone can never produce.

Example — `.opencode/auto-question/guidance/uncommitted-files.md`:

```markdown
# Uncommitted files before new work

When the agent asks what to do about uncommitted files before starting
something new, investigate with `git status` whether those files are dewey
learnings. If they are dewey learnings, answer with the custom text:
"please create a chore PR for the dewey learnings and then continue"
If they are not dewey learnings, the guidance does not apply — report
covered: false and answer honestly at low confidence.
```

Semantics:

- **Confident + covered** → the agent's answer is sent immediately (summary shows `pass 0`).
- **Covered but low confidence** → the question goes to the human. The generic engines never override project policy.
- **Not covered** (guidance doesn't address the question) → falls through to the normal pass 1/pass 2 flow.
- **Agent failure/timeout** → falls through to the normal flow. Guidance loading itself can never break the plugin.
- Guidance is re-read on every question, so edits go live without restarting opencode. Docs are concatenated in filename order and capped at `guidance.maxChars`.
- Write both branches (what to do when the guidance applies, and what to do when it doesn't) — an unfinished "else" tends to produce low-confidence deferrals.

When no guidance documents exist anywhere, pass 0 is skipped entirely and behavior is unchanged.

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
| `sessionSummary` | `true` | Inject a summary message into the session history after auto-answering or deferring to human (visible in the TUI, hidden from the model, keeps the session's agent/model) |
| `contextGathering.agent` | `"auto-question-ctx"` | Subagent that gathers context |
| `agentDecision.agent` | `"auto-question-decide"` | Pass-0 decision subagent that answers following project guidance |
| `agentDecision.timeoutMs` | `60000` | Timeout for the pass-0 decision agent |
| `guidance.enabled` | `true` | Set `false` to disable pass 0 entirely |
| `guidance.projectPath` | `".opencode/auto-question/guidance"` | Project guidance dir (relative to project root or absolute) |
| `guidance.globalPath` | `"~/.config/opencode/auto-question/guidance"` | Global guidance dir |
| `guidance.maxChars` | `20000` | Total guidance characters passed to the decision agent |
| `handlerTimeoutMs` | `120000` | Hard cap per question request |

## Notes

- Built for the opencode **1.19.x V1 plugin API**. It listens for `question.asked` (live on 1.19.0) and `question.v2.asked` (same payload shape) and replies over the server's question endpoints, so no tool interception is needed.
- **Jev carriers**: explicit config values always win; otherwise the plugin auto-discovers — `OPENCODE_API_KEY` (from `opencode /connect`) routes to OpenCode Zen with `jev-1.13` (~$0.000013/call; `jev-1.13-free` works only after allowing free endpoints in the workspace Privacy settings); `OPENROUTER_API_KEY` routes to the OpenRouter Decisions API with `typesafe/jev-1.14`. Zen serves bare model IDs; OpenRouter needs the prefixed slug (`jev-latest` is not valid on Zen — pin a version). Guard rail: an OpenRouter key (`sk-or-...`) placed in `OPENCODE_API_KEY` is detected and routed to OpenRouter (with a warning in the log) instead of failing at Zen with 401.
- **Noul semantics**: Jev multi-select (`noul`) answers are probabilities in `[0,1]`, not booleans. An option is selected when `noul > 0.5` (exactly 0.5 is maximal uncertainty and selects nothing); question confidence is the weakest option certainty (`min over options of max(p, 1-p)`), so a borderline option triggers context gathering.
- Session-agent detection uses user-message events plus a session-messages fallback (the v1.19 session type has no agent field).
- Context gathering creates a temporary child session (deleted afterwards) that inherits the project directory, so per-project tools like dewey MCP are available to the context subagent.
- The pass-0 decision agent runs in the same kind of temporary child session; the project directory is resolved from the opencode launch directory (`input.directory`), so guidance is read from the project opencode was started in.
- Decisions and errors are logged to `~/.local/share/opencode-auto-question/log.txt` (set `"verbose": true` for debug detail).
- **Session summaries**: when `sessionSummary` is enabled (default), the plugin injects a visible `noReply` message into the session history after auto-answering or deferring to human. This shows the engine used, confidence scores, and which answers were selected (or why the question was deferred). The message carries the latest user message's agent/model/variant/system/format — without those, opencode stamps a new user message with the default agent and switches the session to `build` mid-run — and its text part is marked `ignored`, so it shows in the history but stays out of the model's context. Set `"sessionSummary": false` to disable.
- If the human answers first, the plugin's reply fails harmlessly (the pending request is gone) and it moves on.

## Development

```bash
bun install
bun run typecheck   # tsc --noEmit
bun test            # unit tests (no network)
```
