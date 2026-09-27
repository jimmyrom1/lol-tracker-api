import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import type { Db } from './db.ts'
import { createPool } from './db.ts'

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations')

/**
 * Aplica en orden los .sql de migrations/ que falten, cada uno en su transacción. Un advisory
 * lock evita que dos instancias arrancando a la vez apliquen la misma migración dos veces.
 */
export async function migrate(db: Db, log: (msg: string) => void = console.log): Promise<string[]> {
  const client = await db.connect()
  const applied: string[] = []
  try {
    await client.query('SELECT pg_advisory_lock(727274)')
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    )
    const done = new Set((await client.query<{ version: string }>('SELECT version FROM schema_migrations')).rows.map((r) => r.version))
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).toSorted()
    for (const file of files) {
      if (done.has(file)) continue
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8')
      await client.query('BEGIN')
      try {
        await client.query(sql)
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file])
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      }
      applied.push(file)
      log(`Migración aplicada: ${file}`)
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727274)').catch(() => {})
    client.release()
  }
  return applied
}

// `npm run migrate`
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('Falta DATABASE_URL')
  const db = createPool(url)
  await migrate(db)
  await db.end()
}
