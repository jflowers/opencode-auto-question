/**
 * Check the npm tarball before publishing: the files opencode needs are in
 * it, nothing that shouldn't ship is, and the built entry loads with the
 * export shape both plugin APIs expect.
 *
 * Run after `bun run build`: bun scripts/verify-package.ts
 */
import { execFileSync } from "node:child_process"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { BUNDLED_AGENTS } from "../src/agents"

const root = join(import.meta.dir, "..")
const errors: string[] = []

// npm 10 runs the prepare script during `pack` despite --ignore-scripts, and
// the build's output lands on stdout ahead of the JSON. Parse from the line
// where the JSON array starts.
const packOutput = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  cwd: root,
  encoding: "utf8",
})
const jsonStart = packOutput.search(/^\[/m)
if (jsonStart < 0) throw new Error(`npm pack printed no JSON:\n${packOutput}`)
const packed = JSON.parse(packOutput.slice(jsonStart)) as Array<{ files: Array<{ path: string }> }>
const files = new Set(packed[0]!.files.map((f) => f.path))

const required = [
  "package.json",
  "dist/index.js",
  "dist/index.d.ts",
  "auto-question.schema.json",
  "config/auto-question.jsonc",
  "CHANGELOG.md",
  "README.md",
  "LICENSE",
  ...BUNDLED_AGENTS.map((a) => `agents/${a}.md`),
]
for (const path of required) if (!files.has(path)) errors.push(`missing from tarball: ${path}`)

const forbidden = [/^src\//, /^scripts\//, /\.test\.(js|ts|d\.ts)$/, /test-harness/, /fixtures\//, /^node_modules\//, /^bun\.lock$/]
for (const path of files) if (forbidden.some((re) => re.test(path))) errors.push(`should not ship: ${path}`)

const mod = (await import(pathToFileURL(join(root, "dist/index.js")).href)).default
if (mod?.id !== "auto-question") errors.push(`dist default export id is ${JSON.stringify(mod?.id)}`)
if (typeof mod?.server !== "function") errors.push("dist default export has no server() for opencode 1.x")
if (typeof mod?.setup !== "function") errors.push("dist default export has no setup() for opencode v2")

if (errors.length > 0) {
  console.error(`verify-package: ${errors.length} problem(s)\n  ${errors.join("\n  ")}`)
  process.exit(1)
}
console.log(`verify-package: ok (${files.size} files)`)
