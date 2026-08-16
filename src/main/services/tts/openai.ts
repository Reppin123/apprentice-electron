import WebSocket from 'ws'
import { AudioSink, TTSBackend, TTSCallbacks, Utterance } from './types'

// Port of OpenAITTSClient.swift + OpenAITTSConfig.swift — the OpenAI
// **Realtime API** used as a streaming text→speech engine. Claude stays the
// brain; each utterance is sent over a persistent WebSocket and the model
// speaks it back as streamed pcm16 (24kHz mono).
//
// Protocol (GA, model gpt-realtime-2):
//   connect  wss://api.openai.com/v1/realtime?model=…  Authorization: Bearer
//   →        session.update { session.audio.output.{voice,format}, instructions }
//   speak    conversation.item.create (input_text) → response.create
//   ←        response.output_audio.delta (base64 pcm16 24k mono) … response.done
//   cancel   response.cancel
//
// Playback speed is CLIENT-side (the Realtime API has no speed param) — it
// rides each audio_play frame and audio.html applies it as playbackRate.

export const OPENAI_PCM_RATE = 24000
export const OPENAI_DEFAULT_VOICE = 'marin'
export const OPENAI_SPEED_RANGE: [number, number] = [0.6, 1.8]

function modelID(): string {
  const m = process.env.OPENAI_REALTIME_MODEL?.trim()
  return m || 'gpt-realtime-2'
}

// OpenAITTSConfig.defaultInstructions, verbatim (paragraph joins resolved).
const DEFAULT_INSTRUCTIONS =
  'You are the voice of Apprentice — a text-to-speech narrator, not a ' +
  "conversational assistant. Speak the user's message aloud EXACTLY as " +
  'written, word for word. Never answer it, react to it, summarize, ' +
  'translate, greet, or add anything that is not in the text. Say only the ' +
  'words given.\n\n' +
  'Render the text the way a thoughtful person would read it aloud: speak ' +
  'numbers, currency, dates, times, units, and abbreviations in natural ' +
  'spoken form; do not pronounce markdown or formatting characters ' +
  '(asterisks, underscores, backticks, hashes, dashes) or raw URLs — convey ' +
  "their meaning or skip them. Let the wording's own punctuation and meaning " +
  'shape your intonation and emotion.\n\n' +
  'Voice: warm, clear, and natural — a trusted colleague. Confident but ' +
  'never cold; expressive but never theatrical or robotic.'

function instructions(): string {
  const env = process.env.OPENAI_TTS_INSTRUCTIONS?.trim()
  return env || DEFAULT_INSTRUCTIONS
}

interface Generation {
  token: number
  u: Utterance
  speed: number
  started: boolean
  streamDone: boolean
  endSent: boolean
  finished: boolean
}

export interface OpenAITTSOptions {
  cb: TTSCallbacks
  sink: AudioSink
  getKey: () => string
  getVoice: () => string
  getSpeed: () => number
  fallback?: TTSBackend
}

export class OpenAITTSBackend implements TTSBackend {
  private cb: TTSCallbacks
  private sink: AudioSink
  private getKey: () => string
  private getVoice: () => string
  private getSpeed: () => number
  private fallback: TTSBackend | null
  private fallbackActiveFor: string | null = null

  private ws: WebSocket | null = null
  private wsOpen = false
  private outbox: string[] = []

  private current: Generation | null = null
  private tokenSeq = 0

