import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface FakeResponse {
  status: number
  body?: unknown
  headers?: Record<string, string>
  delayMs?: number
}

/**
 * Servidor que hace de Riot en los tests. Por defecto responde 200 con un JSON que identifica la
 * petición; con `respond` se puede simular un 404, un 429 o una key rechazada.
 */
export class FakeRiot {
  readonly requests: Array<{ url: string; riotToken: string | undefined }> = []
  respond: (url: string) => FakeResponse = (url) => ({ status: 200, body: { url } })
  private server: Server | undefined

  async start(): Promise<this> {
    this.server = createServer((req: IncomingMessage, res) => {
      const url = req.url ?? ''
      this.requests.push({ url, riotToken: req.headers['x-riot-token'] as string | undefined })
      const reply = this.respond(url)
      setTimeout(() => {
        res.writeHead(reply.status, { 'Content-Type': 'application/json', 'X-App-Rate-Limit': '20:1,100:120', ...reply.headers })
        res.end(reply.body === undefined ? '' : JSON.stringify(reply.body))
      }, reply.delayMs ?? 0)
    })
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve))
    return this
  }

  /** Plantilla para RiotClient: el enrutado va en la ruta en lugar del subdominio. */
  get baseUrlTemplate(): string {
    const { port } = this.server!.address() as AddressInfo
    return `http://127.0.0.1:${port}/{routing}`
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()))
  }
}
