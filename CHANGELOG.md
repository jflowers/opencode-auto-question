# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.4.2] - 2026-11-15

### Added
- `AUTO_QUESTION_LOG_DIR=<dir>` moves `log.txt` and `results.jsonl` to
  another directory.

### Fixed
- The test suite wrote its fake sessions (`ses_1`) to the real
  `~/.local/share/opencode-auto-question/log.txt`. Tests now log to a
  temporary directory that is removed afterwards.

## [0.4.1] - 2026-11-15

### Fixed
- Headless mode: human-gated agents now get `question: allow` like any other
  agent without their own `question` rule (issue #36). As a subagent, such
  an agent (dewey's curator, for example) used to hit a permission error and
  could go on to decide the gated question itself. Now it gets
  `HUMAN_GATE_UNANSWERED` and the escalation playbook. An explicit rule on
  the agent still wins, and nothing changes outside headless mode.

## [0.4.0] - 2026-11-15

### Added
- Headless mode (issue #32), for runs with no TUI: `"headless": true`, or
  `AUTO_QUESTION_HEADLESS=1` for one process.
  - The plugin registers its own `question` tool in place of the built-in
    one. It answers inside the tool call for every agent, not just `agents`,
    so no question form is ever shown.
  - `question: allow` is added globally and to every agent without its own
    rule, so subagents can ask too. The plugin's own subagents get
    `question: deny`.
  - Each question on a form is decided on its own: confident answers are
    returned, pass 2 re-asks only the questions pass 1 left, and the rest
    get their own `NO_SECOND_OPINION:` marker.
  - A human gate marks every question on the form `HUMAN_GATE_UNANSWERED`.
  - Records use `source: "headless"`, a `partial` outcome and per-question
    results.
  - When a human is needed (a human gate, or an unconfident question with
    `escalation.deferred: "escalate"`), the agent is told not to decide those
    questions, and then follows a playbook: `escalation.text`,
    `escalation.file`, or `AUTO_QUESTION_ESCALATION=<path>`. The default is
    to stop and name the decisions needed. With `"decide"` (the default), the
    agent is told to decide unconfident questions itself and say so.
  - A stable `autoQuestion` block in the tool part's metadata (`outcome`,
    `answered`, `total`, `humanGate`, `humanNeeded`). The
    `HUMAN_GATE_UNANSWERED:` and `NO_SECOND_OPINION:` markers are documented
    as stable.
  - The `question` tool accepts common malformed arguments (JSON strings,
    plain-string options, a single question object) instead of failing.

## [0.3.2] - 2026-11-14

### Changed
- With `secondOpinion.enabled`, the `second_opinion` tool is now allowed for
  every agent that has a profile, as well as for agents that allow it
  themselves. An explicit `second_opinion` rule on the agent still wins (the
  bundled `autonomy` agent keeps its deny), human-gated agents are never
  allowed it, and every other agent stays denied by default.

### Fixed
- A profile for an agent that isn't in `agents` was logged as unused (at
  error level) even with `secondOpinion.enabled`, though the
  `second_opinion` tool uses it. The warning now only appears when the tool
  is off.

## [0.3.1] - 2026-11-14

### Fixed
- A subagent that timed out (or whose call failed) was deleted while its
  agent loop could still be running, and opencode logged FOREIGN KEY errors
  for the writes that followed. The plugin now aborts such a session before
  deleting it.

## [0.3.0] - 2026-11-14

### Added
- `onDefer: "human" | "reject"` (#7), top level or per profile. With
  `"reject"`, a question the plugin doesn't answer (low confidence, guidance
  covered without confidence, engine failure, timeout) is answered with a
  `NO_SECOND_OPINION: deferred (...)` marker so an unattended session (a TUI
  nobody watches, `opencode serve`) continues, and
  a `HUMAN_GATE:` question is rejected, which ends the run, instead of being
  left pending. The default `"human"` keeps today's behavior.
- Structured results (#10): every question from an auto-answered agent is
  recorded as one JSON line in `results.jsonl` (answer, confidence, pass,
  engine, model, rationale, reason), for answered, deferred, gated and
  timed-out questions. `resultTrailer: true` (top level or per profile) also
  appends `AUTO_QUESTION_RESULT {json}` to the answer the asking agent
  receives, including a `NO_SECOND_OPINION:` marker reply.
- A `second_opinion` tool (#22), opt-in with `secondOpinion.enabled`. An
  agent passes a question, options and only the case facts, and gets the
  structured result back as the tool's output. It runs under the calling
  agent's profile, never reads the caller's message, and never waits for a
  human. When enabled it is denied globally unless configured; allow it per
  agent (`second_opinion: allow`). The bundled `autonomy` agent denies it.
- Model choice for a second opinion (#11), top level or per profile:
  `contextGathering.model` and `agentDecision.model` run those subagents on
  a given `"provider/model"`, and `llm.alternateModels` replaces `llm.model`
  when it is the asking session's own model (matched by model name), so the
  second opinion doesn't come from the asker's model. With no alternate, a
  warning is logged.
- The LLM and guidance-agent engines are asked for a one-sentence
  `rationale`, and every engine reports the model that decided.
- Per-agent `profiles` (#8): overrides for one agent's questions (engine,
  models, thresholds, guidance, context, summary, timeout), deep-merged over
  the top-level settings. `guidance.inheritGlobal: false` in a profile drops
  the shared global guidance. Human gates are checked before any profile and
  cannot be changed by one.

### Changed
- An empty `guidance.globalPath` or `guidance.projectPath` now means no
  guidance from that dir. Before, an empty value fell back to the default.

## [0.2.0] - 2026-11-13

### Added
- `$OPENCODE_CONFIG_DIR/auto-question.jsonc` is loaded after the global file
  and deep-merged over it, so a tool can ship a self-contained opencode setup
  (#6). `AUTO_QUESTION_CONFIG=<path>` names one file to use instead of both.
  The log lists the files loaded.

### Changed
- A relative `guidance.globalPath` now resolves against the directory of the
  config file that sets it, not the process working directory.
- Internal: deciding a question now returns an outcome (answered, deferred,
  gated, timed out) and one function replies and writes the summary for all of
  them. This prepares `onDefer` (#7) and structured results (#10).

### Fixed
- A decision that finishes after `handlerTimeoutMs` is now dropped. Before, it
  was still replied after the question had been left for the human and the
  "handler timed out" summary written.
- Loading the config no longer mutates the built-in defaults when a file
  leaves a block out and validation repairs it.
- On opencode 1.19 the plugin no longer claims to be inactive. 1.19 loads the
  package through both its 1.x and its v2 plugin runtimes, so the v2 `setup`
  stub ran next to the working 1.x `server` entry and printed "installed but
  inactive" while questions were in fact being auto-answered. The stub now
  warns only when no 1.x host has called `server` within 15 seconds.

## [0.1.2] - 2026-11-13

### Fixed
- A config entry for a bundled agent no longer replaces the whole agent. Its
  settings win and the bundled definition fills in the rest, the way opencode
  layers opencode.json over a markdown agent. Before, a project config that
  only narrowed `autonomy`'s `external_directory` permission (as the
  unbound-force and zero-dot-force overlays do) left `autonomy` without its
  prompt, in mode `all`, and with `question` denied once the old
  `~/.config/opencode/agents/` symlinks were removed.

## [0.1.1] - 2026-11-13

### Changed
- Releases are published from GitHub Actions through npm trusted publishing
  (OIDC), with provenance and no npm token. This is the first release made
  that way; 0.1.0 was published by hand.

## [0.1.0] - 2026-11-13

First release on npm, as `opencode-auto-question`.

### Added
- Human gates (`HUMAN_GATE:` marker, `humanGatedAgents`), pass-0 project
  guidance, two-pass Jev/LLM decisions, and CI.
- npm packaging: built `dist/`, one default export with `server` (opencode
  1.x) and `setup` (opencode v2), a package check (`bun run verify:package`),
  and a tag-triggered publish workflow with npm provenance.
- The plugin registers its bundled agents (`autonomy`, `auto-question-ctx`,
  `auto-question-decide`) through opencode's config hook, so no symlinks are
  needed. A user-defined agent of the same name always wins. Turn off with
  `"registerAgents": false`.
- `auto-question.schema.json` for editor completion in the config file.

### Changed
- A missing `~/.config/opencode/auto-question.jsonc` now runs on the defaults
  instead of leaving the plugin inert.
- The default `llm` engine is OpenRouter (`https://openrouter.ai/api/v1`,
  `OPENROUTER_API_KEY`, model `openrouter/auto`). Configs that set `llm`
  explicitly are unaffected.
- A git checkout must be built before opencode can load it: run `bun install`
  (its prepare script builds `dist/`) after cloning or pulling.

### opencode v2
- Not supported yet. On a v2 host the plugin loads, logs a warning, and leaves
  every question for a human: v2 replaced question events with forms, and its
  plugin API does not expose answering a form.

[Unreleased]: https://github.com/jflowers/opencode-auto-question/compare/v0.4.2...HEAD
[0.4.2]: https://github.com/jflowers/opencode-auto-question/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/jflowers/opencode-auto-question/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/jflowers/opencode-auto-question/compare/v0.3.2...v0.4.0
[0.3.2]: https://github.com/jflowers/opencode-auto-question/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/jflowers/opencode-auto-question/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/jflowers/opencode-auto-question/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/jflowers/opencode-auto-question/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/jflowers/opencode-auto-question/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/jflowers/opencode-auto-question/compare/47de2ca...v0.1.1
[0.1.0]: https://github.com/jflowers/opencode-auto-question/tree/47de2ca
