import { randomUUID } from 'node:crypto'

// Shared contracts for the voice layer — the TypeScript twin of the Swift
// TTSPlayback protocol (AppleSpeechTTSClient.swift).
//
// Correlation model (ported 1:1): a backend receives whole Utterances and
// fires onStart / onFinish tagged with the utterance id. Audio is NOT played
// in the main process — backends hand chunks to an AudioSink which the facade
// routes to the hidden audio.html page; the page reports playback completion
// back as ui_action {action:'audio_done', value:id}, which the facade feeds
// to TTSBackend.handleAudioDone().

export interface WordSpan {
  start: number // UTF-16 code-unit offset into spokenText (the NSRange twin)
  length: number
  text: string
}

export interface Utterance {
  id: string
  spokenText: string
  displayOverride?: string
  wordSpans: WordSpan[]
}

/** Utterance.tokenize port: maximal runs of non-whitespace. */
export function tokenize(text: string): WordSpan[] {
  const spans: WordSpan[] = []
  const re = /\S+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    spans.push({ start: m.index, length: m[0].length, text: m[0] })
  }
  return spans
}

export function makeUtterance(spokenText: string, displayOverride?: string): Utterance {
  const trimmed = spokenText.trim()
  const override = displayOverride?.trim()
  return {
    id: randomUUID(),
    spokenText: trimmed,
    displayOverride: override || undefined,
    wordSpans: tokenize(trimmed)
  }
}

export function xmlEscape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export interface TTSCallbacks {
  /** Audio for this utterance was handed to the player (twin of didStartUtterance). */
  onStart(id: string): void
  /** The utterance finished playing out (twin of didFinishUtterance). */
  onFinish(id: string, cancelled: boolean): void
}

export type AudioFormat = 'mp3' | 'pcm16' | 'pcm_f32'

/** How a backend delivers audio to the hidden audio.html page. */
export interface AudioSink {
  play(id: string, chunkB64: string, format: AudioFormat, rate: number, speed?: number): void
  end(id: string): void
  stop(): void
}

export interface TTSBackend {
  play(u: Utterance): void
  /** Drop the in-flight utterance + caches. Emits NO events (the controller
   *  clears its own state — same contract as the Swift clients). */
  stopAll(): void
  /** Warm the audio cache for a queued utterance (batch backends opt in). */
  prefetch?(u: Utterance): void
  /** Release warm sockets when the backend is being replaced. */
  teardown?(): void
  /** audio.html reported this utterance finished playing (audio_done). */
  handleAudioDone(id: string): void
}
