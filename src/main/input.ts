import { globalShortcut } from 'electron'
import { uIOhook, UiohookKey } from 'uiohook-napi'

// Global input — the CGEvent-tap twin. Combos ride Electron's globalShortcut
// (⌘ on mac ↔ Ctrl+Alt kept as-is per the Swift map, which already uses
// modifier pairs that exist on both OSes). The ⌃⌥ HOLD (push-to-talk) and
// global mouse-up (native drag handoff) need uiohook — listen-only, never
// swallows keys, same as the Swift taps.

export interface InputHandlers {
  onSummon(): void // ⌘⌥S
  onInspector(): void // ⌘⌥J
  onAbout(): void // ⌘⌥I
  onVideoEditor(): void // ⌘⌥V
  onApvEditor(): void // ⌘⌥E
  onCallToggle(): void // ⌃⌥C
  onCallPoint(): void // ⌃⌥Space
  onCallHistory(): void // ⌃⌥H
  onAgentNext(): void // ⌃⌘→
  onAgentPrev(): void // ⌃⌘←
  onAgentNew(): void // ⌃⌘N
  onPttDown(): void // ⌃⌥ hold begins
  onPttUp(): void // ⌃⌥ hold ends
  onMouseUp(): void // drag end
}

// mac: Command+Alt+<k>; win/linux: Control+Alt+<k> (⌘→Ctrl mapping).
function mod(k: string): string {
  return (process.platform === 'darwin' ? 'Command+Alt+' : 'Control+Alt+') + k
}
// ⌃⌘<k> on mac; Control+Shift on win (Ctrl+Alt is taken by the ⌘⌥ family).
function ctrlCmd(k: string): string {
  return (process.platform === 'darwin' ? 'Control+Command+' : 'Control+Shift+') + k
}

export function registerHotkeys(h: InputHandlers): void {
  const map: Record<string, () => void> = {
    [mod('S')]: h.onSummon,
    [mod('J')]: h.onInspector,
    [mod('I')]: h.onAbout,
    [mod('V')]: h.onVideoEditor,
    [mod('E')]: h.onApvEditor,
    'Control+Alt+C': h.onCallToggle,
    'Control+Alt+Space': h.onCallPoint,
    'Control+Alt+H': h.onCallHistory,
    [ctrlCmd('Right')]: h.onAgentNext,
    [ctrlCmd('Left')]: h.onAgentPrev,
    [ctrlCmd('N')]: h.onAgentNew
  }
  for (const [accel, fn] of Object.entries(map)) {
    try {
      if (!globalShortcut.register(accel, fn)) {
        console.warn(`[input] could not register ${accel} (in use elsewhere)`)
      }
    } catch (err) {
      console.warn(`[input] register ${accel} failed`, err)
    }
  }

  // ⌃⌥ hold = push-to-talk. Track both modifiers via raw key events; fire
  // down when the second lands, up when either lifts. A normal combo press
  // (⌃⌥C etc.) also trips this briefly — debounce by requiring 250ms of hold
  // before onPttDown, matching the Swift hold-to-talk feel.
  let ctrl = false
  let alt = false
  let holdTimer: NodeJS.Timeout | null = null
  let holding = false

  const update = (): void => {
    const both = ctrl && alt
    if (both && !holdTimer && !holding) {
      holdTimer = setTimeout(() => {
        holdTimer = null
        holding = true
        h.onPttDown()
      }, 250)
    } else if (!both) {
      if (holdTimer) {
        clearTimeout(holdTimer)
        holdTimer = null
      }
      if (holding) {
        holding = false
        h.onPttUp()
      }
    }
  }

  uIOhook.on('keydown', (e) => {
    if (e.keycode === UiohookKey.Ctrl || e.keycode === UiohookKey.CtrlRight) ctrl = true
    else if (e.keycode === UiohookKey.Alt || e.keycode === UiohookKey.AltRight) alt = true
    else if (holding || holdTimer) {
      // another key joined — this is a combo, not a hold
      if (holdTimer) {
        clearTimeout(holdTimer)
        holdTimer = null
      }
      return
    } else return
    update()
  })
  uIOhook.on('keyup', (e) => {
    if (e.keycode === UiohookKey.Ctrl || e.keycode === UiohookKey.CtrlRight) ctrl = false
    else if (e.keycode === UiohookKey.Alt || e.keycode === UiohookKey.AltRight) alt = false
    else return
    update()
  })
  uIOhook.on('mouseup', () => h.onMouseUp())

  try {
    uIOhook.start()
  } catch (err) {
    console.error('[input] uiohook failed to start (PTT disabled)', err)
  }
}

export function unregisterHotkeys(): void {
  globalShortcut.unregisterAll()
  try {
    uIOhook.stop()
  } catch {
    /* already stopped */
  }
}
