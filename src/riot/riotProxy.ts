import type { CacheStore } from '../cache/cacheStore.ts'
import { SingleFlight } from '../singleflight.ts'
import { BudgetExhaustedError } from './rateLimiter.ts'
import type { RiotClient, UpstreamResponse } from './riotClient.ts'
import { matchRoute } from './routes.ts'

export type CacheOutcome = 'HIT' | 'MISS' | 'SHARED'

export type ProxyResult =
  | { kind: 'response'; status: 200 | 404; body: string; cache: CacheOutcome; ageSeconds: number; route: string }
  | { kind: 'rejected'; status: 400 | 404; error: string }
  /** Riot no está disponible o no queda cuota: el cliente debe reintentar más tarde. */
  | { kind: 'unavailable'; status: 502 | 503; error: string; retryAfterSeconds?: number }

export interface ProxyStats {
  requests: number
  hits: number
  misses: number
  shared: number
  rejected: number
  unavailable: number
}

export class RiotProxy {
  private readonly cache: CacheStore
  private readonly client: RiotClient
  private readonly now: () => Date
  private readonly flights = new SingleFlight<UpstreamResponse>()
  readonly stats: ProxyStats = { requests: 0, hits: 0, misses: 0, shared: 0, rejected: 0, unavailable: 0 }

  constructor(cache: CacheStore, client: RiotClient, now: () => Date = () => new Date()) {
    this.cache = cache
    this.client = client
    this.now = now
  }

  async get(routing: string, path: string, query: Record<string, string>): Promise<ProxyResult> {
    this.stats.requests++
    const match = matchRoute(routing, path, query)
    if (!match.ok) {
      this.stats.rejected++
      return { kind: 'rejected', status: match.reason === 'invalid_query' ? 400 : 404, error: match.reason }
    }
    const { rule, canonicalQuery } = match
    const pathAndQuery = canonicalQuery ? `${path}?${canonicalQuery}` : path
    const key = `${routing}${pathAndQuery}`

    const cached = await this.cache.getFresh(key, this.now())
    if (cached) {
      this.stats.hits++
      return this.response(cached.status, cached.body, 'HIT', cached.fetchedAt, rule.name)
    }

    let upstream: UpstreamResponse
    let shared: boolean
    try {
      ;({ value: upstream, shared } = await this.flights.run(key, async () => {
        const res = await this.client.get(routing, pathAndQuery)
        // Se guarda dentro del vuelo compartido: quien llegue justo después ya lo encuentra en caché.
        if (res.status === 200 || res.status === 404) {
          await this.cache.put(key, rule.name, res.status, res.body, this.now(), res.status === 200 ? rule.ttl : rule.notFoundTtl)
        }
        return res
      }))
    } catch (error) {
      this.stats.unavailable++
      if (error instanceof BudgetExhaustedError) {
        return { kind: 'unavailable', status: 503, error: 'riot_budget_exhausted', retryAfterSeconds: error.retryAfterSeconds }
      }
      return { kind: 'unavailable', status: 502, error: 'riot_unreachable' }
    }

    if (shared) this.stats.shared++
    else this.stats.misses++

    if (upstream.status === 200 || upstream.status === 404) {
      return this.response(upstream.status, upstream.body, shared ? 'SHARED' : 'MISS', this.now(), rule.name)
    }
    this.stats.unavailable++
    if (upstream.status === 429) {
      return { kind: 'unavailable', status: 503, error: 'riot_rate_limited', retryAfterSeconds: upstream.retryAfterSeconds }
    }
    // 401/403: la key del servidor no vale. El cliente no puede arreglarlo: no se le reenvía el detalle.
    if (upstream.status === 401 || upstream.status === 403) {
      return { kind: 'unavailable', status: 502, error: 'riot_key_rejected' }
    }
    return { kind: 'unavailable', status: 502, error: `riot_status_${upstream.status}` }
  }

  private response(status: 200 | 404, body: string, cache: CacheOutcome, fetchedAt: Date, route: string): ProxyResult {
    const ageSeconds = Math.max(0, Math.floor((this.now().getTime() - fetchedAt.getTime()) / 1000))
    return { kind: 'response', status, body, cache, ageSeconds, route }
  }
}
