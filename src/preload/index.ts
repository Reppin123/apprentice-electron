import { ipcRenderer } from 'electron'

// Runs with contextIsolation OFF (local-only content, no remote pages) so it
// can emulate the exact host wire the shared-ui surfaces already speak:
//   page → host:  window.webkit.messageHandlers.agent.postMessage(jsonString)
//   host → page:  window.__agentMsg(jsonString)  +  window.__onWired()
// That keeps pill.html / inspector.html / summon.html etc. byte-faithful —
// the same files that rendered in WKWebView (mac) and WebView2 (win).

declare global {
  interface Window {
    __agentMsg?: (s: string) => void
    __onWired?: () => void
    __hostCursor?: (x: number, y: number, over: boolean) => void
    __initTab?: string
    apprentice?: unknown
  }
}

const w = window as Window

// Seeds passed at window creation (must exist BEFORE the page's inline script
// parses — the WKWebView host used atDocumentStart user scripts; here the
// preload runs first, and the seed rides process.argv).
for (const arg of process.argv) {
  if (arg.startsWith('--apprentice-popout=')) {
    try {
      ;(w as unknown as Record<string, unknown>).__popout = JSON.parse(
        arg.slice('--apprentice-popout='.length)
      )
    } catch {
      /* bad seed — page falls back to demo mode */
    }
  } else if (arg.startsWith('--apprentice-init-tab=')) {
    w.__initTab = arg.slice('--apprentice-init-tab='.length)
  }
}

// page → main: every surface message goes up the same channel; the main
// process routes __hotrect/window-control types itself and forwards the rest
// to the agent bridge.
;(w as unknown as Record<string, unknown>).webkit = {
  messageHandlers: {
    agent: {
      postMessage: (s: string): void => {
        try {
          ipcRenderer.send('surface:send', JSON.parse(s))
        } catch {
          /* malformed frames are dropped, same as the native hosts */
        }
      }
    }
  }
}

// main → page: queue until the page's inline script has defined __agentMsg.
let queue: string[] | null = []
function deliver(s: string): void {
  if (typeof w.__agentMsg === 'function') {
    if (queue) {
      for (const q of queue) w.__agentMsg(q)
      queue = null
    }
    w.__agentMsg(s)
  } else if (queue) {
    queue.push(s)
  }
}

ipcRenderer.on('bridge:message', (_e, msg: Record<string, unknown>) => {
  deliver(JSON.stringify(msg))
})

ipcRenderer.on('host:wired', () => {
  const fire = (): void => {
    if (typeof w.__onWired === 'function') w.__onWired()
    // flush anything that arrived pre-wire
    if (queue && typeof w.__agentMsg === 'function') {
      for (const q of queue) w.__agentMsg(q)
      queue = null
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', fire, { once: true })
  } else {
    fire()
  }
})

ipcRenderer.on('host:init-tab', (_e, tab: string) => {
  w.__initTab = tab
})

// Overlay windows are click-through; the main process feeds the cursor so the
// page can hover-hit-test (pill idiom: window.__hostCursor(x, y, over)).
ipcRenderer.on('host:cursor', (_e, x: number, y: number, over: boolean) => {
  if (typeof w.__hostCursor === 'function') w.__hostCursor(x, y, over)
})

// A richer API for NEW surfaces (settings, onboarding, video editor) that
// aren't bound to the legacy wire.
w.apprentice = {
  send: (msg: Record<string, unknown>): void => ipcRenderer.send('surface:send', msg),
  invoke: (channel: string, ...args: unknown[]): Promise<unknown> =>
    ipcRenderer.invoke(channel, ...args),
  onMessage: (handler: (msg: Record<string, unknown>) => void): (() => void) => {
    const listener = (_e: unknown, msg: Record<string, unknown>): void => handler(msg)
    ipcRenderer.on('bridge:message', listener)
    return () => ipcRenderer.removeListener('bridge:message', listener)
  },
  platform: process.platform
}
