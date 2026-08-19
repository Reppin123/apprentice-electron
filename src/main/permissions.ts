import { systemPreferences, shell } from 'electron'
import { execFile } from 'child_process'

// Permission introspection + grant deep-links. macOS = the TCC dance the
// onboarding wizard walks; Windows = mic only (no TCC equivalents).

export interface PermState {
  platform: string
  mic: boolean
  speech: boolean
  inputMonitoring: boolean
  accessibility: boolean
  screen: boolean
  automation: boolean
  cliToolsPresent: boolean
}

export function permState(): PermState {
  if (process.platform === 'darwin') {
    return {
      platform: 'darwin',
      mic: systemPreferences.getMediaAccessStatus('microphone') === 'granted',
      speech: systemPreferences.getMediaAccessStatus('microphone') === 'granted',
      inputMonitoring: true, // no direct query API; uiohook working is the real probe
      accessibility: systemPreferences.isTrustedAccessibilityClient(false),
      screen: systemPreferences.getMediaAccessStatus('screen') === 'granted',
      automation: true, // queried lazily on first apple-event
      cliToolsPresent: true
    }
  }
  const micGranted =
    process.platform === 'win32'
      ? systemPreferences.getMediaAccessStatus('microphone') === 'granted'
      : true
  return {
    platform: process.platform,
    mic: micGranted,
    speech: micGranted,
    inputMonitoring: true,
    accessibility: true,
    screen: true,
    automation: true,
    cliToolsPresent: true
  }
}

export async function requestPermission(kind: string): Promise<void> {
  if (process.platform === 'win32' && (kind === 'mic' || kind === 'speech')) {
    // Windows has no askForMediaAccess — Chromium prompts on getUserMedia.
    // The caller (index.ts) triggers that via VoiceService.requestMicAccess().
    return
  }
  if (process.platform !== 'darwin') return
  switch (kind) {
    case 'mic':
    case 'speech':
      await systemPreferences.askForMediaAccess('microphone')
      break
    case 'accessibility':
      systemPreferences.isTrustedAccessibilityClient(true)
      shell.openExternal(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
      )
      break
    case 'inputMonitoring':
      shell.openExternal(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent'
      )
      break
    case 'screen':
      shell.openExternal(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
      )
      break
    case 'automation':
      shell.openExternal(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation'
      )
      break
  }
}

export function revealSelfInFinder(): void {
  if (process.platform === 'darwin') {
    execFile('/usr/bin/open', ['-R', process.execPath])
  } else {
    shell.showItemInFolder(process.execPath)
  }
}
