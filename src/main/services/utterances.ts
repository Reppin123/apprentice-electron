import { TTSBackend, Utterance, makeUtterance } from './tts/types'

// Port of UtteranceController.swift — the brain of the apprentice's spoken
// output. One queue, one state machine, one source of truth. Enqueue paths,
// chain-to-next, persist tail, interrupt/flush, and beat callbacks are ported
// 1:1; the karaoke word-reveal machinery is not (the Electron surfaces render
// the whole bubble text — overlay_bubble carries it once at utterance start).

type UtteranceState = 'queued' | 'speaking' | 'persisting' | 'dismissing'

/// How long after TTS finishes the bubble stays on screen so the user can
/// finish reading (UtteranceController.persistTailSeconds).
const PERSIST_TAIL_MS = 2500

/// Safety net absent in Swift (there, playback callbacks were in-process and
/// reliable). Here audio completion crosses IPC to a hidden window — if that
/// frame is ever lost the queue must not stall forever. Fires loudly.
const WATCHDOG_QUEUED_MS = 30000
const WATCHDOG_BASE_MS = 20000
const WATCHDOG_PER_WORD_MS = 600

export interface UtteranceEvents {
  /** Audio actually started for this utterance → bubble + speaking state. */
  onUtteranceStart(u: Utterance): void
  /** Persist tail expired (or hard stop) → overlay_bubble_clear. */
  onBubbleClear(): void
  /** audioActive may have changed → recompute the pill state. */
  onActivityChange(): void
}

export class UtteranceController {
  private getBackend: () => TTSBackend
  private events: UtteranceEvents

  private queue: Utterance[] = []
  private current: Utterance | null = null
  private state: UtteranceState = 'queued'

  /// Annotation "beats" timed to the speech timeline — each fires when the
  /// utterance it was enqueued behind finishes (dropped on barge-in).
  private pendingBeats: Array<{ anchor: string; action: () => void }> = []

  private dismissTimer: NodeJS.Timeout | null = null
  private watchdog: NodeJS.Timeout | null = null

  constructor(getBackend: () => TTSBackend, events: UtteranceEvents) {
    this.getBackend = getBackend
    this.events = events
  }

  /** True while audio is pending or sounding (isSpeakingAloud twin). */
  get audioActive(): boolean {
    return (
      this.queue.length > 0 ||
      (this.current !== null && (this.state === 'queued' || this.state === 'speaking'))
    )
  }

  /** Enqueue a new utterance; `displayOverride` mirrors `say.subtitle`. */
  enqueue(spokenText: string, displayOverride?: string): void {
    const trimmed = spokenText.trim()
    if (!trimmed) return
    const u = makeUtterance(trimmed, displayOverride)

    if (!this.current) {
      this.startPlaying(u)
      return
    }
    switch (this.state) {
      case 'speaking':
      case 'queued':
        // TTS already has an utterance → queue. NEVER double-play (that class
        // of desync is exactly what the Swift controller was built to kill).
        this.queue.push(u)
        // Prefetch EVERY queued chunk immediately — each line gets the whole
        // preceding playtime of download lead, not one sentence's worth.
        this.getBackend().prefetch?.(u)
        break
      case 'persisting':
      case 'dismissing':
        // Interrupt the persist tail only when nothing else is queued;
        // otherwise preserve source order (multi-`say` responses reorder
        // into nonsense otherwise).
        if (this.queue.length === 0) {
          this.cancelDismiss()
          this.startPlaying(u)
        } else {
          this.queue.push(u)
          this.getBackend().prefetch?.(u)
        }
        break
    }
  }

  /// Enqueue a cursor/annotation action timed to the speech queue: fires when
  /// the last currently-queued (or currently-speaking) utterance finishes.
  /// If nothing is speaking it fires immediately.
  enqueueBeat(action: () => void): void {
    const anchor = this.queue.length
      ? this.queue[this.queue.length - 1].id
      : this.current?.id
    if (!anchor) {
      action()
      return
    }
    this.pendingBeats.push({ anchor, action })
  }

