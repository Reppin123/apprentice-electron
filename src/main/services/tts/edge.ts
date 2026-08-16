import { createHash, randomBytes, randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { AudioSink, TTSBackend, TTSCallbacks, Utterance, xmlEscape } from './types'

// Port of EdgeTTSClient.swift + EdgeTTSConfig.swift — Microsoft Edge neural
// TTS over WebSocket (speech.platform.bing.com) with Sec-MS-GEC DRM auth.
// Batch approach: collect all MP3 chunks for an utterance, then hand the
// whole file to the audio page. Prefetch caches (id-keyed + text-keyed)
// eliminate the ~500-800ms network gap between consecutive utterances.

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'
const GEC_VERSION = '1-143.0.3650.75'
const WSS_BASE =
  'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1' +
  `?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}`
export const EDGE_DEFAULT_VOICE = 'en-US-AvaNeural'
const FETCH_TIMEOUT_MS = 15000

/// SHA256( roundedWindowsTicks + trustedClientToken ), uppercased hex.
/// Rounds the current time down to the nearest 5-minute boundary in Windows
/// file time (100-ns ticks since 1601-01-01 UTC). BigInt keeps the tick
/// count exact — the value exceeds 2^53 and Number.toString would drift.
function generateSecMsGec(): string {
  const WIN_EPOCH_S = 11_644_473_600n // seconds from 1601 to 1970
  let s = BigInt(Math.floor(Date.now() / 1000)) + WIN_EPOCH_S
  s -= s % 300n // round to 5-min boundary
  const ticks = s * 10_000_000n // 100-ns ticks
  return createHash('sha256')
    .update(`${ticks}${TRUSTED_CLIENT_TOKEN}`)
    .digest('hex')
    .toUpperCase()
}

/// Full WSS URL including ConnectionId, Sec-MS-GEC, Sec-MS-GEC-Version.
function wssURL(connectionID: string): string {
  return (
    `${WSS_BASE}&ConnectionId=${connectionID}` +
    `&Sec-MS-GEC=${generateSecMsGec()}&Sec-MS-GEC-Version=${GEC_VERSION}`
  )
}

/// Random 32-char uppercase hex for the muid cookie.
function generateMUID(): string {
  return randomBytes(16).toString('hex').toUpperCase()
}

/// Headers required for the WebSocket upgrade (matches edge-tts WSS_HEADERS).
function wssHeaders(): Record<string, string> {
  return {
    Pragma: 'no-cache',
    'Cache-Control': 'no-cache',
    Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' +
      ' (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
    'Accept-Encoding': 'gzip, deflate, br',
    'Accept-Language': 'en-US,en;q=0.9',
    Cookie: `muid=${generateMUID()};`
  }
}

function toBuffer(d: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(d)) return d
  if (Array.isArray(d)) return Buffer.concat(d)
  return Buffer.from(d)
}

interface FetchResult {
  mp3: Buffer
  voiceID: string
}

interface Generation {
  token: number
  u: Utterance
  voiceID: string
  finished: boolean
}

export interface EdgeTTSOptions {
  cb: TTSCallbacks
  sink: AudioSink
  getVoice: () => string
  fallback?: TTSBackend
}

export class EdgeTTSBackend implements TTSBackend {
  private cb: TTSCallbacks
  private sink: AudioSink
  private getVoice: () => string
  private fallback: TTSBackend | null
  private fallbackActiveFor: string | null = null

  private current: Generation | null = null
  private tokenSeq = 0
  private epoch = 0 // bumped on stopAll so in-flight prefetches drop their result

  private prefetchCache = new Map<string, FetchResult>() // by utterance id
  private textCache = new Map<string, FetchResult>() // by "voice|text"
  private inflight = new Map<string, Promise<FetchResult | null>>()

  constructor(opts: EdgeTTSOptions) {
    this.cb = opts.cb
    this.sink = opts.sink
    this.getVoice = opts.getVoice
    this.fallback = opts.fallback ?? null
  }

  private voice(): string {
    return this.getVoice().trim() || EDGE_DEFAULT_VOICE
  }

  private static textKey(text: string, voiceID: string): string {
    return `${voiceID}|${text.trim()}`
  }

  play(u: Utterance): void {
    this.fallbackActiveFor = null
    this.tokenSeq++
    const gen: Generation = { token: this.tokenSeq, u, voiceID: this.voice(), finished: false }
    this.current = gen
    void this.begin(gen)
  }

  stopAll(): void {
    if (this.current) this.current.finished = true
    this.current = null
    this.sink.stop()
    this.epoch++
    this.prefetchCache.clear()
    this.textCache.clear()
    this.inflight.clear()
    if (this.fallbackActiveFor !== null) {
      this.fallback?.stopAll()
      this.fallbackActiveFor = null
    }
  }

  prefetch(u: Utterance): void {
    if (this.prefetchCache.has(u.id) || this.inflight.has(u.id)) return
    const voiceID = this.voice()
    const ep = this.epoch
    const p = this.fetchAudio(u.spokenText, voiceID).then((result) => {
      this.inflight.delete(u.id)
      if (result && ep === this.epoch) {
        this.prefetchCache.set(u.id, result)
        this.textCache.set(EdgeTTSBackend.textKey(u.spokenText, voiceID), result)
      }
      return result
    })
    this.inflight.set(u.id, p)
  }

