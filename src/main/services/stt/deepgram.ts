import WebSocket from 'ws'
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

// Deepgram Nova-3 streaming STT for push-to-talk / dictation. Talks the wire
// protocol directly (same as the Python agent's calls/deepgram.py — no SDK):
//   • connect:   wss://api.deepgram.com/v1/listen?<params>
//                Authorization: "Token <key>" (dev) or "Bearer <jwt>" (minted)
//   • send:      binary frames of linear16 PCM (16kHz mono)
//   • keepalive: {"type":"KeepAlive"} during silence
//   • finish:    {"type":"CloseStream"} flushes + closes gracefully
//   • results:   {"type":"Results", channel:{alternatives:[{transcript}]},
//                 is_final, speech_final}
//
// Credentials — the SAME ladder as the agent (calls/config.py) plus the
// shipped app's default: DEEPGRAM_API_KEY env → ~/.config/apprentice/
// deepgram.key (first non-empty line) → DEEPGRAM_TOKEN_URL env → the
// production token worker AgentProcessManager.swift:377 injects — a
// Cloudflare Worker that mints short-lived grant tokens (the real key never
// reaches the device). The worker answers POST (see calls/config.py); we try
// POST then GET and inspect the JSON defensively for the token field.

const ENDPOINT = 'wss://api.deepgram.com/v1/listen'
// The keyless production path every install gets (mirrors the Swift shell's
// isolated-track default).
const DEFAULT_TOKEN_URL = 'https://apprentice-deepgram-token.akshitbansal1313.workers.dev'

function keyFileKey(): string {
  try {
    const p = join(homedir(), '.config', 'apprentice', 'deepgram.key')
    if (!existsSync(p)) return ''
    const first = readFileSync(p, 'utf-8')
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0)
    return first || ''
  } catch {
    return ''
  }
}
const KEEPALIVE_MS = 5000
/// BuddyDictationManager.defaultFinalTranscriptFallbackDelaySeconds — how
/// long finish() waits for the flushed finals before giving up.
const FINAL_FALLBACK_MS = 2400

