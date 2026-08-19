import { app, BrowserWindow, nativeImage, screen } from 'electron'
import { join } from 'path'
import { SurfaceRelay } from './relay'
import { safeSend } from './relay'
import { appIcon } from './paths'

// Window manager — the Electron twin of WebSurfaceHost.Surface plus every
// native window the Swift app had. Geometry is Electron screen coords
// (y-DOWN from top-left; simpler than AppKit — the pages' hot-rects are
// already y-down viewport coords).

export type Anchor = 'center' | 'top' | 'bottom' | 'top-right' | 'bottom-right'

export interface SurfaceSpec {
  page: string
  width: number
  height: number
  transparent: boolean
  anchor: Anchor
  clickThrough: boolean
  focusable: boolean
  /** hide when the window loses focus (summon's tap-outside-to-close) */
  dismissOnBlur?: boolean
  /** titled resizable document window */
  titled?: boolean
  minWidth?: number
  minHeight?: number
  title?: string
  /** window floats above everything incl. fullscreen spaces */
  level?: 'screen-saver' | 'floating' | 'status' | 'normal'
}

// Specs: the 5 shared web surfaces keep WebSurfaceHost's exact numbers; the
// rest carry the Swift windows' sizes from the surface inventory.
export const SURFACES: Record<string, SurfaceSpec> = {
  inspector: { page: 'inspector.html', width: 1100, height: 760, transparent: false, anchor: 'center', clickThrough: false, focusable: true, titled: true, minWidth: 860, minHeight: 560, title: 'Apprentice Inspector', level: 'normal' },
  summon: { page: 'summon.html', width: 560, height: 620, transparent: true, anchor: 'bottom', clickThrough: false, focusable: true, dismissOnBlur: true, level: 'screen-saver' },
  dock: { page: 'agent-dock.html', width: 640, height: 520, transparent: true, anchor: 'top', clickThrough: true, focusable: false, level: 'screen-saver' },
  pill: { page: 'pill.html', width: 480, height: 120, transparent: true, anchor: 'bottom', clickThrough: true, focusable: false, level: 'status' },
  popout: { page: 'popout.html', width: 320, height: 400, transparent: true, anchor: 'bottom-right', clickThrough: false, focusable: true, level: 'floating' },
  menubar: { page: 'menubar-panel.html', width: 320, height: 420, transparent: true, anchor: 'top-right', clickThrough: false, focusable: true, dismissOnBlur: true, level: 'floating' },
  onboarding: { page: 'onboarding.html', width: 1180, height: 620, transparent: true, anchor: 'center', clickThrough: false, focusable: true, level: 'normal' },
  about: { page: 'about.html', width: 520, height: 540, transparent: false, anchor: 'center', clickThrough: false, focusable: true, titled: true, title: 'About Apprentice', level: 'normal' },
  'auth-gate': { page: 'auth-gate.html', width: 460, height: 320, transparent: true, anchor: 'center', clickThrough: false, focusable: true, level: 'floating' },
  'control-gate': { page: 'control-gate.html', width: 460, height: 300, transparent: false, anchor: 'center', clickThrough: false, focusable: true, titled: true, title: 'Apprentice', level: 'normal' },
  guide: { page: 'guide.html', width: 980, height: 760, transparent: false, anchor: 'center', clickThrough: false, focusable: true, titled: true, title: 'Apprentice — Guide', level: 'normal' },
  'call-live': { page: 'call-live.html', width: 420, height: 560, transparent: true, anchor: 'top-right', clickThrough: false, focusable: true, level: 'status' },
  'call-recap': { page: 'call-recap.html', width: 520, height: 480, transparent: true, anchor: 'center', clickThrough: false, focusable: true, level: 'status' },
  'call-dialog': { page: 'call-dialog.html', width: 420, height: 220, transparent: true, anchor: 'center', clickThrough: false, focusable: true, level: 'status' },
  'call-minutes': { page: 'call-minutes.html', width: 680, height: 760, transparent: false, anchor: 'center', clickThrough: false, focusable: true, titled: true, title: 'Meeting minutes', level: 'normal' },
  'call-history': { page: 'call-history.html', width: 560, height: 640, transparent: false, anchor: 'center', clickThrough: false, focusable: true, titled: true, title: 'Past calls', level: 'normal' },
  'video-editor': { page: 'video-editor.html', width: 1440, height: 900, transparent: false, anchor: 'center', clickThrough: false, focusable: true, titled: true, minWidth: 1000, minHeight: 600, title: 'Apprentice Video', level: 'normal' },
  'apv-editor': { page: 'apv-editor.html', width: 1280, height: 820, transparent: false, anchor: 'center', clickThrough: false, focusable: true, titled: true, minWidth: 900, minHeight: 600, title: 'Apprentice Editor', level: 'normal' },
  // Opaque + not click-through: Windows will not deliver mouse events (the
  // Allow-microphone button) through a transparent click-through surface.
  audio: { page: 'audio.html', width: 16, height: 16, transparent: false, anchor: 'center', clickThrough: false, focusable: false, level: 'normal' }
}

