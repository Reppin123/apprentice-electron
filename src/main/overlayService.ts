import { BrowserWindow, screen, Display } from 'electron'
import { join } from 'path'
import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { AgentBridge } from './bridge'
import { BridgeMessage } from '../shared/protocol'
import { surfacesDir } from './windows'
import { safeSend } from './relay'

// The presence layer: one full-screen click-through overlay window per
// display (orb + bubbles + toast + annotations), plus the pointing/annotation
// message router. The shell owns ALL geometry — the agent sends points in
// three spaces and never guesses screen height or scale:
//   "screen"  = AppKit global, y-UP from bottom-left of the primary display
//   "topleft" = global, y-DOWN from top-left of primary (AX coords)
//   "pixel"   = screenshot pixels of the primary display + shot_w for scale
// Electron is y-DOWN top-left global, so: topleft = identity, screen flips y,
// pixel scales by primaryWidth/shot_w.

const CURSOR_COLORS = ['#3380FF', '#FF4D4D', '#FFCC33', '#33D17A']

interface ResolveResult {
  ok: boolean
  x?: number
  y?: number
  w?: number
  h?: number
  reason?: string
}

export class OverlayService {
  private bridge: AgentBridge
  private overlays = new Map<number, BrowserWindow>() // display.id → window
  private cursorTimer: NodeJS.Timeout | null = null
  private orbState = { state: 'idle', color: CURSOR_COLORS[0], size: 'regular', visible: true }
  private helperPath: string | null

  constructor(bridge: AgentBridge) {
    this.bridge = bridge
    const helper = join(
      process.resourcesPath || join(__dirname, '../../resources'),
      'darwin',
      'apprentice-resolve'
    )
    const devHelper = join(__dirname, '../../resources/darwin/apprentice-resolve')
    this.helperPath = existsSync(helper) ? helper : existsSync(devHelper) ? devHelper : null
  }

  start(): void {
    this.syncOverlays()
    screen.on('display-added', () => this.syncOverlays())
    screen.on('display-removed', () => this.syncOverlays())
    this.cursorTimer = setInterval(() => this.feedCursor(), 50)
  }

  stop(): void {
    if (this.cursorTimer) clearInterval(this.cursorTimer)
    for (const w of this.overlays.values()) if (!w.isDestroyed()) w.destroy()
    this.overlays.clear()
  }

  setOrb(patch: Partial<typeof this.orbState>): void {
    Object.assign(this.orbState, patch)
    this.broadcast({ type: 'overlay_state', ...this.orbState })
  }

  setColorSlot(slot: number): void {
    this.setOrb({ color: CURSOR_COLORS[slot % CURSOR_COLORS.length] })
  }

  /** Push a synthetic frame to every overlay window. */
  broadcast(msg: BridgeMessage): void {
    for (const w of this.overlays.values()) {
      safeSend(w.webContents, 'bridge:message', msg)
    }
  }

  /** Route an inbound agent frame; returns true when consumed. */
  handleBridgeMessage(msg: BridgeMessage): boolean {
    switch (msg.type) {
      case 'point_at_element':
        this.handlePoint(msg)
        return true
      case 'highlight_element':
        this.handleResolveAndDraw(msg, (r) => ({
          type: 'overlay_point',
          x: r.x,
          y: r.y,
          w: r.w,
          h: r.h,
          instruction: msg.instruction
        }))
        return true
      case 'draw_arrow':
        this.handleArrow(msg)
        return true
      case 'draw_shape':
        this.handleResolveAndDraw(msg, (r) => ({
          type: 'overlay_annotate',
          shapes: [
            {
              kind: msg.kind || 'circle',
              rect: { x: r.x, y: r.y, w: r.w, h: r.h },
              label: msg.label
            }
          ]
        }))
        return true
      case 'draw_marker':
        this.handleResolveAndDraw(msg, (r) => ({
          type: 'overlay_annotate',
          shapes: [
            {
              kind: 'marker',
              rect: { x: r.x, y: r.y, w: r.w, h: r.h },
              number: msg.number,
              label: msg.label
            }
          ]
        }))
        return true
      case 'clear_annotations':
        this.broadcast({ type: 'overlay_clear' })
        this.ack(msg, true)
        return true
      case 'set_state': {
        const s = String(msg.state || 'idle')
        this.setOrb({ state: ['listening', 'thinking', 'speaking', 'pointing'].includes(s) ? s : 'idle' })
        return false // others (pill) also consume set_state
      }
      case 'thinking_update':
        this.broadcast({ type: 'overlay_thinking', text: msg.text })
        return false
      case 'thinking_clear':
        this.broadcast({ type: 'overlay_thinking_clear' })
        return false
    }
    return false
  }

