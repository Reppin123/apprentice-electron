import WebSocket from 'ws'
import { BridgeMessage, AgentHello, bridgeUrl, PROTOCOL_VERSION } from '../shared/protocol'

type Handler = (msg: BridgeMessage) => void

// TypeScript twin of PythonAgentBridge.swift: connect, hello handshake,
// reconnect-with-backoff, multicast subscribe (the Swift #5a bus — no
// single-closure chaining, so the reconnect-clobber class stays impossible).
export class AgentBridge {
  private ws: WebSocket | null = null
  private subscribers = new Map<number, Handler>()
  private nextToken = 1
  private backoffMs = 500
  private closed = false
  private authToken: string
  private clientKind: string
  public hello: AgentHello | null = null
  public connected = false
  // Re-asserted on EVERY connect: the agent's preferred-model is a
  // process-global that resets each launch (agent.py:162-172) — without this
  // the first turn silently runs the default model.
  public modelId: string | null = null
  public userName: string | null = null

  constructor(authToken: string, clientKind: string) {
    this.authToken = authToken
    this.clientKind = clientKind
  }

  start(): void {
    this.closed = false
    this.connect()
  }

  stop(): void {
    this.closed = true
    this.stopKeepalive()
    this.ws?.close()
    this.ws = null
  }

  /** Deliberate reconnect — how a model swap takes effect (kills the Python
   *  session; the new hello re-asserts modelId). A feature, not an error. */
  forceReconnect(): void {
    this.ws?.close(1000)
  }

  /** Immediate liveness probe (wake / network-path-restored). */
  probe(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.ping()
    } else if (!this.closed && !this.ws) {
      this.backoffMs = 500
      this.connect()
    }
  }

  private pingTimer: NodeJS.Timeout | null = null
  private pongTimer: NodeJS.Timeout | null = null

  // Swift keeps 30s pings with a 15s pong watchdog on top of the server's
  // 60s ping cadence — without it a dead socket after sleep hangs 60-90s.
  private startKeepalive(ws: WebSocket): void {
    this.stopKeepalive()
    this.pingTimer = setInterval(() => {
      if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return
      ws.ping()
      if (this.pongTimer) clearTimeout(this.pongTimer)
      this.pongTimer = setTimeout(() => {
        if (this.ws === ws) ws.terminate()
      }, 15000)
    }, 30000)
    ws.on('pong', () => {
      if (this.pongTimer) {
        clearTimeout(this.pongTimer)
        this.pongTimer = null
      }
    })
  }

  private stopKeepalive(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    if (this.pongTimer) clearTimeout(this.pongTimer)
    this.pingTimer = null
    this.pongTimer = null
  }

  subscribe(handler: Handler): number {
    const token = this.nextToken++
    this.subscribers.set(token, handler)
    return token
  }

  unsubscribe(token: number): void {
    this.subscribers.delete(token)
  }

  send(msg: BridgeMessage): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
      return true
    }
    return false
  }

  private connect(): void {
    if (this.closed) return
    const ws = new WebSocket(bridgeUrl())
    this.ws = ws

    ws.on('open', () => {
      this.backoffMs = 500
      this.connected = true
      const hello: BridgeMessage = {
        type: 'hello',
        protocol_version: PROTOCOL_VERSION,
        app_version: process.env.npm_package_version || '0.4.0',
        client_kind: this.clientKind,
        auth_token: this.authToken
      }
      if (this.modelId) hello.model_id = this.modelId
      if (this.userName) hello.user_name = this.userName
      ws.send(JSON.stringify(hello))
      this.startKeepalive(ws)
      this.fanout({ type: '_bridge_connected' })
    })

    ws.on('message', (data) => {
      let msg: BridgeMessage
      try {
        msg = JSON.parse(data.toString())
      } catch {
        return
      }
      if (msg.type === 'hello') {
        this.hello = msg as AgentHello
      }
      this.fanout(msg)
    })

    const onDown = (): void => {
      if (this.ws !== ws) return
      this.stopKeepalive()
      this.ws = null
      if (this.connected) {
        this.connected = false
        this.fanout({ type: '_bridge_disconnected' })
      }
      if (!this.closed) {
        setTimeout(() => this.connect(), this.backoffMs)
        this.backoffMs = Math.min(this.backoffMs * 2, 8000)
      }
    }
    ws.on('close', onDown)
    ws.on('error', onDown)
  }

  private fanout(msg: BridgeMessage): void {
    for (const handler of this.subscribers.values()) {
      try {
        handler(msg)
      } catch (err) {
        console.error('[bridge] subscriber threw', err)
      }
    }
  }
}
