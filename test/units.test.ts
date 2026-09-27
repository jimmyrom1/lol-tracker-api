import { describe, expect, it } from 'vitest'
import { BudgetExhaustedError, parseRateLimitHeader, RateLimiter } from '../src/riot/rateLimiter.ts'
import { matchRoute } from '../src/riot/routes.ts'
import { SingleFlight } from '../src/singleflight.ts'

const PUUID = 'TOPzvpMJ8BWP4N5j3daOMI3aH3fv_Fm9mfWNI0l9cV59sTBlPO83LzeRA4Yp0IZeusjc4HzqXQNO4w'

describe('matchRoute', () => {
  it('allows the routes the app uses, with their cache policy', () => {
    const match = matchRoute('europe', '/lol/match/v5/matches/EUW1_7995150714', {})
    expect(match.ok && match.rule.name).toBe('match')
    expect(match.ok && match.rule.ttl).toBeNull() // una partida jugada no caduca

    const live = matchRoute('euw1', `/lol/spectator/v5/active-games/by-summoner/${PUUID}`, {})
    expect(live.ok && live.rule.ttl).toBe(20)
  })

  it('accepts encoded Riot IDs', () => {
    expect(matchRoute('europe', '/riot/account/v1/accounts/by-riot-id/Lee%20Sin%20Main/EUW', {}).ok).toBe(true)
    expect(matchRoute('europe', '/riot/account/v1/accounts/by-riot-id/Pe%C3%B1a/ES1', {}).ok).toBe(true)
  })

  it('rejects anything else before reaching Riot', () => {
    expect(matchRoute('mars', '/lol/match/v5/matches/EUW1_1', {})).toEqual({ ok: false, reason: 'unknown_routing' })
    // La API de torneos, de estado, o una ruta regional pedida a una plataforma: fuera.
    expect(matchRoute('europe', '/lol/tournament/v5/codes', {})).toEqual({ ok: false, reason: 'route_not_allowed' })
    expect(matchRoute('euw1', '/lol/match/v5/matches/EUW1_1', {})).toEqual({ ok: false, reason: 'route_not_allowed' })
    expect(matchRoute('europe', '/lol/match/v5/matches/EUW1_1/../../status', {})).toEqual({ ok: false, reason: 'route_not_allowed' })
    expect(matchRoute('europe', '/lol/match/v5/matches/EUW1_1', { api_key: 'x' })).toEqual({ ok: false, reason: 'invalid_query' })
  })

  it('validates query parameters and makes them canonical for the cache key', () => {
    const path = `/lol/match/v5/matches/by-puuid/${PUUID}/ids`
    const a = matchRoute('europe', path, { start: '0', count: '20' })
    const b = matchRoute('europe', path, { count: '20', start: '0' })
    expect(a.ok && a.canonicalQuery).toBe('count=20&start=0')
    expect(b.ok && b.canonicalQuery).toBe('count=20&start=0')
    expect(matchRoute('europe', path, { count: '500' }).ok).toBe(false)
    expect(matchRoute('europe', path, { count: '-1' }).ok).toBe(false)
  })
})

/** Reloj falso: dormir solo adelanta el tiempo, así el test tarda milisegundos. */
const fakeClock = () => {
  let now = 0
  const sleeps: number[] = []
  return {
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms)
      now += ms
    },
    sleeps,
    advance: (ms: number) => (now += ms),
  }
}

describe('RateLimiter', () => {
  it('parses Riot rate limit headers', () => {
    expect(parseRateLimitHeader('20:1,100:120')).toEqual([
      { limit: 20, seconds: 1 },
      { limit: 100, seconds: 120 },
    ])
    expect(parseRateLimitHeader('garbage')).toBeNull()
    expect(parseRateLimitHeader(undefined)).toBeNull()
  })

  it('keeps a safety margin below the real limits', () => {
    expect(new RateLimiter().effectiveWindows()).toEqual([
      { limit: 18, seconds: 1 },
      { limit: 90, seconds: 120 },
    ])
  })

  it('never exceeds any window, even with a long burst', async () => {
    const clock = fakeClock()
    const limiter = new RateLimiter({ now: clock.now, sleep: clock.sleep, maxWaitMs: 200_000 })
    const sent: number[] = []
    for (let i = 0; i < 250; i++) {
      await limiter.acquire('europe')
      sent.push(clock.now())
    }
    for (const start of sent) {
      expect(sent.filter((t) => t >= start && t < start + 1_000).length).toBeLessThanOrEqual(18)
      expect(sent.filter((t) => t >= start && t < start + 120_000).length).toBeLessThanOrEqual(90)
    }
  })

  it('counts each routing value separately, like Riot', async () => {
    const clock = fakeClock()
    const limiter = new RateLimiter({ windows: [{ limit: 1, seconds: 1 }], safety: 1, now: clock.now, sleep: clock.sleep })
    await limiter.acquire('europe')
    await limiter.acquire('euw1')
    expect(clock.sleeps).toEqual([])
  })

  it('adopts the limits Riot reports (e.g. a production key)', () => {
    const limiter = new RateLimiter()
    limiter.updateFromHeader('500:10,30000:600')
    expect(limiter.effectiveWindows()).toEqual([
      { limit: 450, seconds: 10 },
      { limit: 27000, seconds: 600 },
    ])
  })

  it('refuses to make the client wait too long', async () => {
    const clock = fakeClock()
    const limiter = new RateLimiter({ windows: [{ limit: 1, seconds: 120 }], safety: 1, maxWaitMs: 5_000, now: clock.now, sleep: clock.sleep })
    await limiter.acquire('europe')
    await expect(limiter.acquire('europe')).rejects.toThrow(BudgetExhaustedError)
  })

  it('after a 429 nothing is sent to that host until Retry-After passes', async () => {
    const clock = fakeClock()
    const limiter = new RateLimiter({ now: clock.now, sleep: clock.sleep })
    limiter.penalize('europe', 3)
    await limiter.acquire('europe')
    expect(clock.sleeps).toEqual([3_000])
  })
})

describe('SingleFlight', () => {
  it('shares one in-flight task between identical callers', async () => {
    const flights = new SingleFlight<number>()
    let calls = 0
    let release!: (v: number) => void
    const task = () => {
      calls++
      return new Promise<number>((resolve) => (release = resolve))
    }
    const results = [flights.run('k', task), flights.run('k', task), flights.run('k', task)]
    release(42)
    const settled = await Promise.all(results)
    expect(calls).toBe(1)
    expect(settled.map((r) => r.value)).toEqual([42, 42, 42])
    expect(settled.filter((r) => r.shared)).toHaveLength(2)
    expect(flights.size).toBe(0)
  })

  it('does not keep failed tasks around', async () => {
    const flights = new SingleFlight<number>()
    await expect(flights.run('k', () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    expect((await flights.run('k', () => Promise.resolve(1))).value).toBe(1)
  })
})