  /** Hard stop — drop the current utterance and the queue (barge-in). */
  stopAll(): void {
    const hadWork = this.current !== null || this.queue.length > 0
    this.cancelDismiss()
    this.clearWatchdog()
    this.queue = []
    this.pendingBeats = []
    this.current = null
    // Only touch the backend when something was actually in flight —
    // getBackend() lazily constructs (and warms sockets); an idle barge-in
    // must not pay that cost (Swift guard: tts.stopAll iff current != nil).
    if (hadWork) this.getBackend().stopAll()
    this.events.onBubbleClear()
    this.events.onActivityChange()
  }

  // MARK: - Backend events (wired via TTSCallbacks in voice.ts)

  handleDidStart(id: string): void {
    const u = this.current
    if (!u || u.id !== id) return
    this.state = 'speaking'
    this.armWatchdog(id, WATCHDOG_BASE_MS + u.wordSpans.length * WATCHDOG_PER_WORD_MS)
    this.events.onUtteranceStart(u)
    this.events.onActivityChange()
    // Prefetch the next utterance while this one plays (network backends use
    // this to eliminate the silence gap between consecutive utterances).
    const nextUp = this.queue[0]
    if (nextUp) this.getBackend().prefetch?.(nextUp)
  }

  handleDidFinish(id: string, cancelled: boolean): void {
    const u = this.current
    if (!u || u.id !== id) return
    this.clearWatchdog()

    // Fire beats anchored to THIS utterance; drop them silently on barge-in.
    if (this.pendingBeats.length) {
      const due = this.pendingBeats.filter((b) => b.anchor === id)
      this.pendingBeats = this.pendingBeats.filter((b) => b.anchor !== id)
      if (!cancelled) for (const b of due) b.action()
    }

    // Chain-to-next: more content on the way → no persist tail, no dead air.
    if (this.queue.length > 0 && !cancelled) {
      this.current = null
      this.playNextFromQueueIfAny()
      this.events.onActivityChange()
      return
    }

    // Solo response → persist tail, then clear the bubble.
    this.state = 'persisting'
    this.events.onActivityChange()
    this.scheduleDismiss()
  }

  // MARK: - Lifecycle helpers

  private startPlaying(u: Utterance): void {
    // Invariant: one utterance in flight. Defensive queue-front insert
    // instead of corrupting state (start_play_violation twin).
    if (this.current && (this.state === 'speaking' || this.state === 'queued')) {
      console.warn('[voice] start_play while in flight — queueing instead')
      this.queue.unshift(u)
      return
    }
    this.cancelDismiss()
    this.current = u
    this.state = 'queued' // becomes 'speaking' on didStart
    this.armWatchdog(u.id, WATCHDOG_QUEUED_MS)
    this.getBackend().play(u)
  }

  private scheduleDismiss(): void {
    this.cancelDismiss()
    this.dismissTimer = setTimeout(() => {
      this.dismissTimer = null
      this.state = 'dismissing'
      this.events.onBubbleClear()
      this.current = null
      this.playNextFromQueueIfAny()
    }, PERSIST_TAIL_MS)
  }

  private playNextFromQueueIfAny(): void {
    const next = this.queue.shift()
    if (next) this.startPlaying(next)
  }

  private cancelDismiss(): void {
    if (this.dismissTimer) {
      clearTimeout(this.dismissTimer)
      this.dismissTimer = null
    }
  }

  private armWatchdog(id: string, ms: number): void {
    this.clearWatchdog()
    this.watchdog = setTimeout(() => {
      this.watchdog = null
      if (this.current?.id === id) {
        console.warn(`[voice] watchdog force-finish for ${id.slice(0, 8)} after ${ms}ms`)
        this.handleDidFinish(id, false)
      }
    }, ms)
  }

  private clearWatchdog(): void {
    if (this.watchdog) {
      clearTimeout(this.watchdog)
      this.watchdog = null
    }
  }
}
