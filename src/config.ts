export interface Config {
  port: number
  host: string
  databaseUrl: string
  riotApiKey: string
  riotBaseUrlTemplate: string
  /** Si está definido, las apps deben mandar `X-App-Token` con este valor. */
  appToken: string | undefined
  clientRateLimitPerMinute: number
  logLevel: string
}

/** Lee la configuración del entorno y falla al arrancar si falta algo, no a la primera petición. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const required = (name: string): string => {
    const value = env[name]?.trim()
    if (!value) throw new Error(`Falta la variable de entorno ${name}`)
    return value
  }
  const positiveInt = (name: string, fallback: number): number => {
    const raw = env[name]?.trim()
    if (!raw) return fallback
    const value = Number(raw)
    if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} debe ser un entero positivo`)
    return value
  }
  return {
    port: positiveInt('PORT', 3000),
    host: env.HOST?.trim() || '0.0.0.0',
    databaseUrl: required('DATABASE_URL'),
    riotApiKey: required('RIOT_API_KEY'),
    riotBaseUrlTemplate: env.RIOT_BASE_URL_TEMPLATE?.trim() || 'https://{routing}.api.riotgames.com',
    appToken: env.APP_TOKEN?.trim() || undefined,
    clientRateLimitPerMinute: positiveInt('CLIENT_RATE_LIMIT_PER_MINUTE', 120),
    logLevel: env.LOG_LEVEL?.trim() || 'info',
  }
}