export function surfacesDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'surfaces')
    : join(app.getAppPath(), 'src', 'renderer', 'surfaces')
}

function preloadPath(): string {
  return join(__dirname, '../preload/index.js')
}

interface HotRect {
  x: number
  y: number
  w: number
  h: number
}

export class SurfaceManager {
  private relay: SurfaceRelay
  private windows = new Map<string, BrowserWindow>()
  private popouts = new Map<string, BrowserWindow>()
  private hotRects = new Map<number, HotRect>() // webContents.id → rect
  private pollTimer: NodeJS.Timeout | null = null
  private dragTimer: NodeJS.Timeout | null = null
  private dragWin: BrowserWindow | null = null
  private dragOffset = { x: 0, y: 0 }

  constructor(relay: SurfaceRelay) {
    this.relay = relay
  }

  get(key: string): BrowserWindow | undefined {
    const w = this.windows.get(key)
    return w && !w.isDestroyed() ? w : undefined
  }

  toggle(key: string): void {
    const w = this.get(key)
    if (w && w.isVisible()) w.hide()
    else this.show(key)
  }

  show(key: string, extraArgs: string[] = []): BrowserWindow {
    let win = this.get(key)
    if (!win) {
      win = this.create(key, SURFACES[key], extraArgs)
      this.windows.set(key, win)
    }
    win.show()
    if (SURFACES[key].focusable) win.focus()
    return win
  }

  hide(key: string): void {
    this.get(key)?.hide()
  }

  /** Detached strand card — one window per task_id, seeded via argv. */
  openPopout(taskId: string, name: string, slot: number): void {
    const existing = this.popouts.get(taskId)
    if (existing && !existing.isDestroyed()) {
      existing.show()
      return
    }
    const seed = JSON.stringify({ taskId, name, slot })
    const win = this.create('popout:' + taskId, SURFACES.popout, [`--apprentice-popout=${seed}`])
    this.popouts.set(taskId, win)
    win.show()
  }

  closePopout(taskId: string): void {
    const w = this.popouts.get(taskId)
    if (w && !w.isDestroyed()) w.destroy()
    this.popouts.delete(taskId)
  }

  setHotRect(wcId: number, rect: HotRect): void {
    this.hotRects.set(wcId, rect)
  }

  /** __winmove: the page handed off a drag — move the window natively. */
  beginDrag(win: BrowserWindow): void {
    const cursor = screen.getCursorScreenPoint()
    const b = win.getBounds()
    this.dragWin = win
    this.dragOffset = { x: cursor.x - b.x, y: cursor.y - b.y }
    if (this.dragTimer) clearInterval(this.dragTimer)
    this.dragTimer = setInterval(() => {
      if (!this.dragWin || this.dragWin.isDestroyed()) return this.endDrag()
      const c = screen.getCursorScreenPoint()
      this.dragWin.setPosition(c.x - this.dragOffset.x, c.y - this.dragOffset.y)
    }, 8)
  }

  /** Called from the global input hook on any mouse-up. */
  endDrag(): void {
    if (this.dragTimer) clearInterval(this.dragTimer)
    this.dragTimer = null
    this.dragWin = null
  }

  findByWebContents(wcId: number): BrowserWindow | undefined {
    for (const w of this.allWindows()) if (w.webContents.id === wcId) return w
    return undefined
  }