  toast(text: string): void {
    this.broadcast({ type: 'overlay_toast', text })
  }

  // ── geometry ──────────────────────────────────────────────────────────

  private toElectronPoint(msg: BridgeMessage): { x: number; y: number } {
    const primary = screen.getPrimaryDisplay()
    const x = Number(msg.x || 0)
    const y = Number(msg.y || 0)
    const space = String(msg.space || 'screen')
    if (space === 'topleft') return { x, y }
    if (space === 'pixel') {
      const shotW = Number(msg.shot_w || 0)
      const scale = shotW > 0 ? primary.bounds.width / shotW : 1
      return { x: x * scale, y: y * scale }
    }
    // "screen": AppKit global y-up from primary's bottom-left
    return { x, y: primary.bounds.height - y }
  }

  private displayFor(pt: { x: number; y: number }): Display {
    return screen.getDisplayNearestPoint({ x: Math.round(pt.x), y: Math.round(pt.y) })
  }

  private sendToDisplay(pt: { x: number; y: number }, msg: BridgeMessage): void {
    const d = this.displayFor(pt)
    const w = this.overlays.get(d.id)
    if (w) safeSend(w.webContents, 'bridge:message', msg)
  }

  // ── handlers ──────────────────────────────────────────────────────────

  private handlePoint(msg: BridgeMessage): void {
    const pt = this.toElectronPoint(msg)
    const d = this.displayFor(pt)
    const local = { x: pt.x - d.bounds.x, y: pt.y - d.bounds.y }
    const wpt = Number(msg.width || 0)
    const hpt = Number(msg.height || 0)
    this.sendToDisplay(pt, {
      type: 'overlay_point',
      x: local.x,
      y: local.y,
      w: wpt || undefined,
      h: hpt || undefined,
      instruction: msg.instruction
    })
    this.ack(msg, true)
  }

  private handleResolveAndDraw(
    msg: BridgeMessage,
    frame: (r: Required<Pick<ResolveResult, 'x' | 'y' | 'w' | 'h'>>) => BridgeMessage
  ): void {
    this.resolve(String(msg.app_name || ''), String(msg.label || msg.title || ''), msg.role ? String(msg.role) : undefined)
      .then((r) => {
        if (!r.ok || r.x == null) {
          this.ack(msg, false, r.reason || 'element not found')
          return
        }
        const global = { x: r.x, y: r.y! }
        const d = this.displayFor(global)
        const local = {
          x: r.x - d.bounds.x,
          y: r.y! - d.bounds.y,
          w: r.w || 24,
          h: r.h || 18
        }
        this.sendToDisplay(global, frame(local as Required<Pick<ResolveResult, 'x' | 'y' | 'w' | 'h'>>))
        this.ack(msg, true)
      })
      .catch(() => this.ack(msg, false, 'resolver error'))
  }