  handleAudioDone(id: string): void {
    if (this.fallbackActiveFor !== null) this.fallback?.handleAudioDone(id)
    const gen = this.current
    if (gen && gen.u.id === id && !gen.finished) {
      gen.finished = true
      this.current = null
      this.cb.onFinish(id, false)
    }
  }

  private takeCached(gen: Generation): FetchResult | null {
    const byId = this.prefetchCache.get(gen.u.id)
    if (byId) {
      this.prefetchCache.delete(gen.u.id)
      if (byId.voiceID === gen.voiceID) return byId
    }
    const key = EdgeTTSBackend.textKey(gen.u.spokenText, gen.voiceID)
    const byText = this.textCache.get(key)
    if (byText) {
      this.textCache.delete(key)
      if (byText.voiceID === gen.voiceID) return byText
    }
    return null
  }

  private async begin(gen: Generation): Promise<void> {
    let result = this.takeCached(gen)
    if (!result) {
      const inflight = this.inflight.get(gen.u.id)
      if (inflight) {
        await inflight
        result = this.takeCached(gen)
      }
    }
    if (!result) result = await this.fetchAudio(gen.u.spokenText, gen.voiceID)
    if (this.current !== gen || gen.finished) return
    if (!result || result.mp3.length === 0) {
      this.speakViaFallback(gen.u, result ? 'no_audio' : 'fetch_failed')
      return
    }
    this.cb.onStart(gen.u.id)
    this.sink.play(gen.u.id, result.mp3.toString('base64'), 'mp3', 24000)
    this.sink.end(gen.u.id)
  }

  /// One WebSocket round-trip: speech.config → ssml → collect audio frames
  /// until turn.end. Binary frame layout: [2-byte BE header length][header
  /// text][audio bytes]; audio frames carry "Path:audio" in the header.
  private fetchAudio(text: string, voiceID: string): Promise<FetchResult | null> {
    return new Promise((resolve) => {
      const connID = randomUUID().replace(/-/g, '').toLowerCase()
      let ws: WebSocket
      try {
        ws = new WebSocket(wssURL(connID), { headers: wssHeaders() })
      } catch (err) {
        console.error('[tts.edge] socket create failed', err)
        resolve(null)
        return
      }
      const parts: Buffer[] = []
      let settled = false
      const settle = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try {
          ws.close()
        } catch {
          /* already closed */
        }
        resolve(parts.length ? { mp3: Buffer.concat(parts), voiceID } : null)
      }
      const timer = setTimeout(settle, FETCH_TIMEOUT_MS)

      ws.on('open', () => {
        const cfg = [
          `X-Timestamp:${new Date().toISOString()}`,
          'Content-Type:application/json; charset=utf-8',
          'Path:speech.config',
          '',
          '{"context":{"synthesis":{"audio":{"metadataoptions":' +
            '{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"true"},' +
            '"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}'
        ].join('\r\n')
        ws.send(cfg)

        const reqID = randomUUID().replace(/-/g, '').toLowerCase()
        const ssmlBody =
          "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' " +
          `xml:lang='en-US'><voice name='${voiceID}'>` +
          `<prosody pitch='+0Hz' rate='+0%' volume='+0%'>${xmlEscape(text)}` +
          '</prosody></voice></speak>'
        const ssmlMsg = [
          `X-RequestId:${reqID}`,
          'Content-Type:application/ssml+xml',
          `X-Timestamp:${new Date().toISOString()}`,
          'Path:ssml',
          '',
          ssmlBody
        ].join('\r\n')
        ws.send(ssmlMsg)
      })

      ws.on('message', (data, isBinary) => {
        const buf = toBuffer(data)
        if (isBinary) {
          if (buf.length <= 2) return
          const hLen = (buf[0] << 8) | buf[1]
          if (buf.length <= 2 + hLen) return
          const header = buf.subarray(2, 2 + hLen).toString('utf8')
          if (!header.includes('Path:audio')) return
          const payload = buf.subarray(2 + hLen)
          if (payload.length) parts.push(Buffer.from(payload))
          return
        }
        const msg = buf.toString('utf8')
        // (audio.metadata word boundaries arrive here too — unused: the
        // Electron surfaces render the full bubble text, no karaoke.)
        if (msg.includes('Path:turn.end')) settle()
      })

      ws.on('error', settle)
      ws.on('close', settle)
    })
  }

  private speakViaFallback(u: Utterance, reason: string): void {
    if (this.fallbackActiveFor === u.id) return
    if (this.current?.u.id === u.id) this.current = null
    console.warn(`[tts.edge] fallback (${reason}) for ${u.id.slice(0, 8)}`)
    if (!this.fallback) {
      this.cb.onFinish(u.id, false) // keep the queue advancing
      return
    }
    this.fallbackActiveFor = u.id
    this.fallback.play(u)
  }
}