function pickToken(obj: unknown): string {
  if (!obj || typeof obj !== 'object') return ''
  const o = obj as Record<string, unknown>
  for (const k of ['access_token', 'token', 'key', 'jwt', 'api_key']) {
    const v = o[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  for (const nest of ['data', 'result']) {
    const t = pickToken(o[nest])
    if (t) return t
  }
  return ''
}

/// (auth scheme, value): "Token <key>" from env, else "Bearer <jwt>" minted
/// by the token endpoint. null → transcription unavailable.
async function resolveAuth(): Promise<[string, string] | null> {
  const key = process.env.DEEPGRAM_API_KEY?.trim() || keyFileKey()
  if (key) return ['Token', key]
  const url = process.env.DEEPGRAM_TOKEN_URL?.trim() || DEFAULT_TOKEN_URL
  for (const method of ['POST', 'GET'] as const) {
    try {
      const resp = await fetch(url, { method, signal: AbortSignal.timeout(10000) })
      if (!resp.ok) continue
      const token = pickToken(await resp.json())
      if (token) return ['Bearer', token]
    } catch {
      /* try the next method */
    }
  }
  console.warn('[stt] deepgram token endpoint yielded no token')
  return null
}

function toBuffer(d: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(d)) return d
  if (Array.isArray(d)) return Buffer.concat(d)
  return Buffer.from(d)
}

export class DeepgramSTT {
  private ws: WebSocket | null = null
  private open = false
  private closed = false
  private pending: Buffer[] = [] // PCM buffered while connecting
  private finals: string[] = []
  private interim = ''
  private keepalive: NodeJS.Timeout | null = null
  private closeWaiters: Array<() => void> = []
  private openWaiters: Array<() => void> = []
  private onInterim?: (text: string) => void

  constructor(opts?: { onInterim?: (text: string) => void }) {
    this.onInterim = opts?.onInterim
  }

  /** Any credential source configured? (Gate before capturing.) The default
   *  token worker means this is effectively always true; a worker outage
   *  surfaces as a start() failure, not a silent no-capture. */
  static hasCredentials(): boolean {
    return true
  }

  async start(): Promise<void> {
    const auth = await resolveAuth()
    if (!auth) throw new Error('deepgram: no usable credentials')
    if (this.closed) return

    const params = new URLSearchParams({
      model: 'nova-3',
      language: 'en',
      encoding: 'linear16',
      sample_rate: '16000',
      channels: '1',
      interim_results: 'true',
      punctuate: 'true',
      smart_format: 'true'
    })
    const ws = new WebSocket(`${ENDPOINT}?${params.toString()}`, {
      headers: { Authorization: `${auth[0]} ${auth[1]}` }
    })
    this.ws = ws

    ws.on('open', () => {
      if (this.ws !== ws) return
      this.open = true
      for (const b of this.pending) ws.send(b)
      this.pending = []
      const waiters = this.openWaiters
      this.openWaiters = []
      for (const w of waiters) w()
      this.keepalive = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send('{"type":"KeepAlive"}')
      }, KEEPALIVE_MS)
    })
    ws.on('message', (data) => this.handleMessage(data))
    const down = (): void => {
      if (this.ws !== ws) return
      this.open = false
      if (this.keepalive) {
        clearInterval(this.keepalive)
        this.keepalive = null
      }
      const waiters = [...this.openWaiters, ...this.closeWaiters]
      this.openWaiters = []
      this.closeWaiters = []
      for (const w of waiters) w()
    }
    ws.on('close', down)
    ws.on('error', (err) => {
      console.warn('[stt] deepgram socket error', err)
      down()
    })
  }

  sendPcm(pcm: Buffer): void {
    if (this.closed || pcm.length === 0) return
    if (this.ws && this.open && this.ws.readyState === WebSocket.OPEN) this.ws.send(pcm)
    else this.pending.push(pcm)
  }

  /** The composed transcript so far: finalized segments + live interim. */
  transcript(): string {
    return [...this.finals, this.interim].join(' ').replace(/\s+/g, ' ').trim()
  }

  /** Flush (CloseStream), wait for the tail finals (2.4s cap), return text. */
  async finish(): Promise<string> {
    // A short PTT press can release before the socket (token mint + connect)
    // is up — wait briefly for open so the buffered PCM still gets flushed.
    if (this.ws && !this.open && !this.closed) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1500)
        this.openWaiters.push(() => {
          clearTimeout(timer)
          resolve()
        })
        this.closeWaiters.push(() => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
    if (this.ws && this.open && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send('{"type":"CloseStream"}')
      } catch {
        /* socket already down — fall through to the timer */
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, FINAL_FALLBACK_MS)
        this.closeWaiters.push(() => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
    this.cancel()
    return this.transcript()
  }

  cancel(): void {
    this.closed = true
    if (this.keepalive) {
      clearInterval(this.keepalive)
      this.keepalive = null
    }
    const ws = this.ws
    this.ws = null
    if (ws) {
      ws.removeAllListeners()
      try {
        ws.close()
      } catch {
        /* already closed */
      }
    }
    const waiters = [...this.openWaiters, ...this.closeWaiters]
    this.openWaiters = []
    this.closeWaiters = []
    for (const w of waiters) w()
  }

  private handleMessage(data: WebSocket.RawData): void {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(toBuffer(data).toString('utf8')) as Record<string, unknown>
    } catch {
      return
    }
    if (msg.type !== 'Results') return
    const channel = msg.channel as
      | { alternatives?: Array<{ transcript?: string }> }
      | undefined
    const text = channel?.alternatives?.[0]?.transcript ?? ''
    if (msg.is_final === true) {
      if (text.trim()) this.finals.push(text.trim())
      this.interim = ''
    } else {
      this.interim = text
    }
    this.onInterim?.(this.transcript())
  }
}
