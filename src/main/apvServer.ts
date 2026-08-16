import { createServer, Server } from 'http'
import { BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'

// The APV editor's loopback MCP server — Python's apv_editor.py POSTs
// JSON-RPC 2.0 to http://127.0.0.1:19791/mcp. The Swift twin (APVMCPServer)
// runs only while the editor is open; we mirror that: start() on editor
// open, stop() on close, so a closed editor yields connection-refused and
// the agent's friendly "open the editor" error.
//
// tools/list and tools/call are forwarded to the apv-editor page as
// synthetic frames {type:"apv_rpc", id, name, args}; the page answers with
// {type:"apv_rpc_result", id, text, is_error} via the surface wire.

const PORT = 19791

interface Pending {
  resolve: (v: { text: string; is_error: boolean }) => void
  timer: NodeJS.Timeout
}

export class ApvServer {
  private server: Server | null = null
  private pending = new Map<string, Pending>()
  private getWindow: () => BrowserWindow | undefined

  constructor(getWindow: () => BrowserWindow | undefined) {
    this.getWindow = getWindow
  }

  /** Page replies arrive through the relay's host-action routing. */
  handleRpcResult(msg: Record<string, unknown>): void {
    const id = String(msg.id || '')
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    clearTimeout(p.timer)
    p.resolve({ text: String(msg.text ?? ''), is_error: !!msg.is_error })
  }

  start(): void {
    if (this.server) return
    this.server = createServer((req, res) => {
      if (req.method !== 'POST' || !req.url?.startsWith('/mcp')) {
        res.writeHead(405).end('Method Not Allowed')
        return
      }
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', async () => {
        let rpc: Record<string, unknown>
        try {
          rpc = JSON.parse(body)
        } catch {
          res.writeHead(400).end()
          return
        }
        const send = (obj: unknown): void => {
          const s = JSON.stringify(obj)
          res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' }).end(s)
        }
        const method = String(rpc.method || '')
        const rpcId = rpc.id
        if (rpcId === undefined || method.startsWith('notifications/')) {
          res.writeHead(202, { 'Content-Type': 'application/json' }).end('{}')
          return
        }
        if (method === 'initialize') {
          send({
            jsonrpc: '2.0',
            id: rpcId,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: 'apprentice-video', version: '0.1.0' }
            }
          })
          return
        }
        if (method === 'ping') {
          send({ jsonrpc: '2.0', id: rpcId, result: {} })
          return
        }
        if (method === 'tools/list') {
          const r = await this.callPage('__list_tools', {})
          try {
            send({ jsonrpc: '2.0', id: rpcId, result: { tools: JSON.parse(r.text) } })
          } catch {
            send({ jsonrpc: '2.0', id: rpcId, result: { tools: [] } })
          }
          return
        }
        if (method === 'tools/call') {
          const params = (rpc.params || {}) as Record<string, unknown>
          const r = await this.callPage(String(params.name || ''), params.arguments || {})
          send({
            jsonrpc: '2.0',
            id: rpcId,
            result: { content: [{ type: 'text', text: r.text }], isError: r.is_error }
          })
          return
        }
        send({ jsonrpc: '2.0', id: rpcId, error: { code: -32601, message: 'method not found' } })
      })
    })
    this.server.listen(PORT, '127.0.0.1')
    this.server.on('error', (err) => console.error('[apv] server error', err))
  }

  stop(): void {
    this.server?.close()
    this.server = null
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.resolve({ text: 'editor closed', is_error: true })
    }
    this.pending.clear()
  }

  private callPage(name: string, args: unknown): Promise<{ text: string; is_error: boolean }> {
    const win = this.getWindow()
    if (!win || win.isDestroyed()) {
      return Promise.resolve({ text: 'Apprentice Editor window is not open.', is_error: true })
    }
    const id = randomUUID()
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve({ text: 'editor did not respond', is_error: true })
      }, 25000)
      this.pending.set(id, { resolve, timer })
      win.webContents.send('bridge:message', { type: 'apv_rpc', id, name, args })
    })
  }
}
