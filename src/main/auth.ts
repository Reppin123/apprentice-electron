import { execFile, spawn } from 'child_process'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join, dirname } from 'path'
import { claudeConfigDir } from './paths'

// AuthGuard port — shells the BUNDLED Claude CLI with an isolated
// CLAUDE_CONFIG_DIR so sign-out never nukes the user's own Claude Code
// keychain login (the 2026-06-10 incident class).

export type AuthState =
  | { state: 'loggedOut' }
  | { state: 'loggingIn' }
  | { state: 'freeTier'; detail?: string }
  | { state: 'authorized'; email: string }
  | { state: 'error'; detail: string }

function bundledCli(): string | null {
  const roots = [
    process.env.APPRENTICE_AGENT_BINARY ? dirname(process.env.APPRENTICE_AGENT_BINARY) : null,
    process.resourcesPath ? join(process.resourcesPath, 'agent.dist') : null,
    join(homedir(), 'Clicky-Apprenticeship', 'apprentice-agent', 'build', 'agent.dist')
  ].filter(Boolean) as string[]
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude'
  for (const root of roots) {
    for (const rel of [
      join('_internal', 'claude_agent_sdk', '_bundled', exe),
      join('claude_agent_sdk', '_bundled', exe)
    ]) {
      const p = join(root, rel)
      if (existsSync(p)) return p
    }
  }
  return null
}

function cliEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CLAUDE_CONFIG_DIR: claudeConfigDir(),
    CLAUDE_SECURESTORAGE_CONFIG_DIR: claudeConfigDir()
  }
}

export class AuthGuard {
  public current: AuthState = { state: 'loggedOut' }
  public onChange: ((s: AuthState) => void) | null = null

  private set(s: AuthState): void {
    this.current = s
    this.onChange?.(s)
  }

  async refresh(): Promise<AuthState> {
    const cli = bundledCli()
    if (!cli) {
      this.set({ state: 'error', detail: 'bundled Claude CLI not found' })
      return this.current
    }
    return new Promise((resolve) => {
      execFile(cli, ['auth', 'status'], { env: cliEnv(), timeout: 15000 }, (err, stdout) => {
        if (err && !stdout) {
          this.set({ state: 'loggedOut' })
          return resolve(this.current)
        }
        try {
          const jsonStart = stdout.indexOf('{')
          const o = JSON.parse(stdout.slice(jsonStart))
          if (!o.loggedIn) this.set({ state: 'loggedOut' })
          else if (o.authMethod === 'console' || o.authMethod === 'api_key')
            this.set({ state: 'authorized', email: o.email || '' })
          else if (o.subscriptionType === 'max' || o.subscriptionType === 'pro')
            this.set({ state: 'authorized', email: o.email || '' })
          else this.set({ state: 'freeTier', detail: String(o.subscriptionType || '') })
        } catch {
          this.set({ state: 'loggedOut' })
        }
        resolve(this.current)
      })
    })
  }

  /** Detached login (browser flow); poll refresh() to detect completion. */
  login(kind: 'claudeai' | 'console'): void {
    const cli = bundledCli()
    if (!cli) return
    this.set({ state: 'loggingIn' })
    const child = spawn(cli, ['auth', 'login', kind === 'claudeai' ? '--claudeai' : '--console'], {
      env: cliEnv(),
      detached: true,
      stdio: 'ignore'
    })
    child.unref()
    // poll for up to 3 minutes
    let polls = 0
    const t = setInterval(async () => {
      polls += 1
      const s = await this.refresh()
      if (s.state === 'authorized' || polls > 60) clearInterval(t)
      else if (s.state !== 'loggingIn') this.set({ state: 'loggingIn' })
    }, 3000)
  }

  async logout(): Promise<void> {
    const cli = bundledCli()
    if (!cli) return
    await new Promise<void>((resolve) => {
      execFile(cli, ['auth', 'logout'], { env: cliEnv(), timeout: 15000 }, () => resolve())
    })
    await this.refresh()
  }
}
