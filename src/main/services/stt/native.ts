import { spawn, ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { DeepgramSTT } from './deepgram'

// Native macOS STT — the Apple-Speech parity path (prod dictation is
// SFSpeechRecognizer on-device, NOT Deepgram; Deepgram is calls-only). A
// compiled helper (resources/darwin/apprentice-stt) takes 16k mono Int16 PCM
// on stdin and emits {"type":"interim"|"final"|"error","text"} JSON lines.
//
// FailoverSTT is what the voice service actually uses: it buffers every PCM
// chunk and starts the native engine; if the helper dies before delivering a
// final (unsigned dev binary, TCC denial, missing model), it spins up
// Deepgram, replays the buffered audio, and carries on — speech is never
// dropped on an engine failure.

export interface SttEngine {
  start(): Promise<void>
  sendPcm(pcm: Buffer): void
  finish(): Promise<string>
  cancel(): void
}

function helperPath(): string | null {
  const packaged = join(process.resourcesPath || '', 'darwin', 'apprentice-stt')
  const dev = join(__dirname, '../../resources/darwin/apprentice-stt')
  if (existsSync(packaged)) return packaged
  if (existsSync(dev)) return dev
  return null
}

export function nativeSttAvailable(): boolean {
  return process.platform === 'darwin' && helperPath() !== null
}

export class NativeSTT implements SttEngine {
  private child: ChildProcess | null = null
  private finals: string[] = []
  private interim = ''
  private finalWaiters: Array<() => void> = []
  private done = false
  private exitedEarly = false
  private onInterim?: (text: string) => void
  /** fires once if the helper dies before producing a final */
  public onEngineFailure: (() => void) | null = null

  constructor(opts?: { onInterim?: (text: string) => void }) {
    this.onInterim = opts?.onInterim
  }

  start(): Promise<void> {
    const bin = helperPath()
    if (!bin) return Promise.reject(new Error('native stt helper missing'))
    const child = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child
    let buf = ''
    child.stdout?.on('data', (d) => {
      buf += d.toString()
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        try {
          const m = JSON.parse(line)
          if (m.type === 'interim') {
            this.interim = String(m.text || '')
            this.onInterim?.(this.interim)
          } else if (m.type === 'final') {
            const t = String(m.text || '').trim()
            if (t) this.finals.push(t)
            this.settle()
          } else if (m.type === 'error') {
            console.warn('[stt-native]', m.text)
          }
        } catch {
          /* partial line */
        }
      }
    })
    child.stderr?.on('data', () => {
      /* framework chatter — the JSON contract lives on stdout */
    })
    child.on('exit', (code, signal) => {
      if (this.child !== child) return
      this.child = null
      if (!this.done && this.finals.length === 0 && (code !== 0 || signal)) {
        // died without a final — TCC abort or crash
        this.exitedEarly = true
        this.onEngineFailure?.()
      }
      this.settle()
    })
    child.on('error', () => {
      this.exitedEarly = true
      this.onEngineFailure?.()
      this.settle()
    })
    return Promise.resolve()
  }

  sendPcm(pcm: Buffer): void {
    if (this.child?.stdin?.writable) {
      this.child.stdin.write(pcm)
    }
  }

  finish(): Promise<string> {
    if (this.done || this.exitedEarly) return Promise.resolve(this.result())
    try {
      this.child?.stdin?.end()
    } catch {
      /* already closed */
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(this.result()), 4000)
      this.finalWaiters.push(() => {
        clearTimeout(timer)
        resolve(this.result())
      })
    })
  }

  cancel(): void {
    this.done = true
    this.child?.kill()
    this.child = null
    this.settle()
  }

  private result(): string {
    this.done = true
    return (this.finals.join(' ') || this.interim).trim()
  }

  private settle(): void {
    this.done = true
    for (const w of this.finalWaiters.splice(0)) w()
  }
}

export class FailoverSTT implements SttEngine {
  private chunks: Buffer[] = []
  private engine: SttEngine | null = null
  private failedOver = false
  private onInterim?: (text: string) => void

  constructor(opts?: { onInterim?: (text: string) => void }) {
    this.onInterim = opts?.onInterim
  }

  async start(): Promise<void> {
    if (nativeSttAvailable()) {
      const native = new NativeSTT({ onInterim: this.onInterim })
      native.onEngineFailure = () => this.failover()
      this.engine = native
      await native.start()
      return
    }
    await this.startDeepgram()
  }

  private failover(): void {
    if (this.failedOver) return
    this.failedOver = true
    console.warn('[stt] native engine failed — falling back to deepgram, replaying buffer')
    this.startDeepgram().catch((err) => console.warn('[stt] deepgram fallback failed', err))
  }

  private async startDeepgram(): Promise<void> {
    const dg = new DeepgramSTT({ onInterim: this.onInterim })
    this.engine = dg
    await dg.start()
    for (const c of this.chunks) dg.sendPcm(c)
  }

  sendPcm(pcm: Buffer): void {
    this.chunks.push(pcm)
    this.engine?.sendPcm(pcm)
  }

  async finish(): Promise<string> {
    const engine = this.engine
    if (!engine) return ''
    const text = await engine.finish()
    // the native engine may have failed over mid-finish; ask the replacement
    if (!text && this.failedOver && this.engine !== engine && this.engine) {
      return this.engine.finish()
    }
    return text
  }

  cancel(): void {
    this.engine?.cancel()
    this.chunks = []
  }
}
