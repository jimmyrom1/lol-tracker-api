/**
 * Lista blanca de rutas de Riot que el servidor deja pasar. No es un proxy abierto: todo lo que
 * no encaje aquí se rechaza sin llegar a Riot (ni gastar cuota de la key).
 *
 * Cada ruta dice cuánto tiempo se puede reutilizar su respuesta. Una partida jugada no cambia
 * nunca; la partida en curso, en cuestión de segundos.
 */

export type RoutingKind = 'regional' | 'platform'

export interface RouteRule {
  name: string
  kind: RoutingKind
  pattern: RegExp
  /** Segundos que vale una respuesta 200; `null` = para siempre. */
  ttl: number | null
  /** Segundos que se recuerda un 404 (jugador sin partida en curso, campeón nunca jugado...). */
  notFoundTtl: number
  /** Parámetros de query admitidos y su validación; el resto se rechaza. */
  query?: Record<string, (value: string) => boolean>
}

export const REGIONAL = new Set(['europe', 'americas', 'asia', 'sea'])
export const PLATFORMS = new Set([
  'euw1', 'eun1', 'tr1', 'ru', 'me1', 'na1', 'br1', 'la1', 'la2', 'oc1', 'kr', 'jp1', 'sg2', 'tw2', 'vn2',
])

const PUUID = '[A-Za-z0-9_-]{60,90}'
const MATCH_ID = '[A-Z0-9]{2,6}_\\d{1,15}'
// Llegan codificados (un espacio es %20, una ñ son 6 caracteres), de ahí el margen.
const RIOT_NAME = '[^/]{1,160}'
const RIOT_TAG = '[^/]{1,60}'
const intIn = (min: number, max: number) => (v: string) => /^\d{1,4}$/.test(v) && Number(v) >= min && Number(v) <= max

const MINUTE = 60
const HOUR = 60 * MINUTE

export const ROUTES: RouteRule[] = [
  {
    name: 'account-by-riot-id',
    kind: 'regional',
    pattern: new RegExp(`^/riot/account/v1/accounts/by-riot-id/${RIOT_NAME}/${RIOT_TAG}$`),
    ttl: 24 * HOUR,
    notFoundTtl: 5 * MINUTE,
  },
  {
    name: 'match-ids',
    kind: 'regional',
    pattern: new RegExp(`^/lol/match/v5/matches/by-puuid/${PUUID}/ids$`),
    // Corto: es lo que dice si hay partidas nuevas.
    ttl: MINUTE,
    notFoundTtl: MINUTE,
    query: { start: intIn(0, 1000), count: intIn(1, 100), queue: intIn(0, 9999) },
  },
  {
    name: 'match',
    kind: 'regional',
    pattern: new RegExp(`^/lol/match/v5/matches/${MATCH_ID}$`),
    ttl: null,
    notFoundTtl: HOUR,
  },
  {
    name: 'match-timeline',
    kind: 'regional',
    pattern: new RegExp(`^/lol/match/v5/matches/${MATCH_ID}/timeline$`),
    ttl: null,
    notFoundTtl: HOUR,
  },
  {
    name: 'summoner',
    kind: 'platform',
    pattern: new RegExp(`^/lol/summoner/v4/summoners/by-puuid/${PUUID}$`),
    ttl: HOUR,
    notFoundTtl: 5 * MINUTE,
  },
  {
    name: 'league-entries',
    kind: 'platform',
    pattern: new RegExp(`^/lol/league/v4/entries/by-puuid/${PUUID}$`),
    ttl: 10 * MINUTE,
    notFoundTtl: 10 * MINUTE,
  },
  {
    name: 'mastery-top',
    kind: 'platform',
    pattern: new RegExp(`^/lol/champion-mastery/v4/champion-masteries/by-puuid/${PUUID}/top$`),
    ttl: HOUR,
    notFoundTtl: HOUR,
    query: { count: intIn(1, 20) },
  },
  {
    name: 'mastery-by-champion',
    kind: 'platform',
    pattern: new RegExp(`^/lol/champion-mastery/v4/champion-masteries/by-puuid/${PUUID}/by-champion/\\d{1,5}$`),
    ttl: 12 * HOUR,
    notFoundTtl: 12 * HOUR,
  },
  {
    name: 'active-game',
    kind: 'platform',
    pattern: new RegExp(`^/lol/spectator/v5/active-games/by-summoner/${PUUID}$`),
    // Casi en directo, pero si diez jugadores de la misma partida la consultan, basta con una petición.
    ttl: 20,
    notFoundTtl: 20,
  },
]

export type MatchResult =
  | { ok: true; rule: RouteRule; canonicalQuery: string }
  | { ok: false; reason: 'unknown_routing' | 'route_not_allowed' | 'invalid_query' }

/**
 * Comprueba que [routing] + [path] + [query] es una petición permitida y devuelve la regla y la
 * query en forma canónica (ordenada), que forma parte de la clave de caché.
 */
export function matchRoute(routing: string, path: string, query: Record<string, string>): MatchResult {
  const kind: RoutingKind | undefined = REGIONAL.has(routing) ? 'regional' : PLATFORMS.has(routing) ? 'platform' : undefined
  if (!kind) return { ok: false, reason: 'unknown_routing' }

  const rule = ROUTES.find((r) => r.kind === kind && r.pattern.test(path))
  if (!rule) return { ok: false, reason: 'route_not_allowed' }

  const entries = Object.entries(query)
  for (const [key, value] of entries) {
    const validate = rule.query?.[key]
    if (!validate || !validate(value)) return { ok: false, reason: 'invalid_query' }
  }
  const canonicalQuery = new URLSearchParams(entries.toSorted(([a], [b]) => a.localeCompare(b))).toString()
  return { ok: true, rule, canonicalQuery }
}