  private handleArrow(msg: BridgeMessage): void {
    const app = String(msg.app_name || '')
    Promise.all([
      this.resolve(app, String(msg.from_label || '')),
      this.resolve(app, String(msg.to_label || ''))
    ])
      .then(([a, b]) => {
        if (!a.ok || !b.ok || a.x == null || b.x == null) {
          this.ack(msg, false, 'element not found')
          return
        }
        const from = { x: a.x + (a.w || 0) / 2, y: a.y! + (a.h || 0) / 2 }
        const to = { x: b.x + (b.w || 0) / 2, y: b.y! + (b.h || 0) / 2 }
        const d = this.displayFor(from)
        this.sendToDisplay(from, {
          type: 'overlay_annotate',
          shapes: [
            {
              kind: 'arrow',
              from: { x: from.x - d.bounds.x, y: from.y - d.bounds.y },
              to: { x: to.x - d.bounds.x, y: to.y - d.bounds.y },
              label: msg.label
            }
          ]
        })
        this.ack(msg, true)
      })
      .catch(() => this.ack(msg, false, 'resolver error'))
  }

  /** Label→rect resolution. mac: the bundled AX+OCR helper; elsewhere: an
   *  honest failure (the agent is told the truth and never claims it pointed). */
  private resolve(appName: string, label: string, role?: string): Promise<ResolveResult> {
    if (!this.helperPath) {
      return Promise.resolve({ ok: false, reason: 'element resolution unavailable in this shell' })
    }
    return new Promise((res) => {
      const args = ['--app', appName, '--label', label]
      if (role) args.push('--role', role)
      execFile(this.helperPath!, args, { timeout: 7000 }, (err, stdout) => {
        if (err) return res({ ok: false, reason: 'element not found' })
        try {
          const out = JSON.parse(stdout.trim())
          // helper reports topleft-global CSS points (already Electron space)
          res({ ok: !!out.ok, x: out.x, y: out.y, w: out.w, h: out.h, reason: out.reason })
        } catch {
          res({ ok: false, reason: 'resolver parse error' })
        }
      })
    })
  }

  private ack(msg: BridgeMessage, ok: boolean, reason?: string): void {
    if (!msg.id) return
    const reply: BridgeMessage = { type: 'annotation_result', id: msg.id, ok }
    if (reason) reply.reason = reason
    this.bridge.send(reply)
  }

  // ── overlay windows ───────────────────────────────────────────────────

  private syncOverlays(): void {
    const displays = new Map(screen.getAllDisplays().map((d) => [d.id, d]))
    for (const [id, w] of this.overlays) {
      if (!displays.has(id)) {
        if (!w.isDestroyed()) w.destroy()
        this.overlays.delete(id)
      }
    }
    for (const [id, d] of displays) {
      if (this.overlays.has(id)) continue
      const win = new BrowserWindow({
        x: d.bounds.x,
        y: d.bounds.y,
        width: d.bounds.width,
        height: d.bounds.height,
        show: false,
        frame: false,
        transparent: true,
        hasShadow: false,
        resizable: false,
        movable: false,
        skipTaskbar: true,
        focusable: false,
        webPreferences: {
          preload: join(__dirname, '../preload/index.js'),
          contextIsolation: false,
          sandbox: false,
          nodeIntegration: false,
          backgroundThrottling: false
        }
      })
      win.setIgnoreMouseEvents(true) // fully click-through, always
      win.setAlwaysOnTop(true, 'screen-saver', 1) // above summon, tour-style
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
      win.loadFile(join(surfacesDir(), 'overlay.html'))
      win.webContents.on('did-finish-load', () => {
        safeSend(win.webContents, 'bridge:message', { type: 'overlay_state', ...this.orbState })
        win.showInactive()
      })
      this.overlays.set(id, win)
    }
  }

  private feedCursor(): void {
    const c = screen.getCursorScreenPoint()
    for (const [id, w] of this.overlays) {
      if (w.isDestroyed()) continue
      const d = screen.getAllDisplays().find((x) => x.id === id)
      if (!d) continue
      const inside =
        c.x >= d.bounds.x &&
        c.x < d.bounds.x + d.bounds.width &&
        c.y >= d.bounds.y &&
        c.y < d.bounds.y + d.bounds.height
      safeSend(w.webContents, 'host:cursor', c.x - d.bounds.x, c.y - d.bounds.y, inside)
    }
  }
}
