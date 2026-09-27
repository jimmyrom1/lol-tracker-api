import { buildApp } from './app.ts'
import { CacheStore } from './cache/cacheStore.ts'
import { loadConfig } from './config.ts'
import { createPool } from './db.ts'
import { migrate } from './migrate.ts'
import { RateLimiter } from './riot/rateLimiter.ts'
import { RiotClient } from './riot/riotClient.ts'
import { RiotProxy } from './riot/riotProxy.ts'

const config = loadConfig()
const db = createPool(config.databaseUrl)
await migrate(db)

const cache = new CacheStore(db)
const limiter = new RateLimiter()
const client = new RiotClient({ apiKey: config.riotApiKey, limiter, baseUrlTemplate: config.riotBaseUrlTemplate })
const proxy = new RiotProxy(cache, client)

const app = await buildApp({
  db,
  proxy,
  cache,
  limiter,
  client,
  appToken: config.appToken,
  clientRateLimitPerMinute: config.clientRateLimitPerMinute,
  logger: {
    level: config.logLevel,
    // Por si acaso: estas cabeceras nunca llegan a los logs.
    redact: ['req.headers["x-app-token"]', 'req.headers["x-riot-token"]'],
  },
})

// Limpieza diaria de lo caducado (las partidas no caducan y no se tocan).
const purge = setInterval(() => {
  cache.purgeExpired(new Date()).then(
    (n) => n > 0 && app.log.info({ purged: n }, 'Caché: entradas caducadas borradas'),
    (error: unknown) => app.log.error(error, 'Error limpiando la caché'),
  )
}, 60 * 60 * 1000)
purge.unref()

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    clearInterval(purge)
    await app.close()
    await db.end()
    process.exit(0)
  })
}

await app.listen({ port: config.port, host: config.host })
