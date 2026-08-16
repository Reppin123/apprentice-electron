import { AudioSink, TTSBackend, TTSCallbacks, Utterance, xmlEscape } from './types'

// Port of GoogleTTSClient.swift + GoogleTTSConfig.swift — Google Cloud TTS
// Neural2/Journey over the REST synthesize endpoint. Batch: one HTTPS
// round-trip → base64 MP3 → hand the whole file to the audio page.
//
// SSML (<mark name="wN"/> before each word + enableTimePointing SSML_MARK) is
// sent ONLY for supportsSSML voices — Journey voices reject SSML with 400 and
// get plain text. The request shape is kept identical to the proven Swift
// client; the returned timepoints are unused here (no karaoke renderer).

export interface GoogleVoice {
  id: string
  label: string
  languageCode: string
  supportsSSML: boolean
}

export const GOOGLE_VOICES: GoogleVoice[] = [
  // English Neural2 — SSML + timepoints
  { id: 'en-US-Neural2-J', label: 'Neural2 J (EN) ★', languageCode: 'en-US', supportsSSML: true },
  { id: 'en-US-Neural2-F', label: 'Neural2 F (EN) ★', languageCode: 'en-US', supportsSSML: true },
  { id: 'en-US-Neural2-D', label: 'Neural2 D (EN) ★', languageCode: 'en-US', supportsSSML: true },
  { id: 'en-GB-Neural2-B', label: 'Neural2 B (UK) ★', languageCode: 'en-GB', supportsSSML: true },
  // English Journey — better prosody, plain text only
  { id: 'en-US-Journey-D', label: 'Journey D (EN)', languageCode: 'en-US', supportsSSML: false },
  { id: 'en-US-Journey-F', label: 'Journey F (EN)', languageCode: 'en-US', supportsSSML: false },
  // Hindi
  { id: 'hi-IN-Neural2-D', label: 'Neural2 D (HI) ★', languageCode: 'hi-IN', supportsSSML: true },
  { id: 'hi-IN-Neural2-A', label: 'Neural2 A (HI) ★', languageCode: 'hi-IN', supportsSSML: true },
  { id: 'hi-IN-Wavenet-D', label: 'WaveNet D (HI) ★', languageCode: 'hi-IN', supportsSSML: true },
  // Spanish / French / German
  { id: 'es-US-Neural2-B', label: 'Neural2 B (ES) ★', languageCode: 'es-US', supportsSSML: true },
  { id: 'fr-FR-Neural2-B', label: 'Neural2 B (FR) ★', languageCode: 'fr-FR', supportsSSML: true },
  { id: 'de-DE-Neural2-B', label: 'Neural2 B (DE) ★', languageCode: 'de-DE', supportsSSML: true }
]

export const GOOGLE_DEFAULT_VOICE = 'en-US-Neural2-J'

function resolveVoice(id: string): GoogleVoice {
  return GOOGLE_VOICES.find((v) => v.id === id) ?? GOOGLE_VOICES[0]
}

/// Injects <mark name="wN"/> before each whitespace-delimited token.
/// No xml:lang attribute — language comes from voice selection; including it
/// causes INVALID_ARGUMENT on some voice types.
function buildSSML(text: string): string {
  const inner = text
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map((w, i) => `<mark name="w${i}"/>${xmlEscape(w)}`)
    .join(' ')
  return `<speak>${inner}</speak>`
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

export interface GoogleTTSOptions {
  cb: TTSCallbacks
  sink: AudioSink
  getKey: () => string
  getVoice: () => string
  fallback?: TTSBackend
}

export class GoogleTTSBackend implements TTSBackend {
  private cb: TTSCallbacks
  private sink: AudioSink
  private getKey: () => string
  private getVoice: () => string
  private fallback: TTSBackend | null
  private fallbackActiveFor: string | null = null

  private current: Generation | null = null
  private tokenSeq = 0
  private epoch = 0

  private prefetchCache = new Map<string, FetchResult>()
  private inflight = new Map<string, Promise<FetchResult | null>>()

  constructor(opts: GoogleTTSOptions) {
    this.cb = opts.cb
    this.sink = opts.sink
    this.getKey = opts.getKey
    this.getVoice = opts.getVoice
    this.fallback = opts.fallback ?? null
  }

  private voice(): GoogleVoice {
    return resolveVoice(this.getVoice().trim() || GOOGLE_DEFAULT_VOICE)
  }

  play(u: Utterance): void {
    this.fallbackActiveFor = null
    this.tokenSeq++
    const gen: Generation = { token: this.tokenSeq, u, voiceID: this.voice().id, finished: false }
    this.current = gen
    void this.begin(gen)
  }

  stopAll(): void {
    if (this.current) this.current.finished = true
    this.current = null
    this.sink.stop()
    this.epoch++
    this.prefetchCache.clear()
    this.inflight.clear()
    if (this.fallbackActiveFor !== null) {
      this.fallback?.stopAll()
      this.fallbackActiveFor = null
    }
  }

  prefetch(u: Utterance): void {
    if (this.prefetchCache.has(u.id) || this.inflight.has(u.id)) return
    const voiceID = this.voice().id
    const ep = this.epoch
    const p = this.fetchAudio(u.spokenText, voiceID).then((result) => {
      this.inflight.delete(u.id)
      if (result && ep === this.epoch) this.prefetchCache.set(u.id, result)
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

  private async begin(gen: Generation): Promise<void> {
    let result: FetchResult | null = null
    const cached = this.prefetchCache.get(gen.u.id)
    if (cached) {
      this.prefetchCache.delete(gen.u.id)
      if (cached.voiceID === gen.voiceID) result = cached
    }
    if (!result) {
      const inflight = this.inflight.get(gen.u.id)
      if (inflight) {
        const r = await inflight
        if (r && r.voiceID === gen.voiceID) result = r
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

  private async fetchAudio(text: string, voiceID: string): Promise<FetchResult | null> {
    const key = this.getKey().trim()
    if (!key) return null
    const voice = resolveVoice(voiceID)

    const body: Record<string, unknown> = {
      voice: { languageCode: voice.languageCode, name: voice.id },
      audioConfig: { audioEncoding: 'MP3' }
    }
    if (voice.supportsSSML) {
      body.input = { ssml: buildSSML(text) }
      body.enableTimePointing = ['SSML_MARK']
    } else {
      body.input = { text }
    }

    try {
      const resp = await fetch(
        `https://texttospeech.googleapis.com/v1beta1/text:synthesize?key=${key}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15000)
        }
      )
      if (!resp.ok) {
        const preview = (await resp.text()).slice(0, 200)
        console.error(`[tts.google] API error ${resp.status}: ${preview}`)
        return null
      }
      const obj = (await resp.json()) as { audioContent?: string }
      if (typeof obj.audioContent !== 'string' || !obj.audioContent) return null
      return { mp3: Buffer.from(obj.audioContent, 'base64'), voiceID: voice.id }
    } catch (err) {
      console.error('[tts.google] fetch failed', err)
      return null
    }
  }

  private speakViaFallback(u: Utterance, reason: string): void {
    if (this.fallbackActiveFor === u.id) return
    if (this.current?.u.id === u.id) this.current = null
    console.warn(`[tts.google] fallback (${reason}) for ${u.id.slice(0, 8)}`)
    if (!this.fallback) {
      this.cb.onFinish(u.id, false)
      return
    }
    this.fallbackActiveFor = u.id
    this.fallback.play(u)
  }
}