  constructor(opts: OpenAITTSOptions) {
    this.cb = opts.cb
    this.sink = opts.sink
    this.getKey = opts.getKey
    this.getVoice = opts.getVoice
    this.getSpeed = opts.getSpeed
    this.fallback = opts.fallback ?? null
    // Warm the socket so the first real utterance doesn't pay connect cost.
    this.connectIfNeeded()
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
      speed: this.getSpeed(),
      started: false,
      streamDone: false,
      endSent: false,
      finished: false
    }
    this.current = gen
    this.connectIfNeeded()
    if (!this.ws) {
      this.speakViaFallback(u, 'socket_unavailable')
      return
    }
    // Ask the realtime model to speak this exact text.
    this.sendJson({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: u.spokenText }]
      }
    })
    this.sendJson({ type: 'response.create' })
  }

  stopAll(): void {
    if (this.current && !this.current.finished) {
      this.current.finished = true
      // Tell the model to stop generating this response.
      this.sendJson({ type: 'response.cancel' })
    }
    this.current = null
    this.sink.stop()
    if (this.fallbackActiveFor !== null) {
      this.fallback?.stopAll()
      this.fallbackActiveFor = null
    }
  }

  teardown(): void {
    // Being replaced (backend switch) — release the warm socket.
    this.stopAll()
    this.dropSocket()
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

  // MARK: - WebSocket lifecycle

  private connectIfNeeded(): void {
    if (this.ws) return
    const key = this.getKey()
    if (!key) return
    let ws: WebSocket
    try {
      ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${modelID()}`, {
        headers: { Authorization: `Bearer ${key}` }
      })
    } catch (err) {
      console.error('[tts.openai] socket create failed', err)
      return
    }
    this.ws = ws
    this.wsOpen = false

    ws.on('open', () => {
      if (this.ws !== ws) return
      this.wsOpen = true
      // session.update FIRST: verbatim instructions + voice + pcm16 out.
      const cfg = JSON.stringify({
        type: 'session.update',
        session: {
          type: 'realtime',
          instructions: instructions(),
          audio: {
            output: {
              voice: this.getVoice().trim() || OPENAI_DEFAULT_VOICE,
              format: { type: 'audio/pcm', rate: OPENAI_PCM_RATE }
            }
          }
        }
      })
      ws.send(cfg)
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
    else if (this.ws) this.outbox.push(s) // flushed after session.update on open
  }

  // MARK: - Server events

  private handleMessage(data: WebSocket.RawData): void {
    let event: Record<string, unknown>
    try {
      event = JSON.parse(
        (Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)).toString('utf8')
      ) as Record<string, unknown>
    } catch {
      return
    }
    const type = typeof event.type === 'string' ? event.type : ''

    switch (type) {
      case 'response.output_audio.delta':
      case 'response.audio.delta': {
        const gen = this.current
        if (!gen || gen.finished || typeof event.delta !== 'string') return
        if (!gen.started) {
          gen.started = true
          this.cb.onStart(gen.u.id)
        }
        this.sink.play(gen.u.id, event.delta, 'pcm16', OPENAI_PCM_RATE, gen.speed)
        break
      }
      case 'response.done':
      case 'response.output_audio.done': {
        const gen = this.current
        if (!gen || gen.finished || gen.endSent) return
        gen.streamDone = true
        gen.endSent = true
        this.sink.end(gen.u.id) // audio_done from the page closes it out
        break
      }
      case 'error': {
        const err = event.error as Record<string, unknown> | undefined
        const msg = typeof err?.message === 'string' ? err.message : 'unknown'
        console.error('[tts.openai] realtime error —', msg)
        const gen = this.current
        if (gen && !gen.finished) {
          if (!gen.started) this.speakViaFallback(gen.u, 'realtime_error')
          else {
            gen.finished = true
            this.current = null
            this.sink.end(gen.u.id)
            this.cb.onFinish(gen.u.id, false)
          }
        }
        break
      }
      default:
        break // session.created/updated, response.created, transcript deltas…
    }
  }

  private speakViaFallback(u: Utterance, reason: string): void {
    if (this.fallbackActiveFor === u.id) return
    if (this.current?.u.id === u.id) this.current = null
    console.warn(`[tts.openai] fallback (${reason}) for ${u.id.slice(0, 8)}`)
    if (!this.fallback) {
      this.cb.onFinish(u.id, false)
      return
    }
    this.fallbackActiveFor = u.id
    this.fallback.play(u)
  }
}