  allWindows(): BrowserWindow[] {
    return [...this.windows.values(), ...this.popouts.values()].filter((w) => !w.isDestroyed())
  }

  private create(key: string, spec: SurfaceSpec, extraArgs: string[]): BrowserWindow {
    const display = screen.getPrimaryDisplay()
    const wa = display.workArea
    let x = Math.round(wa.x + (wa.width - spec.width) / 2)
    let y: number
    switch (spec.anchor) {
      case 'top':
        y = wa.y + 6
        break
      case 'bottom':
        y = wa.y + wa.height - spec.height - 6
        break
      case 'top-right':
        x = wa.x + wa.width - spec.width - 22
        y = wa.y + 22
        break
      case 'bottom-right':
        x = wa.x + wa.width - spec.width - 20
        y = wa.y + wa.height - spec.height - 20
        break
      default:
        y = Math.round(wa.y + (wa.height - spec.height) / 2)
    }

    const icon = nativeImage.createFromPath(appIcon())
    const win = new BrowserWindow({
      width: spec.width,
      height: spec.height,
      x,
      y,
      show: false,
      frame: !!spec.titled,
      transparent: spec.transparent,
      backgroundColor: spec.transparent ? undefined : '#0a0b10',
      hasShadow: !spec.transparent,
      resizable: !!spec.titled,
      minimizable: !!spec.titled,
      maximizable: !!spec.titled,
      fullscreenable: false,
      skipTaskbar: !spec.titled,
      focusable: spec.focusable,
      icon: icon.isEmpty() ? undefined : icon,
      title: spec.title || 'Apprentice',
      titleBarStyle: spec.titled && process.platform === 'darwin' ? 'hiddenInset' : undefined,
      webPreferences: {
        preload: preloadPath(),
        contextIsolation: false,
        sandbox: false,
        nodeIntegration: false,
        additionalArguments: extraArgs,
        backgroundThrottling: false
      }
    })

    if (spec.level && spec.level !== 'normal') {
      const lvl = spec.level === 'status' ? 'status' : spec.level
      win.setAlwaysOnTop(true, lvl as Parameters<BrowserWindow['setAlwaysOnTop']>[1])
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    }
    if (spec.clickThrough) {
      win.setIgnoreMouseEvents(true, { forward: true })
    }
    if (spec.dismissOnBlur) {
      win.on('blur', () => {
        if (win.isVisible()) win.hide()
      })
    }
    if (spec.titled) {
      // Close button hides (re-open is instant), mirroring WindowHideOnCloseDelegate.
      win.on('close', (e) => {
        if (!appIsQuitting) {
          e.preventDefault()
          win.hide()
        }
      })
    }

    win.loadFile(join(surfacesDir(), spec.page))
    win.webContents.on('did-finish-load', () => this.relay.register(win.webContents))
    this.startClickThroughPoll()
    return win
  }

  /** 50ms cursor poll for click-through windows: toggle mouse passthrough by
   *  hot-rect and feed the page __hostCursor (native-driven hover). */
  private startClickThroughPoll(): void {
    if (this.pollTimer) return
    this.pollTimer = setInterval(() => {
      const cursor = screen.getCursorScreenPoint()
      for (const [key, win] of this.windows) {
        const spec = SURFACES[key]
        if (key === 'audio' || !spec?.clickThrough || win.isDestroyed() || !win.isVisible()) continue
        const b = win.getBounds()
        const inWin = cursor.x >= b.x && cursor.x < b.x + b.width && cursor.y >= b.y && cursor.y < b.y + b.height
        const hr = this.hotRects.get(win.webContents.id)
        let over = false
        if (hr && inWin) {
          over =
            cursor.x >= b.x + hr.x &&
            cursor.x < b.x + hr.x + hr.w &&
            cursor.y >= b.y + hr.y &&
            cursor.y < b.y + hr.y + hr.h
        }
        win.setIgnoreMouseEvents(!over, { forward: true })
        if (!this.dragTimer) {
          safeSend(win.webContents, 'host:cursor', cursor.x - b.x, cursor.y - b.y, inWin)
        }
      }
    }, 50)
  }
}

export let appIsQuitting = false
export function markQuitting(): void {
  appIsQuitting = true
}
