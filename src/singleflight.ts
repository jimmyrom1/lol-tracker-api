/**
 * Si llegan varias peticiones iguales mientras la primera todavía está en curso, todas esperan a
 * esa misma promesa. Diez jugadores que abren la misma partida a la vez = una petición a Riot.
 */
export class SingleFlight<T> {
  private readonly inFlight = new Map<string, Promise<T>>()

  /** `shared` es true para quien se ha subido a una petición que ya estaba en marcha. */
  async run(key: string, task: () => Promise<T>): Promise<{ value: T; shared: boolean }> {
    const existing = this.inFlight.get(key)
    if (existing) return { value: await existing, shared: true }

    const promise = task().finally(() => this.inFlight.delete(key))
    this.inFlight.set(key, promise)
    return { value: await promise, shared: false }
  }

  get size(): number {
    return this.inFlight.size
  }
}
