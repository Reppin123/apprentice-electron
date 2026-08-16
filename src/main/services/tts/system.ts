import { spawn, ChildProcess } from 'node:child_process'
import { TTSBackend, TTSCallbacks, Utterance } from './types'

// The cross-OS replacement for AppleSpeechTTSClient.swift: same one-at-a-time
// play/stopAll contract (the UtteranceController owns the queue above this),
// voiced by the OS itself — /usr/bin/say on macOS, System.Speech via
// PowerShell on Windows. No audio.html involvement: the OS plays the audio,
// so completion comes from child-process exit, not audio_done.

const PS_SPEAK =
  '$t=[Console]::In.ReadToEnd();' +
  'Add-Type -AssemblyName System.Speech;' +
  '$s=New-Object System.Speech.Synthesis.SpeechSynthesizer;' +
  '$s.Speak($t)'

export class SystemTTSBackend implements TTSBackend {
  private cb: TTSCallbacks
  private child: ChildProcess | null = null
  private currentId: string | null = null
  private warned = false

  constructor(cb: TTSCallbacks) {
    this.cb = cb
  }

  play(u: Utterance): void {
    this.stopChild()
    let child: ChildProcess | null = null
    try {
      if (process.platform === 'darwin') {
        child = spawn('/usr/bin/say', [], { stdio: ['pipe', 'ignore', 'ignore'] })
      } else if (process.platform === 'win32') {
        child = spawn('powershell.exe', ['-NoProfile', '-Command', PS_SPEAK], {
          stdio: ['pipe', 'ignore', 'ignore'],
          windowsHide: true
        })
      }
    } catch {
      child = null
    }
    if (!child) {
      if (!this.warned) {
        this.warned = true
        console.warn('[tts.system] no system TTS on this platform — utterances are silent')
      }
      this.cb.onStart(u.id)
      this.cb.onFinish(u.id, false) // keep the queue advancing
      return
    }

    this.child = child
    this.currentId = u.id
    child.stdin?.write(u.spokenText)
    child.stdin?.end()
    this.cb.onStart(u.id)

    const done = (): void => {
      if (this.child !== child) return // superseded or stopped
      this.child = null
      const id = this.currentId
      this.currentId = null
      if (id) this.cb.onFinish(id, false)
    }
    child.on('exit', done)
    child.on('error', done)
  }

  stopAll(): void {
    this.stopChild()
  }

  handleAudioDone(): void {
    // System speech never routes through audio.html.
  }

  private stopChild(): void {
    const child = this.child
    this.child = null // detach FIRST so exit/error handlers no-op
    this.currentId = null
    if (child && child.exitCode === null) {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
    }
  }
}
