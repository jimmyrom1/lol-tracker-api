-- Respuestas de Riot reutilizables. Una fila por petición canónica (enrutado + ruta + query).
CREATE TABLE riot_cache (
    cache_key  text        PRIMARY KEY,
    route      text        NOT NULL,
    -- Solo se guardan respuestas válidas y "no existe"; los errores nunca se cachean.
    status     smallint    NOT NULL CHECK (status IN (200, 404)),
    -- Texto tal cual lo devuelve Riot: el cliente recibe exactamente los mismos bytes.
    body       text        NOT NULL,
    fetched_at timestamptz NOT NULL,
    -- NULL = no caduca nunca (una partida jugada no cambia).
    expires_at timestamptz,
    CHECK (expires_at IS NULL OR expires_at > fetched_at)
);

-- Para la limpieza periódica de lo caducado, sin recorrer las partidas (que no caducan).
CREATE INDEX riot_cache_expires_at ON riot_cache (expires_at) WHERE expires_at IS NOT NULL;
