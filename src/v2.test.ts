import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { markServerLoaded, serverLoaded, setup } from "./v2"

const KEY = Symbol.for("opencode-auto-question.server-loaded")
let warn: ReturnType<typeof spyOn>

beforeEach(() => {
  delete (globalThis as Record<symbol, unknown>)[KEY]
  warn = spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(() => {
  warn.mockRestore()
  delete (globalThis as Record<symbol, unknown>)[KEY]
})

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

test("setup stays quiet when the 1.x server entry already ran", async () => {
  markServerLoaded()
  await setup({}, 5)
  await wait(20)
  expect(warn).not.toHaveBeenCalled()
})

test("setup stays quiet when the 1.x server entry runs during the grace period", async () => {
  await setup({}, 20)
  markServerLoaded()
  await wait(40)
  expect(warn).not.toHaveBeenCalled()
})

test("setup warns when no 1.x host calls server", async () => {
  await setup({}, 5)
  expect(serverLoaded()).toBe(false)
  await wait(20)
  expect(warn).toHaveBeenCalledTimes(1)
  expect(String(warn.mock.calls[0]?.[0])).toContain("installed but inactive")
})
