/**
 * Límite de peticiones hacia Riot, con ventanas deslizantes por valor de enrutado (europe, euw1...),
 * que es como las cuenta Riot.
 *
 * - Parte de los límites de una key de desarrollo o personal (20/s y 100/2 min) y los ajusta con
 *   la cabecera `X-App-Rate-Limit` de cada respuesta: si la key tiene más margen (producción), se
 *   aprovecha solo.
 * - Deja un margen de seguridad (por defecto el 90 %), porque recibir 429 a menudo puede acabar
 *   con la key suspendida.
 * - Si para enviar una petición habría que esperar más de `maxWaitMs`, no se hace esperar al
 *   cliente: se lanza [BudgetExhaustedError] y la API responde 503 con Retry-After.
 */

export interface Window {
  limit: number
  seconds: number
}

export class BudgetExhaustedError extends Error {
  readonly retryAfterSeconds: number

  constructor(retryAfterSeconds: number) {
    super(`Riot rate limit budget exhausted, retry in ${retryAfterSeconds}s`)
    this.retryAfterSeconds = retryAfterSeconds
  }
}

export const DEFAULT_WINDOWS: Window[] = [
  { limit: 20, seconds: 1 },
  { limit: 100, seconds: 120 },
]

/** "20:1,100:120" → [{20, 1}, {100, 120}] */
export function parseRateLimitHeader(header: string | null | undefined): Window[] | null {
  if (!header) return null
  const windows = header.split(',').map((part) => {
    const [limit, seconds] = part.trim().split(':').map(Number)
    return { limit: limit ?? NaN, seconds: seconds ?? NaN }
  })
  return windows.every((w) => Number.isInteger(w.limit) && w.limit > 0 && Number.isInteger(w.seconds) && w.seconds > 0)
    ? windows
    : null
}

export interface RateLimiterOptions {
  windows?: Window[]
  /** Fracción del límite real que se usa (0..1]. */
  safety?: number
  maxWaitMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export class RateLimiter {
  private windows: Window[]
  private readonly safety: number
  private readonly maxWaitMs: number
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly sent = new Map<string, number[]>()
  /** Tras un 429, nada sale hacia ese host hasta este instante. */
  private readonly blockedUntil = new Map<string, number>()

  constructor(options: RateLimiterOptions = {}) {
    this.windows = options.windows ?? DEFAULT_WINDOWS
    this.safety = options.safety ?? 0.9
    this.maxWaitMs = options.maxWaitMs ?? 10_000
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  /** Espera hasta que la petición cabe y la registra. Nunca deja pasar dos a la vez por el mismo hueco. */
  async acquire(routing: string): Promise<void> {
    for (;;) {
      const wait = this.reserve(routing)
      if (wait === 0) return
      if (wait > this.maxWaitMs) throw new BudgetExhaustedError(Math.ceil(wait / 1000))
      await this.sleep(wait)
    }
  }

  /** Riot manda sus límites reales en cada respuesta: se adoptan si son válidos. */
  updateFromHeader(header: string | null | undefined): void {
    const parsed = parseRateLimitHeader(header)
    if (parsed) this.windows = parsed
  }

  /** Un 429 con Retry-After bloquea ese host durante ese tiempo para todas las peticiones. */
  penalize(routing: string, retryAfterSeconds: number): void {
    this.blockedUntil.set(routing, Math.max(this.blockedUntil.get(routing) ?? 0, this.now() + retryAfterSeconds * 1000))
  }

  effectiveWindows(): Window[] {
    return this.windows.map((w) => ({ limit: Math.max(1, Math.floor(w.limit * this.safety)), seconds: w.seconds }))
  }

  usage(routing: string): Array<Window & { used: number }> {
    const t = this.now()
    const sent = this.sent.get(routing) ?? []
    return this.effectiveWindows().map((w) => ({ ...w, used: sent.filter((s) => s > t - w.seconds * 1000).length }))
  }

  /** 0 si se ha registrado la petición; si no, los milisegundos que hay que esperar. Síncrono: sin carreras. */
  private reserve(routing: string): number {
    const t = this.now()
    const blocked = (this.blockedUntil.get(routing) ?? 0) - t
    if (blocked > 0) return blocked

    const windows = this.effectiveWindows()
    const longest = Math.max(...windows.map((w) => w.seconds * 1000))
    const sent = (this.sent.get(routing) ?? []).filter((s) => s > t - longest)
    this.sent.set(routing, sent)

    let wait = 0
    for (const w of windows) {
      const inWindow = sent.filter((s) => s > t - w.seconds * 1000)
      if (inWindow.length >= w.limit) {
        // Hay que esperar a que salga de la ventana la más antigua que sobra.
        const oldest = inWindow[inWindow.length - w.limit] ?? t
        wait = Math.max(wait, oldest + w.seconds * 1000 - t + 1)
      }
    }
    if (wait === 0) sent.push(t)
    return wait
  }
}
