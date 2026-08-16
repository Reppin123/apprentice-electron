import { clipboard, desktopCapturer } from 'electron'
import { spawn } from 'node:child_process'
import { UtteranceController, UtteranceEvents } from './utterances'
import { AudioSink, TTSBackend, TTSCallbacks } from './tts/types'
import { EdgeTTSBackend, EDGE_DEFAULT_VOICE } from './tts/edge'
import { OpenAITTSBackend, OPENAI_DEFAULT_VOICE, OPENAI_SPEED_RANGE } from './tts/openai'
import { GoogleTTSBackend, GOOGLE_DEFAULT_VOICE } from './tts/google'
import { CartesiaTTSBackend } from './tts/cartesia'
import { SystemTTSBackend } from './tts/system'
import { FailoverSTT, SttEngine } from './stt/native'
import { safeSend } from '../relay'

// The voice facade — the Electron twin of the Swift voice stack
// (CompanionManager voice paths + BuddyDictationManager + drive-mode
// set_state mirroring in leanring_buddyApp). Owns:
//   • the UtteranceController + active TTS backend (settings-driven),
//   • the hidden audio.html page (playback + mic capture over synthetic
//     bridge frames: audio_play/audio_end/audio_stop/audio_mic_start/stop),
//   • push-to-talk and dictation-paste via Deepgram streaming STT,
//   • live-call audio forwarding (call_audio {channel, pcm_b64} frames),
//   • pill mirroring: set_state{listening|transcribing|thinking|speaking|
//     resting} pushed to all surfaces on local transitions.

export interface VoiceDeps {
  send(msg: Record<string, unknown>): void // → agent ws
  pushToSurfaces(msg: Record<string, unknown>): void // → all surface windows (synthetic frames)
  getAudioWindow(): Electron.BrowserWindow | null // the hidden audio.html window
  settings: {
    get(key: string): unknown // ttsBackend, edgeVoiceID, googleVoiceID, openaiVoiceID, cartesiaVoiceID, googleAPIKey, openaiAPIKey, cartesiaAPIKey, openaiSpeed, callMode
  }
}

type MicMode = 'off' | 'ptt' | 'dictation' | 'call'

const NO_STT_TOAST = 'voice needs a transcription key — type in the summon instead'

export class VoiceService {
  private deps: VoiceDeps
  private controller: UtteranceController

  private backend: TTSBackend | null = null
  private backendSig = ''
  private sysTts: SystemTTSBackend | null = null

  private stt: SttEngine | null = null
  private micMode: MicMode = 'off'
  private callMode = 'remote'
  private loopbackHandlerSet = false

  // Voice-state derivation inputs (pushVoice twin from leanring_buddyApp).
  private capturing = false
  private finalizing = false
  private agentState = 'idle'
  private lastPushedState = ''

  private ttsCb: TTSCallbacks = {
    onStart: (id) => this.controller.handleDidStart(id),
    onFinish: (id, cancelled) => this.controller.handleDidFinish(id, cancelled)
  }

  private sink: AudioSink = {
    play: (id, chunkB64, format, rate, speed) =>
      this.sendToAudio({ type: 'audio_play', id, chunk_b64: chunkB64, format, rate, speed }),
    end: (id) => this.sendToAudio({ type: 'audio_end', id }),
    stop: () => this.sendToAudio({ type: 'audio_stop' })
  }

  constructor(deps: VoiceDeps) {
    this.deps = deps
    const events: UtteranceEvents = {
      onUtteranceStart: (u) => {
        this.deps.pushToSurfaces({
          type: 'overlay_bubble',
          text: u.spokenText,
          display_text: u.displayOverride ?? u.spokenText
        })
        this.pushVoiceState()
      },
      onBubbleClear: () => this.deps.pushToSurfaces({ type: 'overlay_bubble_clear' }),
      onActivityChange: () => this.pushVoiceState()
    }
    this.controller = new UtteranceController(() => this.ensureBackend(), events)
  }

