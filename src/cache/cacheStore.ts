import type { Db } from '../db.ts'

export interface CachedResponse {
  status: 200 | 404
  body: string
  fetchedAt: Date
}

export class CacheStore {
  private readonly db: Db

  constructor(db: Db) {
    this.db = db
  }

  /** Solo devuelve la entrada si sigue vigente en [now]. */
  async getFresh(key: string, now: Date): Promise<CachedResponse | null> {
    const { rows } = await this.db.query<{ status: number; body: string; fetched_at: Date }>(
      `SELECT status, body, fetched_at FROM riot_cache
        WHERE cache_key = $1 AND (expires_at IS NULL OR expires_at > $2)`,
      [key, now],
    )
    const row = rows[0]
    return row ? { status: row.status as 200 | 404, body: row.body, fetchedAt: row.fetched_at } : null
  }

  /** `ttlSeconds` null = no caduca nunca. */
  async put(key: string, route: string, status: 200 | 404, body: string, now: Date, ttlSeconds: number | null): Promise<void> {
    const expiresAt = ttlSeconds === null ? null : new Date(now.getTime() + ttlSeconds * 1000)
    await this.db.query(
      `INSERT INTO riot_cache (cache_key, route, status, body, fetched_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (cache_key) DO UPDATE
         SET status = EXCLUDED.status, body = EXCLUDED.body,
             fetched_at = EXCLUDED.fetched_at, expires_at = EXCLUDED.expires_at`,
      [key, route, status, body, now, expiresAt],
    )
  }

  /** Borra lo caducado hace más de [graceSeconds]; las partidas (sin caducidad) no se tocan. */
  async purgeExpired(now: Date, graceSeconds = 86_400): Promise<number> {
    const { rowCount } = await this.db.query('DELETE FROM riot_cache WHERE expires_at < $1', [
      new Date(now.getTime() - graceSeconds * 1000),
    ])
    return rowCount ?? 0
  }

  async stats(): Promise<Array<{ route: string; entries: number; bytes: number }>> {
    const { rows } = await this.db.query<{ route: string; entries: string; bytes: string }>(
      `SELECT route, count(*) AS entries, coalesce(sum(octet_length(body)), 0) AS bytes
         FROM riot_cache GROUP BY route ORDER BY route`,
    )
    return rows.map((r) => ({ route: r.route, entries: Number(r.entries), bytes: Number(r.bytes) }))
  }
}
