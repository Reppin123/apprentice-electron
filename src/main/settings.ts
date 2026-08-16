import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { dataDir } from './paths'

// Shell-side persisted config — the UserDefaults twin. TTS engine keys live
// HERE (shell truth), model-provider keys live agent-side; tune_state sends
// only booleans for keys, mirroring pushTuneState() in leanring_buddyApp.

export interface ShellSettings {
  ttsBackend: string // apple|edge|cartesia|google|openai → 'system' replaces apple cross-OS
  edgeVoiceID: string
  googleVoiceID: string
  openaiVoiceID: string
  cartesiaVoiceID: string
  googleAPIKey: string
  openaiAPIKey: string
  cartesiaAPIKey: string
  openaiSpeed: number
  cursorColor: number // index into CursorColorOption.allCases
  hueSize: string // small|regular|large
  pointerAlways: boolean // 'on screen': always vs while-we-talk
  peek: boolean
  sees: boolean // context awareness
  userName: string
  selectedModelId: string
  callMode: string // remote|inperson
  hasCompletedOnboarding: boolean
  onboardingResume: string
  launchAtLogin: boolean
  hearth: Record<string, unknown>
}

const DEFAULTS: ShellSettings = {
  ttsBackend: 'edge',
  edgeVoiceID: 'en-US-AvaNeural',
  googleVoiceID: 'en-US-Neural2-J',
  openaiVoiceID: 'marin',
  cartesiaVoiceID: '',
  googleAPIKey: '',
  openaiAPIKey: '',
  cartesiaAPIKey: '',
  openaiSpeed: 1.0,
  cursorColor: 0,
  hueSize: 'regular',
  pointerAlways: true,
  peek: false,
  sees: true,
  userName: '',
  selectedModelId: '',
  callMode: 'remote',
  hasCompletedOnboarding: false,
  onboardingResume: '',
  launchAtLogin: false,
  hearth: {}
}

export const TTS_VOICES = {
  edge: [
    { id: 'en-US-AvaNeural', label: 'Ava' },
    { id: 'en-US-AndrewNeural', label: 'Andrew' },
    { id: 'en-US-EmmaNeural', label: 'Emma' },
    { id: 'en-US-BrianNeural', label: 'Brian' },
    { id: 'en-US-JennyNeural', label: 'Jenny' },
    { id: 'en-US-AriaNeural', label: 'Aria' },
    { id: 'en-GB-SoniaNeural', label: 'Sonia (UK)' },
    { id: 'en-GB-RyanNeural', label: 'Ryan (UK)' }
  ],
  google: [
    { id: 'en-US-Neural2-J', label: 'Neural2 J (EN) ★' },
    { id: 'en-US-Neural2-F', label: 'Neural2 F (EN) ★' },
    { id: 'en-US-Neural2-D', label: 'Neural2 D (EN) ★' },
    { id: 'en-GB-Neural2-B', label: 'Neural2 B (UK) ★' },
    { id: 'en-US-Journey-D', label: 'Journey D (EN)' },
    { id: 'en-US-Journey-F', label: 'Journey F (EN)' },
    { id: 'hi-IN-Neural2-D', label: 'Neural2 D (HI) ★' },
    { id: 'hi-IN-Neural2-A', label: 'Neural2 A (HI) ★' },
    { id: 'es-US-Neural2-B', label: 'Neural2 B (ES) ★' },
    { id: 'fr-FR-Neural2-B', label: 'Neural2 B (FR) ★' },
    { id: 'de-DE-Neural2-B', label: 'Neural2 B (DE) ★' }
  ],
  openai: [
    { id: 'marin', label: 'Marin ★' },
    { id: 'cedar', label: 'Cedar ★' },
    { id: 'alloy', label: 'Alloy' },
    { id: 'ash', label: 'Ash' },
    { id: 'ballad', label: 'Ballad' },
    { id: 'coral', label: 'Coral' },
    { id: 'echo', label: 'Echo' },
    { id: 'nova', label: 'Nova' },
    { id: 'sage', label: 'Sage' },
    { id: 'shimmer', label: 'Shimmer' },
    { id: 'verse', label: 'Verse' }
  ]
}

export class SettingsStore {
  private file: string
  private data: ShellSettings

  constructor() {
    const dir = dataDir()
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
    this.file = join(dir, 'shell-settings.json')
    this.data = { ...DEFAULTS }
    if (existsSync(this.file)) {
      try {
        this.data = { ...DEFAULTS, ...JSON.parse(readFileSync(this.file, 'utf-8')) }
      } catch {
        /* corrupt file → defaults */
      }
    }
  }

  get<K extends keyof ShellSettings>(key: K): ShellSettings[K] {
    return this.data[key]
  }

  set<K extends keyof ShellSettings>(key: K, value: ShellSettings[K]): void {
    this.data[key] = value
    this.save()
  }

  private save(): void {
    try {
      writeFileSync(this.file, JSON.stringify(this.data, null, 2), { mode: 0o600 })
    } catch (err) {
      console.error('[settings] save failed', err)
    }
  }

  /** The tune_state frame pushed to the summon's Tune page. */
  buildTuneState(email: string, version: string): { type: string; [key: string]: unknown } {
    return {
      type: 'tune_state',
      tts: this.data.ttsBackend,
      color: this.data.cursorColor,
      peek: this.data.peek,
      sees: this.data.sees,
      email,
      version,
      ttsVoices: TTS_VOICES,
      ttsVoice: {
        edge: this.data.edgeVoiceID,
        google: this.data.googleVoiceID,
        openai: this.data.openaiVoiceID
      },
      ttsKey: {
        google: !!this.data.googleAPIKey,
        cartesia: !!this.data.cartesiaAPIKey,
        openai: !!this.data.openaiAPIKey
      },
      openaiSpeed: this.data.openaiSpeed,
      userName: this.data.userName,
      hueSize: this.data.hueSize,
      pointerAlways: this.data.pointerAlways
    }
  }
}