  // MARK: - Speech out

  /** Agent said something → TTS + overlay bubble pacing. */
  handleSay(msg: { text: string; subtitle?: string }): void {
    this.controller.enqueue(msg.text ?? '', msg.subtitle || undefined)
  }

  /** Barge-in: stop TTS, flush the queue. */
  interrupt(): void {
    this.controller.stopAll()
  }

  // MARK: - Push-to-talk (⌃⌥)

  pttDown(): void {
    if (this.micMode !== 'off') return
    this.interrupt() // barge-in: the apprentice yields the floor
    this.micMode = 'ptt'
    this.capturing = true
    this.finalizing = false
    this.beginStt()
    this.sendToAudio({ type: 'audio_mic_start', capture_sys: false })
    this.pushVoiceState()
  }

  pttUp(): void {
    if (this.micMode !== 'ptt') return
    this.micMode = 'off'
    this.capturing = false
    this.finalizing = true
    this.sendToAudio({ type: 'audio_mic_stop' })
    this.pushVoiceState()
    const stt = this.stt
    this.stt = null
    void (async () => {
      let text = ''
      if (stt) {
        try {
          text = await stt.finish()
        } catch {
          text = ''
        }
      } else {
        this.deps.pushToSurfaces({ type: 'overlay_toast', text: NO_STT_TOAST })
      }
      if (text) this.deps.send({ type: 'transcript_final', text })
      this.finalizing = false
      this.pushVoiceState()
    })()
  }

  // MARK: - Global dictation-paste

  dictationDown(): void {
    if (this.micMode !== 'off') return
    this.micMode = 'dictation'
    this.capturing = true
    this.finalizing = false
    this.beginStt()
    this.sendToAudio({ type: 'audio_mic_start', capture_sys: false })
    this.pushVoiceState()
  }

  async dictationUp(): Promise<void> {
    if (this.micMode !== 'dictation') return
    this.micMode = 'off'
    this.capturing = false
    this.finalizing = true
    this.sendToAudio({ type: 'audio_mic_stop' })
    this.pushVoiceState()
    const stt = this.stt
    this.stt = null
    let text = ''
    if (stt) {
      try {
        text = await stt.finish()
      } catch {
        text = ''
      }
    } else {
      this.deps.pushToSurfaces({ type: 'overlay_toast', text: NO_STT_TOAST })
    }
    if (text) this.pasteTranscript(text)
    this.finalizing = false
    this.pushVoiceState()
  }

  // MARK: - Live call audio

  startCall(mode: string): void {
    this.callMode = mode || String(this.deps.settings.get('callMode') ?? 'remote')
    this.micMode = 'call'
    // System-audio loopback: Electron supports it on Windows only (macOS
    // needs the native ScreenCaptureKit path the Swift app used).
    const wantSys = process.platform === 'win32' && this.callMode !== 'inperson'
    if (wantSys) this.ensureLoopbackHandler()
    this.sendToAudio({ type: 'audio_mic_start', capture_sys: wantSys })
  }

  stopCall(): void {
    if (this.micMode !== 'call') return
    this.micMode = 'off'
    this.sendToAudio({ type: 'audio_mic_stop' })
  }

  // MARK: - Inbound agent frames

  /** Feed every inbound agent frame here (say / agent_interrupted / set_state). */
  onBridgeMessage(msg: Record<string, unknown>): void {
    switch (msg.type) {
      case 'say':
        this.handleSay({
          text: typeof msg.text === 'string' ? msg.text : '',
          subtitle: typeof msg.subtitle === 'string' ? msg.subtitle : undefined
        })
        break
      case 'agent_interrupted':
        // Cut TTS + clear the mid-speech bubble in one call.
        this.interrupt()
        break
      case 'set_state':
        // The frame itself reaches surfaces via the relay fan-out; we track
        // it so the local derivation (speaking/listening…) layers on top.
        this.agentState = typeof msg.state === 'string' ? msg.state : 'idle'
        this.pushVoiceState()
        break
      default:
        break
    }
  }

