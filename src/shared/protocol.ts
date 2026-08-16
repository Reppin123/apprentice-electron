// Wire types for ws://127.0.0.1:8765 — PROTOCOL.md v0 (apprentice-agent).
// The envelope is intentionally loose: every frame is a JSON object with a
// string `type`; surfaces narrow the payload they care about.

export interface BridgeMessage {
  type: string
  [key: string]: unknown
}

export interface AgentHello extends BridgeMessage {
  type: 'hello'
  protocol_version: string
  app_version?: string
  client_kind?: string
  models?: unknown[]
  providers?: unknown[]
  dirs?: {
    data_dir?: string
    log_dir?: string
    events_dir?: string
    claude_config_dir?: string | null
  }
}

export function bridgeUrl(): string {
  const port = Number(process.env.APPRENTICE_WS_PORT || 8765)
  return `ws://127.0.0.1:${port}`
}
// agent.py PROTOCOL_VERSION is the STRING "0" — a number here logs a
// version-mismatch warning on every connect.
export const PROTOCOL_VERSION = '0'
