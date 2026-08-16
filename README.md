# apprentice-electron

The OS-agnostic Apprentice shell — one Electron codebase for macOS and
Windows, replacing the Swift shell (frozen at tag `freeze/pre-electron-2026-08-16`
in `apprentice-mac`) and the never-shipped C#/WPF Windows shell.

## Architecture

Same two-process split as always:

```
ELECTRON SHELL ("body")            ws://127.0.0.1:8765           PYTHON AGENT ("brain")
├ main process                     token-authed JSON              apprentice-agent, unchanged
│  ├ bridge.ts       — the ONE ws client (Origin-free, keepalive,
│  │                    hello re-asserts model_id/user_name)
│  ├ agentProcess.ts — attach-or-spawn the agent (frozen or dev venv)
│  ├ relay.ts        — fan the socket out to every surface window
│  ├ windows.ts      — surface specs + click-through hot-rect poll
│  ├ overlayService.ts— per-display presence overlay + pointing ACKs
│  ├ input.ts        — global hotkeys + ⌃⌥ hold (uiohook)
│  ├ apvServer.ts    — the :19791 MCP server for the APV editor tools
│  ├ services/       — TTS backends, STT, utterance pacing
│  └ auth.ts / settings.ts / permissions.ts / tray.ts / paths.ts
├ preload — emulates the WKWebView/WebView2 wire
│    (webkit.messageHandlers.agent ⇄ window.__agentMsg / __onWired)
└ renderer/surfaces/*.html — ONE FILE PER SURFACE, vanilla HTML/CSS/JS,
     the same files that rendered in WKWebView (mac) and WebView2 (win)
```

Surfaces: pill, agent-dock (hearth), summon, inspector (8 tabs), popout,
menubar panel, onboarding, about, auth gate, control gate, guide, call assist
(live/recap/dialog/minutes/history), video editor (cut reviewer), APV editor,
overlay (orb/bubbles/annotations), audio (hidden).

## Dev

```bash
npm install
npm run dev        # spawns/attaches the python agent from ~/Clicky-Apprenticeship/apprentice-agent
npm run typecheck
```

The shell attaches if something already listens on :8765 (e.g. a cutover
agent), else spawns the dev agent from the sibling repo's venv.

## Package

Put a frozen agent at `resources/agent.dist/` (mac: `build_agent.sh`; win:
`build_agent_windows.ps1` or the CI freeze job), then:

```bash
npm run package:mac
npm run package:win
```

## The wire

PROTOCOL.md v0 in apprentice-agent, but implement from code, not the doc.
Golden rules: main process owns the single socket (a renderer ws carries an
Origin header and is rejected); hello must carry `auth_token` within 5s and
re-assert `model_id` + `user_name` on every connect; every id-bearing
annotation command gets a truthful `annotation_result` ACK; the shell owns
all coordinate-space math; `agent_ready` resets the agent list.
