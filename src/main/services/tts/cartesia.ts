import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { AudioSink, TTSBackend, TTSCallbacks, Utterance } from './types'

// Port of CartesiaTTSClient.swift — Cartesia Sonic over a persistent
// WebSocket, streaming pcm_f32le 44.1kHz mono. One generation at a time
// (the UtteranceController feeds serially → concurrency 1, free-tier safe).
//
// Fallback ladder preserved from Swift: Cartesia → Edge → system; the
// facade wires an EdgeTTSBackend (which itself falls back to system) in as
// `fallback`, so one hop here yields the full premium→free→offline chain.

export const CARTESIA_VERSION = '2026-03-01'
export const CARTESIA_SAMPLE_RATE = 44100

function cartesiaModel(): string {
  return process.env.CARTESIA_MODEL?.trim() || 'sonic-3'
}

interface Generation {
  token: number
  u: Utterance
  contextID: string
  started: boolean
  streamDone: boolean
  endSent: boolean
  finished: boolean
}

export interface CartesiaTTSOptions {
  cb: TTSCallbacks
  sink: AudioSink
  getKey: () => string
  /** Pinned voice id (settings/env); empty → resolve from /voices at first use. */
  getPinnedVoice: () => string
  fallback?: TTSBackend
}

export class CartesiaTTSBackend implements TTSBackend {
  private cb: TTSCallbacks
  private sink: AudioSink
  private getKey: () => string
  private getPinnedVoice: () => string
  private fallback: TTSBackend | null
  private fallbackActiveFor: string | null = null

  private ws: WebSocket | null = null
  private wsOpen = false
  private outbox: string[] = []

  private voiceID: string | null = null
  private voiceResolve: Promise<void> | null = null

  private current: Generation | null = null
  private tokenSeq = 0
  private sessionChars = 0

  constructor(opts: CartesiaTTSOptions) {
    this.cb = opts.cb
    this.sink = opts.sink
    this.getKey = opts.getKey
    this.getPinnedVoice = opts.getPinnedVoice
    this.fallback = opts.fallback ?? null
    // Kick off voice resolution + socket warmup so the first real utterance
    // doesn't pay for either.
    void this.resolveVoiceIfNeeded().then(() => this.connectIfNeeded())
  }

  play(u: Utterance): void {
    this.fallbackActiveFor = null
    if (!this.getKey()) {
      this.speakViaFallback(u, 'no_key')
      return
    }
    this.tokenSeq++
    const gen: Generation = {
      token: this.tokenSeq,
      u,
      contextID: randomUUID(),
      started: false,
      streamDone: false,
      endSent: false,
      finished: false
    }
    this.current = gen
    void this.begin(gen)
  }

  stopAll(): void {
    const gen = this.current
    if (gen && !gen.finished) {
      gen.finished = true
      // Tell Cartesia to stop billing/streaming this context.
      this.sendJson({ context_id: gen.contextID, cancel: true })
    }
    this.current = null
    this.sink.stop()
    if (this.fallbackActiveFor !== null) {
      this.fallback?.stopAll()
      this.fallbackActiveFor = null
    }
  }

  teardown(): void {
    this.stopAll()
    this.dropSocket()
    this.fallback?.teardown?.()
  }

  handleAudioDone(id: string): void {
    if (this.fallbackActiveFor !== null) this.fallback?.handleAudioDone(id)
    const gen = this.current
    if (gen && gen.u.id === id && gen.streamDone && !gen.finished) {
      gen.finished = true
      this.current = null
      this.cb.onFinish(id, false)
    }
  }

  // MARK: - Generation

  private async begin(gen: Generation): Promise<void> {
    await this.resolveVoiceIfNeeded()
    if (this.current !== gen || gen.finished) return
    if (!this.voiceID) {
      this.speakViaFallback(gen.u, 'voice_unresolved')
      return
    }
    this.connectIfNeeded()
    if (!this.ws) {
      this.speakViaFallback(gen.u, 'socket_unavailable')
      return
    }
    this.sessionChars += gen.u.spokenText.length
    this.sendJson({
      model_id: cartesiaModel(),
      transcript: gen.u.spokenText,
      voice: { mode: 'id', id: this.voiceID },
      output_format: {
        container: 'raw',
        encoding: 'pcm_f32le',
        sample_rate: CARTESIA_SAMPLE_RATE
      },
      language: 'en',
      context_id: gen.contextID,
      add_timestamps: true,
      continue: false
    })
  }

  // MARK: - WebSocket

  private connectIfNeeded(): void {
    if (this.ws) return
    const key = this.getKey()
    if (!key) return
    let ws: WebSocket
    try {
      ws = new WebSocket(
        `wss://api.cartesia.ai/tts/websocket?cartesia_version=${CARTESIA_VERSION}`,
        { headers: { 'X-API-Key': key } }
      )
    } catch (err) {
      console.error('[tts.cartesia] socket create failed', err)
      return
    }
    this.ws = ws
    this.wsOpen = false

    ws.on('open', () => {
      if (this.ws !== ws) return
      this.wsOpen = true
      const queued = this.outbox
      this.outbox = []
      for (const s of queued) ws.send(s)
    })
    ws.on('message', (data) => {
      if (this.ws !== ws) return
      this.handleMessage(data)
    })
    const down = (): void => {
      if (this.ws !== ws) return
      const gen = this.current
      if (gen && !gen.started && !gen.finished) this.speakViaFallback(gen.u, 'socket_closed')
      this.dropSocket()
    }
    ws.on('close', down)
    ws.on('error', down)
  }

