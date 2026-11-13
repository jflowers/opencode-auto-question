import { log } from "./log"

const V2_UNSUPPORTED =
  "auto-question supports opencode 1.x only for now; on this opencode (v2 plugin API) it is installed but inactive. " +
  "Questions are left for a human."

/**
 * Process-wide marker that a 1.x host called `server`. It lives on globalThis
 * rather than in module state because the 1.x and v2 loaders may each import
 * their own copy of this module.
 */
const SERVER_LOADED = Symbol.for("opencode-auto-question.server-loaded")

export function markServerLoaded(): void {
  ;(globalThis as Record<symbol, unknown>)[SERVER_LOADED] = true
}

export function serverLoaded(): boolean {
  return (globalThis as Record<symbol, unknown>)[SERVER_LOADED] === true
}

/** How long `setup` waits for a 1.x host to call `server` before warning. */
export const V2_GRACE_MS = 15_000

/**
 * v2 entry point. opencode 1.19+ runs a v2 plugin runtime next to the 1.x one
 * and calls `setup` as well as `server` on the same package, so `setup` alone
 * does not mean the plugin is inactive. Warn only when no 1.x host has called
 * `server`, checked now and again after a grace period. The check runs again
 * later because the two loaders run concurrently in no fixed order. The
 * timer is unref'd so it never keeps a process alive.
 *
 * On a v2-only host there is nothing to hook yet: v2 replaced the question
 * tool's events with forms, and its plugin context cannot reply to a form.
 */
export async function setup(_ctx: unknown, graceMs: number = V2_GRACE_MS): Promise<void> {
  if (serverLoaded()) {
    log("debug", "v2 setup called alongside the 1.x server entry; 1.x path is active")
    return
  }
  const timer = setTimeout(() => {
    if (serverLoaded()) return
    log("warn", V2_UNSUPPORTED)
    console.warn(`[auto-question] ${V2_UNSUPPORTED}`)
  }, graceMs)
  ;(timer as { unref?: () => void }).unref?.()
}
