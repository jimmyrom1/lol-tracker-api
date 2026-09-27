import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.ts'
import { CacheStore } from '../src/cache/cacheStore.ts'
import { createPool, type Db } from '../src/db.ts'
import { migrate } from '../src/migrate.ts'
import { RateLimiter } from '../src/riot/rateLimiter.ts'
import { RiotClient } from '../src/riot/riotClient.ts'
import { RiotProxy } from '../src/riot/riotProxy.ts'
import { FakeRiot } from './fakeRiot.ts'

/**
 * Tests contra PostgreSQL real. En la CI hay un servicio de PostgreSQL; en local se puede usar
 * cualquier base de datos, incluso un esquema aparte de otra: ?options=-c search_path=lol_api
 */
const DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://app:app@localhost:5432/subscriptions_test?options=-c%20search_path%3Dlol_api'

const PUUID = 'TOPzvpMJ8BWP4N5j3daOMI3aH3fv_Fm9mfWNI0l9cV59sTBlPO83LzeRA4Yp0IZeusjc4HzqXQNO4w'
const MATCH = '/riot/europe/lol/match/v5/matches/EUW1_7995150714'
const LIVE = `/riot/euw1/lol/spectator/v5/active-games/by-summoner/${PUUID}`
const KEY = 'RGAPI-secreta-del-servidor'

let db: Db
let riot: FakeRiot
let now: Date
let app: FastifyInstance
let client: RiotClient
let proxy: RiotProxy

async function makeApp(options: { appToken?: string; clientRateLimitPerMinute?: number; limiter?: RateLimiter } = {}) {
  const limiter = options.limiter ?? new RateLimiter()
  client = new RiotClient({ apiKey: KEY, limiter, baseUrlTemplate: riot.baseUrlTemplate })
  const cache = new CacheStore(db)
  proxy = new RiotProxy(cache, client, () => now)
  app = await buildApp({ db, proxy, cache, limiter, client, ...options })
}

beforeAll(async () => {
  db = createPool(DATABASE_URL)
  await migrate(db, () => {})
  riot = await new FakeRiot().start()
})

afterAll(async () => {
  await riot.stop()
  await db.end()
})

beforeEach(async () => {
  await db.query('TRUNCATE riot_cache')
  riot.requests.length = 0
  riot.respond = (url) => ({ status: 200, body: { url } })
  now = new Date('2026-09-27T12:00:00Z')
  await makeApp()
})

afterEach(async () => {
  await app.close()
})

describe('cache', () => {
  it('a played match is fetched from Riot once and then served from PostgreSQL', async () => {
    const first = await app.inject({ url: MATCH })
    expect(first.statusCode).toBe(200)
    expect(first.headers['x-cache']).toBe('MISS')

    now = new Date('2027-09-27T12:00:00Z') // un año después sigue valiendo
    const second = await app.inject({ url: MATCH })
    expect(second.headers['x-cache']).toBe('HIT')
    expect(second.body).toBe(first.body)
    expect(Number(second.headers.age)).toBeGreaterThan(0)
    expect(riot.requests).toHaveLength(1)
  })

  it('the live game expires after 20 seconds', async () => {
    await app.inject({ url: LIVE })
    now = new Date(now.getTime() + 19_000)
    expect((await app.inject({ url: LIVE })).headers['x-cache']).toBe('HIT')
    now = new Date(now.getTime() + 2_000)
    expect((await app.inject({ url: LIVE })).headers['x-cache']).toBe('MISS')
    expect(riot.requests).toHaveLength(2)
  })

  it('"not in game" (404) is cached too, so polling does not hammer Riot', async () => {
    riot.respond = () => ({ status: 404, body: { status: { status_code: 404, message: 'Data not found' } } })
    expect((await app.inject({ url: LIVE })).statusCode).toBe(404)
    expect((await app.inject({ url: LIVE })).headers['x-cache']).toBe('HIT')
    expect(riot.requests).toHaveLength(1)
  })

  it('query order does not create a different cache entry', async () => {
    const ids = `/riot/europe/lol/match/v5/matches/by-puuid/${PUUID}/ids`
    await app.inject({ url: `${ids}?start=0&count=20` })
    expect((await app.inject({ url: `${ids}?count=20&start=0` })).headers['x-cache']).toBe('HIT')
    expect(riot.requests[0]?.url).toBe(`/europe/lol/match/v5/matches/by-puuid/${PUUID}/ids?count=20&start=0`)
  })

  it('ten players opening the same match at once cause a single Riot request', async () => {
    riot.respond = (url) => ({ status: 200, body: { url }, delayMs: 100 })
    const responses = await Promise.all(Array.from({ length: 10 }, () => app.inject({ url: MATCH })))

    expect(riot.requests).toHaveLength(1)
    expect(responses.every((r) => r.statusCode === 200)).toBe(true)
    const outcomes = responses.map((r) => r.headers['x-cache'])
    expect(outcomes.filter((o) => o === 'MISS')).toHaveLength(1)
    expect(outcomes.filter((o) => o === 'SHARED')).toHaveLength(9)
  })
})