  // MARK: - Host actions from surfaces (forwarded by the app wiring)

  /** Returns true when the action was consumed (audio_done / mic frames). */
  handleUiAction(action: string, value: unknown): boolean {
    if (action === 'audio_done') {
      this.backend?.handleAudioDone(String(value ?? ''))
      return true
    }
    if (action === 'mic_chunk') {
      const v = (value ?? {}) as Record<string, unknown>
      const b64 = typeof v.pcm_b64 === 'string' ? v.pcm_b64 : ''
      if (!b64) return true
      if (this.micMode === 'call') {
        this.deps.send({
          type: 'call_audio',
          channel: typeof v.channel === 'string' ? v.channel : 'mic',
          pcm_b64: b64
        })
      } else if (this.stt) {
        this.stt.sendPcm(Buffer.from(b64, 'base64'))
      }
      return true
    }
    if (action === 'mic_error') {
      console.warn('[voice] mic error from audio page:', value)
      this.deps.pushToSurfaces({
        type: 'overlay_toast',
        text: "couldn't reach the microphone — check mic permission"
      })
      return true
    }
    return false
  }

  // MARK: - Internals

  private beginStt(): void {
    // Native Apple Speech on mac (prod-parity, on-device) with transparent
    // Deepgram failover; Deepgram directly elsewhere.
    const stt = new FailoverSTT()
    this.stt = stt
    stt.start().catch((err) => {
      console.warn('[voice] deepgram start failed', err)
      if (this.stt === stt) this.stt = null
    })
  }

  private sendToAudio(frame: Record<string, unknown>): void {
    const win = this.deps.getAudioWindow()
    if (!win || win.isDestroyed()) {
      // No audio page → nothing can play or capture; the controller's
      // watchdog keeps the speech queue advancing.
      return
    }
    // Same channel the preload already speaks ('bridge:message' →
    // window.apprentice.onMessage), targeted at the audio window only so
    // base64 audio doesn't fan out to every surface.
    safeSend(win.webContents, 'bridge:message', frame)
  }

  /// Drive-mode pushVoice twin: derive the pill state from (dictation,
  /// finalizing, speech queue, agent state) and push only on transitions.
  private pushVoiceState(): void {
    const s = this.capturing
      ? 'listening'
      : this.finalizing
        ? 'transcribing'
        : this.controller.audioActive
          ? 'speaking'
          : this.agentState === 'thinking'
            ? 'thinking'
            : 'resting'
    if (s === this.lastPushedState) return
    this.lastPushedState = s
    this.deps.pushToSurfaces({ type: 'set_state', state: s })
  }

  /// Write the transcript into the focused external app: clipboard swap +
  /// synthesized paste keystroke, prior clipboard restored after 300ms
  /// (DictationPaste.swift flow shape).
  private pasteTranscript(text: string): void {
    const prior = clipboard.readText()
    clipboard.writeText(text)
    try {
      if (process.platform === 'darwin') {
        spawn('/usr/bin/osascript', [
          '-e',
          'tell application "System Events" to keystroke "v" using command down'
        ])
      } else if (process.platform === 'win32') {
        spawn(
          'powershell.exe',
          [
            '-NoProfile',
            '-Command',
            "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')"
          ],
          { windowsHide: true }
        )
      }
    } catch (err) {
      console.warn('[voice] paste keystroke failed', err)
    }
    setTimeout(() => clipboard.writeText(prior), 300)
  }

  private ensureLoopbackHandler(): void {
    if (this.loopbackHandlerSet) return
    const win = this.deps.getAudioWindow()
    if (!win || win.isDestroyed()) return
    this.loopbackHandlerSet = true
    win.webContents.session.setDisplayMediaRequestHandler((_request, callback) => {
      desktopCapturer
        .getSources({ types: ['screen'] })
        .then((sources) =>
          callback(sources.length ? { video: sources[0], audio: 'loopback' } : {})
        )
        .catch(() => callback({}))
    })
  }

