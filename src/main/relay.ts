import { WebContents } from 'electron'
import { AgentBridge } from './bridge'
import { BridgeMessage } from '../shared/protocol'

// The Electron twin of WebSurfaceRelay: the app owns ONE agent socket (main
// process — a renderer ws would carry an Origin header and be rejected), and
// every surface window registers here. Inbound frames fan out to all
// surfaces; surface messages come back via ipc 'surface:send' and are either
// host actions (window-level) or protocol frames relayed onto the socket.

export type HostActionHandler = (type: string, payload: Record<string, unknown>, sender: WebContents) => void

// Host-control types consumed by the shell, never sent to the agent.
const HOST_ACTIONS = new Set([
  'summon_open',
  'agent_pop_out',
  'popout_close',
  'ui_action',
  'tune_request',
  'host_open', // electron addition: open a named surface (guide, about, …)
  'host_quit'
])

export class SurfaceRelay {
  private bridge: AgentBridge
  private views = new Set<WebContents>()
  private lastHello: BridgeMessage | null = null
  public onHostAction: HostActionHandler | null = null

  constructor(bridge: AgentBridge) {
    this.bridge = bridge
    bridge.subscribe((msg) => {
      if (msg.type === '_bridge_connected') {
        this.wakeAll()
        return
      }
      if (msg.type === '_bridge_disconnected') return
      if (msg.type === 'hello' && msg.models) this.lastHello = msg
      this.fanOut(msg)
    })
  }

  register(wc: WebContents): void {
    this.views.add(wc)
    wc.on('destroyed', () => this.views.delete(wc))
    if (this.lastHello) safeSend(wc, 'bridge:message', this.lastHello)
    if (this.bridge.connected) safeSend(wc, 'host:wired')
  }

  /** A frame from a surface (ipc surface:send). */
  fromSurface(msg: BridgeMessage, sender: WebContents): void {
    const t = msg.type
    if (t === '__hotrect' || t === '__winmove') {
      // window-plumbing — handled by the window manager via its own listener
      this.onHostAction?.(t, msg, sender)
      return
    }
    if (HOST_ACTIONS.has(t)) {
      this.onHostAction?.(t, msg, sender)
      return
    }
    this.bridge.send(msg)
  }

  /** Synthetic local frames (tune_state, drive-mode set_state) → all surfaces. */
  pushToSurfaces(msg: BridgeMessage): void {
    this.fanOut(msg)
  }

  private wakeAll(): void {
    for (const wc of this.views) safeSend(wc, 'host:wired')
  }

  private fanOut(msg: BridgeMessage): void {
    for (const wc of this.views) safeSend(wc, 'bridge:message', msg)
  }
}

/** send() can throw mid-teardown ("Render frame was disposed") even after an
 *  isDestroyed() check passes — the disposal races the timer. Never fatal. */
export function safeSend(wc: WebContents, channel: string, ...args: unknown[]): void {
  try {
    if (!wc.isDestroyed()) wc.send(channel, ...args)
  } catch {
    /* frame died between check and send */
  }
}
