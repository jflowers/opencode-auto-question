# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/jflowers/opencode-auto-question/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/jflowers/opencode-auto-question/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/jflowers/opencode-auto-question/compare/47de2ca...v0.1.1
[0.1.0]: https://github.com/jflowers/opencode-auto-question/tree/47de2ca
