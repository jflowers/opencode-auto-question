import { describe, expect, test } from "bun:test"
import { buildJevQuestions, buildLlmMessages, parseJevResponse, parseLlmResponse } from "./mapping"
import type { QuestionInfo } from "./types"

const single: QuestionInfo = {
  question: "Which database?",
  header: "Database",
  options: [
    { label: "postgres", description: "Relational, mature" },
    { label: "sqlite", description: "Embedded, zero-config" },
  ],
}

const multi: QuestionInfo = {
  question: "Which features?",
  header: "Features",
  multiple: true,
  options: [
    { label: "auth", description: "Login" },
    { label: "audit", description: "Audit log" },
  ],
}

describe("buildJevQuestions", () => {
  test("single-select maps to one choice question", () => {
    const set = buildJevQuestions([single])
    expect(set).not.toBeNull()
    expect(set!.questions["q0"]).toEqual({
      type: "choice",
      instructions: "Which database?",
      criteria: { postgres: "Relational, mature", sqlite: "Embedded, zero-config" },
    })
    expect(set!.layout).toEqual([{ kind: "choice", questionIndex: 0, label: "" }])
  })

  test("multi-select maps to one noul per option", () => {
    const set = buildJevQuestions([multi])
    expect(set).not.toBeNull()
    expect((set!.questions["q0_o0"] as any).type).toBe("noul")
    expect((set!.questions["q0_o1"] as any).type).toBe("noul")
    expect(set!.layout.map((e) => e.kind)).toEqual(["noul", "noul"])
  })

  test("empty options returns null (LLM fallback)", () => {
    const noOptions: QuestionInfo = { question: "Name?", header: "H", options: [] }
    expect(buildJevQuestions([noOptions])).toBeNull()
  })

  test("duplicate labels get deduped keys", () => {
    const dup: QuestionInfo = {
      question: "Pick",
      header: "H",
      options: [
        { label: "same", description: "first" },
        { label: "same", description: "second" },
      ],
    }
    const set = buildJevQuestions([dup])
    expect(Object.keys((set!.questions["q0"] as any).criteria)).toEqual(["same", "same (#2)"])
  })
})

describe("parseJevResponse", () => {
  test("choice answer maps back to labels", () => {
    const set = buildJevQuestions([single])!
    const parsed = parseJevResponse(set, [single], {
      q0: { type: "choice", choice: "sqlite", confidence: 0.82 },
    })
    expect(parsed).toEqual({ answers: [["sqlite"]], confidences: [0.82] })
  })

  test("choice answer with dedup suffix maps to original label", () => {
    const dup: QuestionInfo = {
      question: "Pick",
      header: "H",
      options: [
        { label: "same", description: "first" },
        { label: "same", description: "second" },
      ],
    }
    const set = buildJevQuestions([dup])!
    const parsed = parseJevResponse(set, [dup], {
      q0: { type: "choice", choice: "same (#2)", confidence: 0.9 },
    })
    expect(parsed!.answers[0]).toEqual(["same"])
  })

  test("noul answers collect yes labels", () => {
    const set = buildJevQuestions([multi])!
    const parsed = parseJevResponse(set, [multi], {
      q0_o0: { type: "noul", noul: true, confidence: 0.9 },
      q0_o1: { type: "noul", noul: false, confidence: 0.7 },
    })
    expect(parsed!.answers[0]).toEqual(["auth"])
    expect(parsed!.confidences[0]).toBe(0.9)
  })

  test("noul defensive parsing accepts choice yes/no", () => {
    const set = buildJevQuestions([multi])!
    const parsed = parseJevResponse(set, [multi], {
      q0_o0: { type: "noul", choice: "yes", confidence: 0.8 },
      q0_o1: { type: "noul", choice: "no", confidence: 0.8 },
    })
    expect(parsed!.answers[0]).toEqual(["auth"])
  })

  test("unknown choice label returns null", () => {
    const set = buildJevQuestions([single])!
    expect(parseJevResponse(set, [single], { q0: { type: "choice", choice: "oracle" } })).toBeNull()
  })

  test("missing answer returns null", () => {
    const set = buildJevQuestions([single])!
    expect(parseJevResponse(set, [single], {})).toBeNull()
  })
})

describe("buildLlmMessages", () => {
  test("includes context and options", () => {
    const { system, user } = buildLlmMessages([single], "past decisions prefer sqlite")
    expect(system).toContain("JSON object")
    expect(user).toContain("past decisions prefer sqlite")
    expect(user).toContain('"postgres"')
    expect(user).toContain("select one")
  })

  test("multi-select hint", () => {
    const { user } = buildLlmMessages([multi], null)
    expect(user).toContain("all that apply")
  })
})

describe("parseLlmResponse", () => {
  test("parses clean JSON", () => {
    const parsed = parseLlmResponse('{"answers": [["sqlite"]], "confidences": [0.9]}', 1)
    expect(parsed).toEqual({ answers: [["sqlite"]], confidences: [0.9] })
  })

  test("parses fenced JSON", () => {
    const text = '```json\n{"answers": [["a", "b"]], "confidences": [0.5]}\n```'
    const parsed = parseLlmResponse(text, 1)
    expect(parsed!.answers[0]).toEqual(["a", "b"])
  })

  test("parses JSON embedded in prose", () => {
    const text = 'Sure! Here you go: {"answers": [["x"]], "confidences": [0.4]} hope that helps'
    const parsed = parseLlmResponse(text, 1)
    expect(parsed!.answers[0]).toEqual(["x"])
  })

  test("accepts string answers as single-element arrays", () => {
    const parsed = parseLlmResponse('{"answers": ["custom answer"], "confidences": [0.6]}', 1)
    expect(parsed!.answers[0]).toEqual(["custom answer"])
  })

  test("wrong count returns null", () => {
    expect(parseLlmResponse('{"answers": [["x"]], "confidences": [0.5]}', 2)).toBeNull()
  })

  test("garbage returns null", () => {
    expect(parseLlmResponse("I cannot answer that", 1)).toBeNull()
  })

  test("clamps confidences", () => {
    const parsed = parseLlmResponse('{"answers": [["x"]], "confidences": [7]}', 1)
    expect(parsed!.confidences[0]).toBe(1)
  })
})
