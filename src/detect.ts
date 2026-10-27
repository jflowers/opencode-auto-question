import type { Config } from "./types"
import { log } from "./log"

/**
 * Tracks which agent is selected per session by observing user messages
 * (each user message carries the agent that will run it). Falls back to
 * fetching session messages when no user message has been seen yet.
 *
 * The v1.19 Session type has no agent field, so this is the reliable way
 * to know a session's current agent from a plugin.
 */
export class AgentTracker {
  private map = new Map<string, string>()

  /** Call for every message.updated event payload. */
  trackMessage(info: unknown): void {
    const message = info as { sessionID?: string; role?: string; agent?: unknown } | undefined
    if (!message || message.role !== "user") return
    if (typeof message.sessionID !== "string" || typeof message.agent !== "string") return
    this.map.set(message.sessionID, message.agent)
  }

  get(sessionID: string): string | undefined {
    return this.map.get(sessionID)
  }

  /** Cached value first, then the session's most recent user message. */
  async resolve(client: any, sessionID: string): Promise<string | undefined> {
    const cached = this.map.get(sessionID)
    if (cached) return cached
    try {
      const result = await client.session.messages({ path: { id: sessionID } })
      const entries: Array<{ info?: { role?: string; agent?: unknown } }> = result?.data ?? []
      for (let i = entries.length - 1; i >= 0; i--) {
        const info = entries[i]?.info
        if (info?.role === "user" && typeof info.agent === "string") {
          this.map.set(sessionID, info.agent)
          return info.agent
        }
      }
    } catch (e) {
      log("debug", "agent resolve via session messages failed", { sessionID, error: String(e) })
    }
    return undefined
  }
}

export function isAutonomousAgent(agent: string | undefined, config: Config): boolean {
  if (!agent) return false
  return config.agents.some((a) => a.toLowerCase() === agent.toLowerCase())
}
