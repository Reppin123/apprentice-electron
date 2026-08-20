import { spawn, ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join, dirname } from 'path'
import { connect } from 'net'
import { dataDir, claudeConfigDir, bridgeToken } from './paths'

// Supervisor for the Python agent — the Electron twin of
// AgentProcessManager.swift. Attach-mode first: if something already listens
// on :8765 (a dev agent, a cutover harness run) we attach instead of
// spawning, which is also what makes run-cutover-agent.sh style testing work.

const WS_PORT = Number(process.env.APPRENTICE_WS_PORT || 8765)

function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ port, host: '127.0.0.1' })
    const done = (up: boolean): void => {
      sock.destroy()
      resolve(up)
    }
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
    sock.setTimeout(800, () => done(false))
  })
}

function frozenAgentBinary(): string | null {
  // Packaged layout: <resources>/agent.dist/apprentice-agent[.exe]
  const name = process.platform === 'win32' ? 'apprentice-agent.exe' : 'apprentice-agent'
  const candidate = join(process.resourcesPath || '', 'agent.dist', name)
  return existsSync(candidate) ? candidate : null
}

function devAgentCommand(): { cmd: string; args: string[]; cwd: string } | null {
  // Dev fallback: the source repo + its venv, same as the Mac dev flow.
  const repo = join(homedir(), 'Clicky-Apprenticeship', 'apprentice-agent')
  const venvPy =
    process.platform === 'win32'
      ? join(homedir(), '.virtualenvs', 'apprentice-agent', 'Scripts', 'python.exe')
      : join(homedir(), '.virtualenvs', 'apprentice-agent', 'bin', 'python')
  if (!existsSync(repo)) return null
  const py = existsSync(venvPy) ? venvPy : process.platform === 'win32' ? 'python' : 'python3'
  return { cmd: py, args: ['-m', 'apprentice.agent'], cwd: join(repo, 'src') }
}

export class AgentProcess {
  private child: ChildProcess | null = null
  private stopped = false
  private restartDelayMs = 1000
  public attached = false
  public readonly token: string

  constructor() {
    this.token = bridgeToken()
  }

  async start(): Promise<void> {
    this.stopped = false
    if (await portInUse(WS_PORT)) {
      // An agent is already serving — attach, don't double-spawn (a second
      // bind fails anyway; this is the documented single-:8765 invariant).
      this.attached = true
      console.log(`[agent] attaching to existing agent on :${WS_PORT}`)
      return
    }
    this.spawnAgent()
  }

  private buildEnv(): NodeJS.ProcessEnv {
    // Allowlist, not inherit-wholesale (AgentProcessManager.swift:302-316 —
    // strips Anaconda/dev PATHs). UTF-8 forced: a GUI-launched app has no
    // LANG and embedded CPython falls back to ASCII, aborting on any
    // non-ASCII byte.
    const keep = [
      'PATH',
      'HOME',
      'USER',
      'USERPROFILE',
      'LOCALAPPDATA',
      'APPDATA',
      'TMPDIR',
      'TEMP',
      'TMP',
      'SYSTEMROOT',
      'COMSPEC',
      'LANG',
      'LC_ALL',
      'ANTHROPIC_API_KEY'
    ]
    const env: NodeJS.ProcessEnv = {}
    for (const k of keep) if (process.env[k]) env[k] = process.env[k]
    env.APPRENTICE_BRIDGE_TOKEN = this.token
    env.APPRENTICE_DATA_DIR = dataDir()
    env.CLAUDE_CONFIG_DIR = claudeConfigDir()
    env.CLAUDE_SECURESTORAGE_CONFIG_DIR = claudeConfigDir()
    env.PYTHONUTF8 = '1'
    env.PYTHONIOENCODING = 'utf-8:backslashreplace'
    // Windows routes the LLM through the owned harness seam: Claude models run
    // the bundled Claude SDK/CLI path (funded + authed), everything else the
    // HTTP providers. An explicit user-set value still wins (see the loop below).
    if (process.platform === 'win32' && !process.env.APPRENTICE_HARNESS) {
      env.APPRENTICE_HARNESS = '1'
    }
    // Pass-through knobs the user may have set for a dev run.
    for (const k of [
      'APPRENTICE_HARNESS',
      'APPRENTICE_HARNESS_MODEL',
      'APPRENTICE_PIPELINE',
      'APPRENTICE_FILE_DISCOVERY',
      'APPRENTICE_USER_NAME',
      'APPRENTICE_WS_PORT',
      'APPRENTICE_CONNECTIONS_BACKEND',
      'APPRENTICE_COMPOSIO_BROKER_URL',
      'APPRENTICE_COMPOSIO_APP_GATE'
    ]) {
      if (process.env[k]) env[k] = process.env[k]
    }
    if (!env.APPRENTICE_COMPOSIO_BROKER_URL) {
      env.APPRENTICE_COMPOSIO_BROKER_URL =
        'https://apprentice-composio-broker.akshitbansal1313.workers.dev'
    }
    if (!env.APPRENTICE_COMPOSIO_APP_GATE) {
      env.APPRENTICE_COMPOSIO_APP_GATE =
        '99e18ea09e8ad33506f267037a96161b0feacb2f876fa21238968745b5ecc3bb'
    }
    return env
  }

  private spawnAgent(): void {
    const frozen = frozenAgentBinary()
    let cmd: string
    let args: string[]
    let cwd: string
    if (frozen) {
      cmd = frozen
      args = []
      // cwd = the binary's own dir: bundled models/ + skills/ resolve via
      // Path(__file__)-relative walks in the dist.
      cwd = dirname(frozen)
    } else {
      const dev = devAgentCommand()
      if (!dev) {
        console.error('[agent] no frozen agent bundled and no dev repo found — running shell-only')
        return
      }
      ;({ cmd, args, cwd } = dev)
    }
    console.log(`[agent] spawning: ${cmd} ${args.join(' ')}`)
    const child = spawn(cmd, args, { cwd, env: this.buildEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
    this.child = child
    child.stdout?.on('data', (d) => process.stdout.write(`[agent] ${d}`))
    child.stderr?.on('data', (d) => process.stderr.write(`[agent] ${d}`))
    child.on('exit', (code, signal) => {
      if (this.child !== child) return
      this.child = null
      console.log(`[agent] exited code=${code} signal=${signal}`)
      // Respawn with capped backoff — an agent death must not be terminal
      // for the app (the no-respawn class of bug).
      if (!this.stopped) {
        const delay = this.restartDelayMs
        this.restartDelayMs = Math.min(this.restartDelayMs * 2, 15000)
        setTimeout(() => {
          if (!this.stopped) this.spawnAgent()
        }, delay)
      }
    })
    // Reset backoff after a stable minute.
    setTimeout(() => {
      if (this.child === child) this.restartDelayMs = 1000
    }, 60000)
  }

  stop(): void {
    this.stopped = true
    if (this.child) {
      this.child.kill('SIGTERM')
      this.child = null
    }
  }
}