  private dropSocket(): void {
    const ws = this.ws
    this.ws = null
    this.wsOpen = false
    this.outbox = []
    if (ws) {
      ws.removeAllListeners()
      try {
        ws.close()
      } catch {
        /* already closed */
      }
    }
  }

  private sendJson(payload: Record<string, unknown>): void {
    const s = JSON.stringify(payload)
    if (this.ws && this.wsOpen && this.ws.readyState === WebSocket.OPEN) this.ws.send(s)
    else if (this.ws) this.outbox.push(s)
  }

  private handleMessage(data: WebSocket.RawData): void {
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(
        (Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)).toString('utf8')
      ) as Record<string, unknown>
    } catch {
      return
    }
    const type = typeof obj.type === 'string' ? obj.type : ''
    const ctx = typeof obj.context_id === 'string' ? obj.context_id : ''
    const gen = this.current
    if (!gen || gen.contextID !== ctx || gen.finished) return

    switch (type) {
      case 'chunk': {
        if (typeof obj.data !== 'string' || !obj.data) return
        if (!gen.started) {
          gen.started = true
          this.cb.onStart(gen.u.id)
        }
        this.sink.play(gen.u.id, obj.data, 'pcm_f32', CARTESIA_SAMPLE_RATE)
        break
      }
      case 'timestamps':
        break // word timestamps — unused (no karaoke renderer in Electron)
      case 'done': {
        if (gen.endSent) return
        gen.streamDone = true
        gen.endSent = true
        this.sink.end(gen.u.id)
        break
      }
      case 'error': {
        const code = typeof obj.error_code === 'string' ? obj.error_code : 'unknown'
        const msg = typeof obj.message === 'string' ? obj.message : ''
        console.error(`[tts.cartesia] error [${code}] ${msg.slice(0, 120)} (model=${cartesiaModel()})`)
        if (!gen.started) {
          this.speakViaFallback(gen.u, 'cartesia_error')
        } else {
          // Mid-stream failure — close out so the controller advances.
          gen.finished = true
          this.current = null
          this.sink.end(gen.u.id)
          this.cb.onFinish(gen.u.id, false)
        }
        break
      }
      default:
        break
    }
  }

  // MARK: - Voice resolution

  private resolveVoiceIfNeeded(): Promise<void> {
    if (this.voiceID) return Promise.resolve()
    const pinned = this.getPinnedVoice().trim() || process.env.CARTESIA_VOICE_ID?.trim() || ''
    if (pinned) {
      this.voiceID = pinned
      return Promise.resolve()
    }
    if (this.voiceResolve) return this.voiceResolve
    this.voiceResolve = (async () => {
      try {
        const resp = await fetch('https://api.cartesia.ai/voices?limit=100', {
          headers: { 'X-API-Key': this.getKey(), 'Cartesia-Version': CARTESIA_VERSION },
          signal: AbortSignal.timeout(10000)
        })
        if (!resp.ok) {
          console.warn(`[tts.cartesia] /voices ${resp.status}; set a voice id in settings`)
          return
        }
        const parsed: unknown = await resp.json()
        // /voices may return a bare array or a paginated {data:[...]}.
        let list: Array<Record<string, unknown>> = []
        if (Array.isArray(parsed)) list = parsed as Array<Record<string, unknown>>
        else if (parsed && typeof parsed === 'object') {
          const d = (parsed as Record<string, unknown>).data
          if (Array.isArray(d)) list = d as Array<Record<string, unknown>>
        }
        const english =
          list.find((v) => String(v.language ?? '').toLowerCase().startsWith('en')) ?? list[0]
        if (english && typeof english.id === 'string') {
          this.voiceID = english.id
          console.log(
            `[tts.cartesia] voice resolved → ${String(english.name ?? '?')} [${english.id}]`
          )
        } else {
          console.warn('[tts.cartesia] /voices returned no usable voice')
        }
      } catch (err) {
        console.warn('[tts.cartesia] /voices lookup failed', err)
      } finally {
        this.voiceResolve = null
      }
    })()
    return this.voiceResolve
  }

  private speakViaFallback(u: Utterance, reason: string): void {
    if (this.fallbackActiveFor === u.id) return
    if (this.current?.u.id === u.id) this.current = null
    console.warn(`[tts.cartesia] fallback (${reason}) for ${u.id.slice(0, 8)}`)
    if (!this.fallback) {
      this.cb.onFinish(u.id, false)
      return
    }
    this.fallbackActiveFor = u.id
    this.fallback.play(u)
  }
}
