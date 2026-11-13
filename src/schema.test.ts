import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { DEFAULT_CONFIG, stripJsonComments } from "./config"

const root = `${import.meta.dir}/..`
const schema = JSON.parse(readFileSync(`${root}/auto-question.schema.json`, "utf8"))
const sample = JSON.parse(stripJsonComments(readFileSync(`${root}/config/auto-question.jsonc`, "utf8")))

/** Walk the schema alongside a value, collecting mismatches. */
function compare(node: any, value: unknown, path: string, out: string[]): void {
  if (node.type === "object" && node.properties && value && typeof value === "object" && !Array.isArray(value)) {
    const keys = Object.keys(node.properties).filter((k) => k !== "$schema").sort()
    const actual = Object.keys(value).sort()
    if (JSON.stringify(keys) !== JSON.stringify(actual)) out.push(`${path || "<root>"}: schema keys ${keys} vs ${actual}`)
    for (const k of actual) if (node.properties[k]) compare(node.properties[k], (value as any)[k], `${path}.${k}`, out)
    return
  }
  if (JSON.stringify(node.default) !== JSON.stringify(value)) {
    out.push(`${path}: schema default ${JSON.stringify(node.default)} vs ${JSON.stringify(value)}`)
  }
}

describe("auto-question.schema.json", () => {
  test("has exactly the config keys, with the code's defaults", () => {
    const problems: string[] = []
    compare(schema, DEFAULT_CONFIG, "", problems)
    expect(problems).toEqual([])
  })

  test("the sample config only uses keys the schema allows", () => {
    const unknown = (node: any, value: any, path: string): string[] =>
      Object.entries(value).flatMap(([k, v]) => {
        const child = node.properties?.[k]
        if (!child) return [`${path}.${k}`]
        return child.type === "object" && v && typeof v === "object" ? unknown(child, v, `${path}.${k}`) : []
      })
    expect(unknown(schema, sample, "")).toEqual([])
    expect(sample.$schema).toBe(schema.$id)
  })
})
