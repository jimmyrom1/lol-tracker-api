import { timingSafeEqual } from 'node:crypto'
import rateLimit from '@fastify/rate-limit'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import { Type, type TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import type { CacheStore } from './cache/cacheStore.ts'
import type { Db } from './db.ts'
import type { RateLimiter } from './riot/rateLimiter.ts'
import type { RiotClient } from './riot/riotClient.ts'
import type { RiotProxy } from './riot/riotProxy.ts'

export interface AppDeps {
  db: Db
  proxy: RiotProxy
  cache: CacheStore
  limiter: RateLimiter
  client: RiotClient
  appToken?: string
  clientRateLimitPerMinute?: number
  logger?: boolean | object
}

const ErrorBody = Type.Object({ error: Type.String() })

function tokenMatches(expected: string, received: string | undefined): boolean {
  if (!received) return false
  const a = Buffer.from(expected)
  const b = Buffer.from(received)
  // Comparación en tiempo constante: no revela cuántos caracteres del token son correctos.
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Quién es el cliente a efectos de límite: su token si lo manda, si no su IP. */
const clientKey = (request: FastifyRequest) => (request.headers['x-app-token'] as string | undefined) ?? request.ip

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger ?? false }).withTypeProvider<TypeBoxTypeProvider>()

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'LoL Tracker API',
        version: '1.0.0',
        description:
          'Proxy con caché de la API de Riot para LoL Tracker. La API key vive solo en el servidor; ' +
          'las rutas permitidas son las mismas que las de Riot, con el valor de enrutado delante.',
      },
      components: { securitySchemes: { appToken: { type: 'apiKey', in: 'header', name: 'X-App-Token' } } },
    },
  })
  await app.register(swaggerUi, { routePrefix: '/docs' })

  // Límite por cliente: que uno solo no pueda gastarse la cuota de Riot de todos.
  await app.register(rateLimit, {
    global: false,
    keyGenerator: clientKey,
    errorResponseBuilder: (_req, ctx) => ({ statusCode: 429, error: 'client_rate_limited', retryAfter: ctx.after }),
  })

  app.get('/health', { schema: { tags: ['sistema'], response: { 200: Type.Object({ status: Type.String() }) } } }, async (_req, reply) => {
    await deps.db.query('SELECT 1')
    return reply.send({ status: 'ok' })
  })

  app.get('/stats', { schema: { tags: ['sistema'], description: 'Aciertos de caché, peticiones a Riot y uso del límite.' } }, async () => ({
    proxy: deps.proxy.stats,
    upstreamCalls: deps.client.upstreamCalls,
    hitRatio: deps.proxy.stats.requests === 0 ? 0 : deps.proxy.stats.hits / deps.proxy.stats.requests,
    riotBudget: Object.fromEntries(['europe', 'euw1'].map((r) => [r, deps.limiter.usage(r)])),
    cache: await deps.cache.stats(),
  }))

  app.register(async (instance) => {
    const riot = instance.withTypeProvider<TypeBoxTypeProvider>()
    if (deps.appToken) {
      const expected = deps.appToken
      riot.addHook('onRequest', async (request, reply) => {
        if (!tokenMatches(expected, request.headers['x-app-token'] as string | undefined)) {
          return reply.code(401).send({ error: 'invalid_app_token' })
        }
      })
    }

    riot.get(
      '/riot/:routing/*',
      {
        config: { rateLimit: { max: deps.clientRateLimitPerMinute ?? 120, timeWindow: '1 minute' } },
        schema: {
          tags: ['riot'],
          description:
            'Misma ruta que en la API de Riot, precedida del enrutado. Ej.: /riot/europe/lol/match/v5/matches/EUW1_123. ' +
            'La cabecera X-Cache indica HIT (caché), MISS (se pidió a Riot) o SHARED (se unió a una petición en curso).',
          security: [{ appToken: [] }],
          params: Type.Object({ routing: Type.String(), '*': Type.String() }),
          querystring: Type.Record(Type.String(), Type.String()),
          response: { 200: Type.Unknown(), 400: ErrorBody, 401: ErrorBody, 404: Type.Unknown(), 502: ErrorBody, 503: ErrorBody },
        },
      },
      async (request, reply) => {
        // Se usa la ruta tal cual llega (codificada): Riot ID con espacios o tildes.
        const rawPath = (request.raw.url ?? '').split('?')[0] ?? ''
        const path = rawPath.slice(`/riot/${request.params.routing}`.length)
        const result = await deps.proxy.get(request.params.routing, path, request.query)

        switch (result.kind) {
          case 'response':
            return reply
              .code(result.status)
              .header('Content-Type', 'application/json; charset=utf-8')
              .header('X-Cache', result.cache)
              .header('Age', String(result.ageSeconds))
              .send(result.body)
          case 'rejected':
            return reply.code(result.status).send({ error: result.error })
          case 'unavailable':
            if (result.retryAfterSeconds) reply.header('Retry-After', String(result.retryAfterSeconds))
            return reply.code(result.status).send({ error: result.error })
        }
      },
    )
  })

  return app
}
