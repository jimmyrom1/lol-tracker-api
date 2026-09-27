import type { RateLimiter } from './rateLimiter.ts'

export interface UpstreamResponse {
  status: number
  body: string
  retryAfterSeconds?: number
}

export interface RiotClientOptions {
  apiKey: string
  limiter: RateLimiter
  /** "https://{routing}.api.riotgames.com"; en los tests apunta a un servidor falso. */
  baseUrlTemplate?: string
  fetch?: typeof fetch
  timeoutMs?: number
}

/** Único sitio donde se usa la API key. Nunca sale del servidor ni aparece en los logs. */
export class RiotClient {
  private readonly options: Required<Omit<RiotClientOptions, 'fetch'>> & { fetch: typeof fetch }
  upstreamCalls = 0

  constructor(options: RiotClientOptions) {
    this.options = {
      baseUrlTemplate: 'https://{routing}.api.riotgames.com',
      timeoutMs: 10_000,
      fetch: globalThis.fetch,
      ...options,
    }
  }

  async get(routing: string, pathAndQuery: string): Promise<UpstreamResponse> {
    const { limiter, apiKey, baseUrlTemplate, timeoutMs } = this.options
    await limiter.acquire(routing)
    this.upstreamCalls++
    const url = baseUrlTemplate.replace('{routing}', routing) + pathAndQuery
    const res = await this.options.fetch(url, {
      headers: { 'X-Riot-Token': apiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    limiter.updateFromHeader(res.headers.get('X-App-Rate-Limit'))

    const body = await res.text()
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('Retry-After') ?? '1') || 1
      // Todas las peticiones a ese host esperan: insistir durante un 429 es lo que Riot penaliza.
      limiter.penalize(routing, retryAfter)
      return { status: 429, body, retryAfterSeconds: retryAfter }
    }
    return { status: res.status, body }
  }
}
