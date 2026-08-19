import { app } from 'electron'
import { homedir } from 'os'
import { join } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { randomBytes } from 'crypto'

// The shell-side twin of memory/paths.py — ONE resolver, and the agent's
// hello `dirs` echo is asserted against it at runtime (config-dir integrity
// invariant: launcher owns policy, agent owns mechanism, reads never
// recompute).

export function dataDir(): string {
  const override = process.env.APPRENTICE_DATA_DIR
  if (override) return override
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Apprentice')
  }
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    return join(local, 'Apprentice')
  }
  const xdg = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share')
  return join(xdg, 'Apprentice')
}

/** Window / tray icon. Packaged surfaces carry apprentice-mark.png. */
export function appIcon(): string {
  const packaged = join(process.resourcesPath || '', 'surfaces', 'apprentice-mark.png')
  const dev = join(app.getAppPath(), 'src', 'renderer', 'surfaces', 'apprentice-mark.png')
  return existsSync(packaged) ? packaged : dev
}

export function logDir(): string {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Logs', 'Apprentice')
  if (process.platform === 'win32') return join(dataDir(), 'Logs')
  const xdgState = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state')
  return join(xdgState, 'Apprentice')
}

// Deliberately the BASELINE dir, never a suffixed/override data dir —
// ClaudeCLIEnv.swift carries a "do not 'fix' this to appDataDir()" warning:
// suffix-isolating the login would force a re-login, and sharing the CLI's
// default ~/.claude would let our sign-out nuke the user's own Claude Code
// keychain entry (the 2026-06-10 incident).
export function claudeConfigDir(): string {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Apprentice', 'claude')
  }
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    return join(local, 'Apprentice', 'claude')
  }
  const xdg = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share')
  return join(xdg, 'Apprentice', 'claude')
}

// Token policy mirrors BridgeAuth.swift + agent.py: env override wins, else
// the file at <dataDir>/bridge_token — created here (launcher owns policy)
// and read by the agent as its fallback, so both sides agree by construction.
export function bridgeToken(): string {
  const envToken = process.env.APPRENTICE_BRIDGE_TOKEN
  if (envToken) return envToken
  const dir = dataDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tokenFile = join(dir, 'bridge_token')
  if (existsSync(tokenFile)) {
    const t = readFileSync(tokenFile, 'utf-8').trim()
    if (t) return t
  }
  const token = randomBytes(32).toString('hex')
  writeFileSync(tokenFile, token, { mode: 0o600 })
  return token
}