  // MARK: - Backend selection (settings-driven, rebuilt on change)

  private ensureBackend(): TTSBackend {
    const s = this.deps.settings
    const kind = String(s.get('ttsBackend') ?? 'edge')
    const keyOf = (k: string): string => String(s.get(k) ?? '').trim()
    let sig = kind
    if (kind === 'google') sig += '|' + keyOf('googleAPIKey')
    else if (kind === 'openai') sig += '|' + keyOf('openaiAPIKey')
    else if (kind === 'cartesia') sig += '|' + keyOf('cartesiaAPIKey')
    if (this.backend && sig === this.backendSig) return this.backend
    // Being replaced — release warm sockets (the Swift thermal-audit rule).
    this.backend?.teardown?.()
    this.backendSig = sig
    this.backend = this.buildBackend(kind)
    return this.backend
  }

  private systemBackend(): SystemTTSBackend {
    if (!this.sysTts) this.sysTts = new SystemTTSBackend(this.ttsCb)
    return this.sysTts
  }

  private buildBackend(kind: string): TTSBackend {
    const s = this.deps.settings
    const str = (k: string): string => String(s.get(k) ?? '').trim()
    const sys = this.systemBackend()
    const base = { cb: this.ttsCb, sink: this.sink }
    switch (kind) {
      case 'system':
      case 'apple': // legacy settings value from the Swift app
        return sys
      case 'google': {
        if (!str('googleAPIKey')) {
          console.warn('[voice] google TTS selected but no key — using system voice')
          return sys
        }
        return new GoogleTTSBackend({
          ...base,
          getKey: () => str('googleAPIKey'),
          getVoice: () => str('googleVoiceID') || GOOGLE_DEFAULT_VOICE,
          fallback: sys
        })
      }
      case 'openai': {
        if (!str('openaiAPIKey')) {
          console.warn('[voice] openai TTS selected but no key — using system voice')
          return sys
        }
        return new OpenAITTSBackend({
          ...base,
          getKey: () => str('openaiAPIKey'),
          getVoice: () => str('openaiVoiceID') || OPENAI_DEFAULT_VOICE,
          getSpeed: () => this.openaiSpeed(),
          fallback: sys
        })
      }
      case 'cartesia': {
        if (!str('cartesiaAPIKey')) {
          console.warn('[voice] cartesia TTS selected but no key — using system voice')
          return sys
        }
        // Full Swift ladder: Cartesia → Edge → system.
        const edge = new EdgeTTSBackend({
          ...base,
          getVoice: () => str('edgeVoiceID') || EDGE_DEFAULT_VOICE,
          fallback: sys
        })
        return new CartesiaTTSBackend({
          ...base,
          getKey: () => str('cartesiaAPIKey'),
          getPinnedVoice: () => str('cartesiaVoiceID'),
          fallback: edge
        })
      }
      default:
        // 'edge' — the shipping default, no key needed.
        return new EdgeTTSBackend({
          ...base,
          getVoice: () => str('edgeVoiceID') || EDGE_DEFAULT_VOICE,
          fallback: sys
        })
    }
  }

  /// env OPENAI_TTS_SPEED → settings openaiSpeed, clamped to 0.6…1.8
  /// (OpenAITTSConfig.speed twin — client-side, pitch rides along in the
  /// Web Audio playbackRate unlike AVAudioUnitTimePitch).
  private openaiSpeed(): number {
    const env = Number(process.env.OPENAI_TTS_SPEED?.trim())
    const setting = Number(this.deps.settings.get('openaiSpeed'))
    let v = Number.isFinite(env) && env > 0 ? env : setting
    if (!Number.isFinite(v) || v <= 0) v = 1.1
    const [lo, hi] = OPENAI_SPEED_RANGE
    return Math.min(Math.max(v, lo), hi)
  }
}
