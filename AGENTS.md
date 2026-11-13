# opencode-auto-question

opencode plugin that auto-answers the `question` tool for autonomous agents.
Jev (OpenRouter Decisions API) or LLM JSON-contract decision engines, two-pass
confidence gate with subagent context gathering, human fallback.

- Plugin entry: `src/index.ts`, built to `dist/index.js` (what opencode
  loads). Default export `{ id, server, setup }`: `server` is the V1 plugin
  API (opencode 1.19.x); `setup` is the v2 entry, a warning-only stub until
  v2 supports answering forms.
- Config: `~/.config/opencode/auto-question.jsonc`, optional (template in
  `config/`, schema in `auto-question.schema.json`; `src/schema.test.ts` keeps
  the schema, `DEFAULT_CONFIG` and the template in step). Dewey's
  `dewey gate auto-answer` reads this same single path, so don't add config
  sources without updating Dewey.
- Agents: `agents/*.md`, registered by the plugin's `config` hook
  (`src/agents.ts`); a user's settings for an agent of the same name win
  and the bundled definition fills in the rest.
- Log: `~/.local/share/opencode-auto-question/log.txt`
- Release: in a PR, bump `version` in `package.json` and move the
  `CHANGELOG.md` entries under the new version. After it merges, push tag
  `v<version>` from `main`; `.github/workflows/publish.yml` publishes to npm.
  It authenticates through npm trusted publishing (OIDC: package settings on
  npmjs.com trust `jflowers/opencode-auto-question` + `publish.yml`), so no
  npm token exists or is needed. The package's publishing access disallows
  tokens; publishing by hand needs the maintainer's 2FA.

Verify changes with `bun run typecheck && bun test && bun run build && bun run verify:package`
(CI runs all of them on every pull request: `.github/workflows/ci.yml`).
After changing `src/`, rebuild: a checkout used as a local plugin path loads `dist/`. End-to-end orchestrator tests use
the fake client and stubbed engine in `src/test-harness.ts`. Runtime imports are
type-only (`import type`); the host provides the plugin SDK.
