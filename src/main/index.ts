import { app, ipcMain, powerMonitor, shell, dialog, clipboard, BrowserWindow } from 'electron'
import { readdirSync, readFileSync, existsSync, writeFileSync } from 'fs'
import { join, basename } from 'path'
import { AgentBridge } from './bridge'
import { AgentProcess } from './agentProcess'
import { SurfaceRelay } from './relay'
import { safeSend } from './relay'
import { SurfaceManager, markQuitting } from './windows'
import { SettingsStore } from './settings'
import { registerHotkeys, unregisterHotkeys } from './input'
import { installTray } from './tray'
import { OverlayService } from './overlayService'
import { ApvServer } from './apvServer'
import { AuthGuard } from './auth'
import { permState, requestPermission, revealSelfInFinder } from './permissions'
import { dataDir, logDir } from './paths'
import { BridgeMessage } from '../shared/protocol'
import { VoiceService } from './services/voice'

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  main()
}

function main(): void {
  const settings = new SettingsStore()
  const agent = new AgentProcess()
  const bridge = new AgentBridge(agent.token, 'electron')
  bridge.modelId = (settings.get('selectedModelId') as string) || null
  bridge.userName = (settings.get('userName') as string) || null
  const relay = new SurfaceRelay(bridge)
  const surfaces = new SurfaceManager(relay)
  const overlay = new OverlayService(bridge)
  const apv = new ApvServer(() => surfaces.get('apv-editor'))
  const auth = new AuthGuard()
  let voice: VoiceService | null = null

  let agentState = 'starting'
  let lastVoiceState = 'resting'
  // assert-and-PREFER: reads never recompute — once the agent echoes its
  // dirs in the hello, shell-side file reads use those (attach mode may
  // legitimately land on a differently-rooted agent, e.g. an A/B arm).
  let agentDataDir: string | null = null
  const effectiveDataDir = (): string => agentDataDir || dataDir()

  const pushShellStatus = (): void => {
    const p = permState()
    relay.pushToSurfaces({
      type: 'shell_status',
      backend: agentState,
      permissions: {
        mic: p.mic,
        accessibility: p.accessibility,
        screen: p.screen,
        screenContent: p.screen
      },
      allGranted: p.mic && p.accessibility && p.screen,
      agentStopped: agentState === 'stopped',
      voiceState: lastVoiceState
    })
  }

  const pushTune = (): void => {
    const email = auth.current.state === 'authorized' ? auth.current.email : ''
    relay.pushToSurfaces(settings.buildTuneState(email, app.getVersion()))
  }

  const pushAuth = (): void => {
    const s = auth.current as Record<string, unknown> & { state: string }
    relay.pushToSurfaces({ type: 'auth_state', state: s.state, email: s.email, detail: s.detail })
  }

  auth.onChange = () => pushAuth()

  // ── bridge routing ────────────────────────────────────────────────────
  bridge.subscribe((msg) => {
    if (msg.type === '_bridge_connected') {
      agentState = 'ready'
      pushShellStatus()
      // hello replay + schedule refresh happens agent-side on connect
      return
    }
    if (msg.type === '_bridge_disconnected') {
      agentState = agent.attached ? 'reconnecting' : 'starting'
      pushShellStatus()
      return
    }
    if (msg.type === 'hello' && msg.dirs) {
      // config-dir integrity: launcher owns policy, agent owns mechanism —
      // a mismatch here is the class of bug that blanked call history.
      const agentData = (msg.dirs as Record<string, unknown>).data_dir
      if (typeof agentData === 'string' && agentData) {
        if (agentData !== dataDir()) {
          console.error(`🔴 config-dir MISMATCH: shell=${dataDir()} agent=${agentData} — preferring the agent's`)
        }
        agentDataDir = agentData
      }
    }
    // presence/annotation router (may consume)
    overlay.handleBridgeMessage(msg)
    // voice layer (say → TTS, interrupts, call frames)
    voice?.onBridgeMessage?.(msg)
    if (msg.type === 'agent_blocked' && msg.reason === 'auth') {
      auth.refresh().then(() => {
        if (auth.current.state !== 'authorized') surfaces.show('auth-gate')
      })
    }
    if (msg.type === 'agent_focus_changed' || msg.type === 'agent_ready') {
      const slot = Number((msg as Record<string, unknown>).color_slot ?? 0)
      if (!Number.isNaN(slot)) overlay.setColorSlot(slot)
    }
    if (msg.type === 'set_state') {
      lastVoiceState = String(msg.state || 'idle')
      // "on screen: while we talk" — orb only shows during voice states
      if (!settings.get('pointerAlways')) {
        overlay.setOrb({ visible: lastVoiceState !== 'idle' })
      }
    }
  })

  // ── host actions from surfaces ────────────────────────────────────────
  relay.onHostAction = (type, payload, sender) => {
    switch (type) {
      case '__hotrect': {
        surfaces.setHotRect(sender.id, {
          x: Number(payload.x || 0),
          y: Number(payload.y || 0),
          w: Number(payload.w || 0),
          h: Number(payload.h || 0)
        })
        return
      }
      case '__winmove': {
        const win = surfaces.findByWebContents(sender.id)
        if (win) surfaces.beginDrag(win)
        return
      }
      case 'summon_open':
        surfaces.show('summon')
        return
      case 'agent_pop_out':
        surfaces.openPopout(
          String(payload.task_id || ''),
          String(payload.name || 'strand'),
          Number(payload.slot || 0)
        )
        return
      case 'popout_close':
        surfaces.closePopout(String(payload.task_id || ''))
        return
      case 'tune_request':
        pushTune()
        return
      case 'host_open':
        openSurface(String(payload.surface || ''))
        return
      case 'host_quit':
        app.quit()
        return
      case 'apv_rpc_result':
        apv.handleRpcResult(payload)
        return
      case 'ui_action':
        handleUiAction(String(payload.action || ''), payload.value, sender)
        return
    }
  }

  function openSurface(name: string): void {
    if (name === 'apv-editor') {
      surfaces.show('apv-editor')
      apv.start()
      return
    }
    if (name in { inspector: 1, summon: 1, guide: 1, about: 1, 'video-editor': 1, 'call-history': 1, onboarding: 1 }) {
      surfaces.show(name)
    }
  }

  function handleUiAction(action: string, value: unknown, sender: Electron.WebContents): void {
    // voice layer first (audio_done / mic_chunk / stt plumbing)
    if (voice?.handleUiAction?.(action, value)) return
    switch (action) {
      // Tune (mirrors handleWebUIAction in leanring_buddyApp.swift)
      case 'set_sees':
        settings.set('sees', !!value)
        break
      case 'set_peek':
        settings.set('peek', !!value)
        break
      case 'set_cursor_color':
        if (typeof value === 'number') {
          settings.set('cursorColor', value)
          overlay.setColorSlot(value)
        }
        break
      case 'set_tts':
        if (typeof value === 'string') settings.set('ttsBackend', value === 'apple' ? 'system' : value)
        break
      case 'set_tts_key': {
        const o = (value || {}) as Record<string, string>
        if (o.engine === 'google') settings.set('googleAPIKey', o.key || '')
        if (o.engine === 'openai') settings.set('openaiAPIKey', o.key || '')
        if (o.engine === 'cartesia') settings.set('cartesiaAPIKey', o.key || '')
        break
      }
      case 'clear_tts_key':
        if (value === 'google') settings.set('googleAPIKey', '')
        if (value === 'openai') settings.set('openaiAPIKey', '')
        if (value === 'cartesia') settings.set('cartesiaAPIKey', '')
        break
      case 'set_voice': {
        const o = (value || {}) as Record<string, string>
        if (o.engine === 'edge') settings.set('edgeVoiceID', o.voice_id)
        if (o.engine === 'google') settings.set('googleVoiceID', o.voice_id)
        if (o.engine === 'openai') settings.set('openaiVoiceID', o.voice_id)
        break
      }
      case 'set_openai_speed':
        if (typeof value === 'number') settings.set('openaiSpeed', value)
        break
      case 'set_hue_size':
        if (value === 'small' || value === 'regular' || value === 'large') {
          settings.set('hueSize', value)
          overlay.setOrb({ size: value })
        }
        break
      case 'set_pointer_always':
        settings.set('pointerAlways', !!value)
        overlay.setOrb({ visible: !!value || lastVoiceState !== 'resting' })
        break
      case 'focus_color':
        if (typeof value === 'number') overlay.setColorSlot(value)
        return // transient — no tune push
      case 'check_updates':
      case 'open_update':
        // Sparkle's replacement (electron-updater) lands with packaging; no-op for now.
        overlay.toast('updates ship with the packaged build')
        break
      case 'sign_out':
      case 'switch_account':
        auth.logout().then(() => surfaces.show('auth-gate'))
        break
      case 'report_problem':
        shell.openExternal(
          'mailto:aki@withapprentice.com?subject=Apprentice%20problem%20report&body=' +
            encodeURIComponent(`log dir: ${logDir()}`)
        )
        break
      case 'summon_dismiss':
        surfaces.hide('summon')
        break
      // menubar panel
      case 'relaunch_agent':
        agent.stop()
        agent.start()
        break
      case 'dismiss_panel':
        surfaces.hide('menubar')
        break
      case 'grant_permission':
        requestPermission(String(value)).then(pushShellStatus)
        break
      case 'replay_onboarding':
        surfaces.show('onboarding')
        break
      case 'close_about':
        surfaces.hide('about')
        break
      case 'reveal_log':
        shell.showItemInFolder(join(logDir(), 'agent.log'))
        break
      // auth gate
      case 'auth_login':
        auth.login(value === 'console' ? 'console' : 'claudeai')
        break
      case 'auth_close':
        surfaces.hide('auth-gate')
        break
      // onboarding
      case 'perm_request':
        requestPermission(String(value)).then(() => pushPerms())
        break
      case 'onboarding_restart_app':
        // resume at the post-restart phase after the TCC quit-and-reopen
        settings.set('onboardingResume', 'automation')
        app.relaunch()
        app.quit()
        break
      case 'onboarding_reveal_app':
        revealSelfInFinder()
        break
      case 'onboarding_complete':
        settings.set('hasCompletedOnboarding', true)
        surfaces.hide('onboarding')
        startMainSurfaces()
        break
      // call assist
      case 'call_history_request':
        pushCallHistory(sender)
        break
      case 'call_export_markdown':
        if (typeof value === 'string' && existsSync(value)) shell.showItemInFolder(value)
        break
      case 'call_delete_record':
        if (typeof value === 'string' && value.startsWith(join(effectiveDataDir(), 'calls'))) {
          try {
            require('fs').unlinkSync(value)
          } catch {
            /* already gone */
          }
        }
        break
      case 'call_open_window':
        if (value === 'minutes') surfaces.show('call-minutes')
        if (value === 'history') surfaces.show('call-history')
        break
      case 'call_close':
        if (value === 'live') surfaces.hide('call-live')
        if (value === 'recap') surfaces.hide('call-recap')
        if (value === 'dialog') surfaces.hide('call-dialog')
        break
      // video/apv
      case 'reveal_path':
        if (typeof value === 'string') shell.showItemInFolder(value)
        break
      case 'apv_import': {
        dialog
          .showOpenDialog({
            properties: ['openFile', 'multiSelections'],
            filters: [{ name: 'Media', extensions: ['mp4', 'mov', 'mkv', 'webm', 'mp3', 'wav', 'm4a', 'png', 'jpg', 'jpeg'] }]
          })
          .then((r) => {
            if (r.canceled) return
            const files = r.filePaths.map((p) => ({
              path: p,
              kind: /\.(png|jpe?g)$/i.test(p) ? 'image' : /\.(mp3|wav|m4a)$/i.test(p) ? 'audio' : 'video'
            }))
            sender.send('bridge:message', { type: 'apv_media_add', files })
          })
        break
      }
      case 'apv_autosave': {
        try {
          const dir = join(effectiveDataDir(), 'VideoProjects')
          if (!existsSync(dir)) require('fs').mkdirSync(dir, { recursive: true })
          writeFileSync(join(dir, 'Untitled.apvproj.json'), JSON.stringify(value))
        } catch (err) {
          console.error('[apv] autosave failed', err)
        }
        break
      }
      case 'apv_export':
        overlay.toast('export needs ffmpeg — coming with the packaged build')
        break
      case 'apv_assistant':
        bridge.send({ type: 'transcript_final', text: String(value || '') })
        break
      case 'copy_text':
        if (typeof value === 'string') clipboard.writeText(value)
        break
      default:
        console.warn('[main] unhandled ui_action', action)
    }
    pushTune()
  }

  function pushPerms(): void {
    relay.pushToSurfaces({ type: 'perm_state', ...permState() })
  }

  function pushCallHistory(sender: Electron.WebContents): void {
    const dir = join(effectiveDataDir(), 'calls')
    let records: Record<string, unknown>[] = []
    try {
      records = readdirSync(dir)
        .filter((f) => f.endsWith('.md'))
        .map((f) => {
          const p = join(dir, f)
          let summary = ''
          try {
            summary = readFileSync(p, 'utf-8').slice(0, 400)
          } catch {
            /* unreadable */
          }
          return { path: p, title: basename(f, '.md'), date: f.slice(0, 10), summary, has_transcript: true }
        })
        .reverse()
    } catch {
      /* no calls dir yet */
    }
    sender.send('bridge:message', { type: 'call_history_state', records })
  }

  // ── model/user changes ride the wire AND persist shell-side ───────────
  ipcMain.on('surface:send', (e, msg: BridgeMessage) => {
    if (msg && msg.type === 'set_model' && typeof msg.model_id === 'string') {
      settings.set('selectedModelId', msg.model_id)
      bridge.modelId = msg.model_id
      relay.fromSurface(msg, e.sender)
      // deliberate reconnect so the new session runs the pick
      setTimeout(() => bridge.forceReconnect(), 150)
      return
    }
    if (msg && msg.type === 'set_user_name' && typeof msg.name === 'string') {
      settings.set('userName', msg.name)
      bridge.userName = msg.name
    }
    // call lifecycle: the live surface owns call_start/call_stop on the wire;
    // main mirrors them into mic/system-audio capture.
    if (msg && msg.type === 'call_start') {
      const mode = typeof msg.mode === 'string' ? msg.mode : 'remote'
      settings.set('callMode', mode)
      voice?.startCall?.(mode)
    }
    if (msg && msg.type === 'call_stop') voice?.stopCall?.()
    relay.fromSurface(msg, e.sender)
  })

  ipcMain.on('win:close', (e) => BrowserWindow.fromWebContents(e.sender)?.hide())
  ipcMain.on('win:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize())
  ipcMain.on('win:setSize', (e, w: number, h: number) =>
    BrowserWindow.fromWebContents(e.sender)?.setSize(Math.round(w), Math.round(h))
  )
  ipcMain.on('win:setIgnoreMouseEvents', (e, ignore: boolean) =>
    BrowserWindow.fromWebContents(e.sender)?.setIgnoreMouseEvents(ignore, { forward: true })
  )

  // ── startup ───────────────────────────────────────────────────────────
  function startMainSurfaces(): void {
    surfaces.show('pill')
    surfaces.show('dock')
    pushShellStatus()
  }

  app.whenReady().then(async () => {
    if (process.platform === 'darwin') app.dock?.hide()

    installTray(surfaces)
    overlay.start()
    overlay.setOrb({
      size: (settings.get('hueSize') as string) || 'regular',
      visible: !!settings.get('pointerAlways')
    })
    overlay.setColorSlot((settings.get('cursorColor') as number) || 0)

    // hidden audio window for playback + mic
    const audioWin = surfaces.show('audio')
    audioWin.hide()
    voice = new VoiceService({
      send: (m: BridgeMessage) => bridge.send(m),
      pushToSurfaces: (m: BridgeMessage) => {
        relay.pushToSurfaces(m)
        overlay.broadcast(m)
      },
      getAudioWindow: () => surfaces.get('audio') || null,
      settings
    })

    registerHotkeys({
      onSummon: () => surfaces.toggle('summon'),
      onInspector: () => surfaces.toggle('inspector'),
      onAbout: () => surfaces.toggle('about'),
      onVideoEditor: () => surfaces.toggle('video-editor'),
      onApvEditor: () => {
        surfaces.toggle('apv-editor')
        if (surfaces.get('apv-editor')?.isVisible()) apv.start()
        else apv.stop()
      },
      onCallToggle: () => {
        const live = surfaces.get('call-live')
        if (live && live.isVisible()) {
          // page reacts to call_stop by closing; capture stops via the
          // surface:send mirror
          bridge.send({ type: 'call_stop' })
          voice?.stopCall?.()
          surfaces.hide('call-live')
        } else {
          surfaces.show('call-live') // the live page sends call_start on wire-up
        }
      },
      onCallPoint: () => bridge.send({ type: 'call_assist_now', action: 'say' }),
      onCallHistory: () => surfaces.toggle('call-history'),
      onAgentNext: () => bridge.send({ type: 'rotate_primary' }),
      onAgentPrev: () => bridge.send({ type: 'rotate_primary' }),
      onAgentNew: () => bridge.send({ type: 'agent_spawn', focus: true }),
      onPttDown: () => voice?.pttDown?.(),
      onPttUp: () => voice?.pttUp?.(),
      onMouseUp: () => surfaces.endDrag()
    })

    powerMonitor.on('resume', () => bridge.probe())

    // launch flow: onboarding → auth → agent + surfaces
    await auth.refresh()
    if (!settings.get('hasCompletedOnboarding')) {
      const ob = surfaces.show('onboarding')
      const resume = settings.get('onboardingResume') as string
      if (resume) {
        ob.webContents.on('did-finish-load', () => {
          safeSend(ob.webContents, 'bridge:message', { type: 'onboarding_resume', step: resume })
        })
        // also cover the already-loaded case
        safeSend(ob.webContents, 'bridge:message', { type: 'onboarding_resume', step: resume })
        settings.set('onboardingResume', '')
      }
      pushPerms()
      const permTimer = setInterval(() => {
        if (!surfaces.get('onboarding')?.isVisible()) return
        pushPerms()
        pushAuth()
      }, 1500)
      surfaces.get('onboarding')?.on('closed', () => clearInterval(permTimer))
    } else {
      startMainSurfaces()
    }
    if (auth.current.state !== 'authorized' && settings.get('hasCompletedOnboarding')) {
      surfaces.show('auth-gate')
    }

    agentState = 'starting'
    await agent.start()
    bridge.start()

    // status pushes for the menubar panel / about
    setInterval(() => {
      pushShellStatus()
      const s = auth.current as Record<string, unknown> & { state: string }
      relay.pushToSurfaces({
        type: 'about_state',
        version: app.getVersion(),
        install_id: agent.token.slice(0, 8),
        email: s.email || '',
        plan: s.state === 'authorized' ? 'Claude Max / Pro or API billing' : '—',
        agent_state: agentState,
        log_path: join(logDir(), 'agent.log'),
        telemetry: 'local-only',
        control_message: ''
      })
    }, 5000)
  })

  app.on('before-quit', () => {
    markQuitting()
    unregisterHotkeys()
    apv.stop()
    overlay.stop()
    bridge.stop()
    agent.stop()
  })

  app.on('window-all-closed', () => {
    // tray app — stay alive
  })
}