describe('the Riot key', () => {
  it('is added by the server and never reaches the client', async () => {
    const res = await app.inject({ url: MATCH, headers: { 'X-Riot-Token': 'RGAPI-del-cliente' } })
    expect(riot.requests[0]?.riotToken).toBe(KEY) // se ignora la del cliente
    expect(res.body).not.toContain(KEY)
    expect(JSON.stringify(res.headers)).not.toContain(KEY)
  })

  it('a rejected key is a server problem: 502 without details, and it is not cached', async () => {
    riot.respond = () => ({ status: 403, body: { status: { message: 'Forbidden' } } })
    const res = await app.inject({ url: MATCH })
    expect(res.statusCode).toBe(502)
    expect(res.json()).toEqual({ error: 'riot_key_rejected' })

    riot.respond = (url) => ({ status: 200, body: { url } })
    expect((await app.inject({ url: MATCH })).statusCode).toBe(200)
    expect(riot.requests).toHaveLength(2)
  })
})

describe('protecting the Riot quota', () => {
  it('routes outside the allowlist are rejected without spending quota', async () => {
    expect((await app.inject({ url: '/riot/europe/lol/tournament/v5/codes' })).statusCode).toBe(404)
    expect((await app.inject({ url: '/riot/mars/lol/match/v5/matches/EUW1_1' })).statusCode).toBe(404)
    expect((await app.inject({ url: `${MATCH}?api_key=hack` })).statusCode).toBe(400)
    expect(riot.requests).toHaveLength(0)
  })

  it('a 429 from Riot becomes 503 + Retry-After and pauses that host for everyone', async () => {
    riot.respond = () => ({ status: 429, headers: { 'Retry-After': '30' } })
    const res = await app.inject({ url: MATCH })
    expect(res.statusCode).toBe(503)
    expect(res.headers['retry-after']).toBe('30')

    // La siguiente no llega a Riot: el servidor sabe que tiene que esperar 30 s (más que el máximo).
    const next = await app.inject({ url: '/riot/europe/lol/match/v5/matches/EUW1_2' })
    expect(next.statusCode).toBe(503)
    expect(next.json()).toEqual({ error: 'riot_budget_exhausted' })
    expect(riot.requests).toHaveLength(1)
  })

  it('when the budget is used up, clients get 503 instead of hanging', async () => {
    await app.close()
    await makeApp({ limiter: new RateLimiter({ safety: 1, maxWaitMs: 1_000 }) })
    // Riot anuncia en cada respuesta el límite de la key; el servidor lo adopta al momento.
    riot.respond = (url) => ({ status: 200, body: { url }, headers: { 'X-App-Rate-Limit': '2:120' } })
    await app.inject({ url: '/riot/europe/lol/match/v5/matches/EUW1_1' })
    await app.inject({ url: '/riot/europe/lol/match/v5/matches/EUW1_2' })

    const third = await app.inject({ url: '/riot/europe/lol/match/v5/matches/EUW1_3' })
    expect(third.statusCode).toBe(503)
    expect(Number(third.headers['retry-after'])).toBeGreaterThan(100)
    // Lo que ya está en caché se sigue sirviendo aunque no quede cuota.
    expect((await app.inject({ url: '/riot/europe/lol/match/v5/matches/EUW1_1' })).statusCode).toBe(200)
  })

  it('each client has its own request limit', async () => {
    await app.close()
    await makeApp({ clientRateLimitPerMinute: 3 })
    for (let i = 0; i < 3; i++) expect((await app.inject({ url: MATCH })).statusCode).toBe(200)
    const blocked = await app.inject({ url: MATCH })
    expect(blocked.statusCode).toBe(429)
    expect(blocked.json().error).toBe('client_rate_limited')
  })
})

describe('app token', () => {
  it('is required when configured', async () => {
    await app.close()
    await makeApp({ appToken: 'token-de-la-app' })
    expect((await app.inject({ url: MATCH })).statusCode).toBe(401)
    expect((await app.inject({ url: MATCH, headers: { 'X-App-Token': 'otro' } })).statusCode).toBe(401)
    expect((await app.inject({ url: MATCH, headers: { 'X-App-Token': 'token-de-la-app' } })).statusCode).toBe(200)
    // /health no lo necesita (lo usa el orquestador de contenedores).
    expect((await app.inject({ url: '/health' })).statusCode).toBe(200)
  })
})

describe('encoded Riot IDs', () => {
  it('are forwarded exactly as received', async () => {
    const res = await app.inject({ url: '/riot/europe/riot/account/v1/accounts/by-riot-id/Pe%C3%B1a%20Lol/ES1' })
    expect(res.statusCode).toBe(200)
    expect(riot.requests[0]?.url).toBe('/europe/riot/account/v1/accounts/by-riot-id/Pe%C3%B1a%20Lol/ES1')
  })
})

describe('observability', () => {
  it('stats report hits, misses and cache size per route', async () => {
    await app.inject({ url: MATCH })
    await app.inject({ url: MATCH })
    const stats = (await app.inject({ url: '/stats' })).json()
    expect(stats.proxy).toMatchObject({ requests: 2, hits: 1, misses: 1 })
    expect(stats.upstreamCalls).toBe(1)
    expect(stats.hitRatio).toBe(0.5)
    expect(stats.cache).toEqual([{ route: 'match', entries: 1, bytes: expect.any(Number) }])
    expect(stats.riotBudget.europe[0]).toMatchObject({ limit: 18, seconds: 1, used: 1 })
  })

  it('migrations are idempotent', async () => {
    expect(await migrate(db, () => {})).toEqual([])
  })

  it('expired entries are purged, played matches are kept', async () => {
    await app.inject({ url: MATCH })
    await app.inject({ url: LIVE })
    const purged = await new CacheStore(db).purgeExpired(new Date(now.getTime() + 2 * 86_400_000))
    expect(purged).toBe(1)
    expect((await app.inject({ url: MATCH })).headers['x-cache']).toBe('HIT')
  })
})
