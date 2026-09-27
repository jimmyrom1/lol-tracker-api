import pg from 'pg'

export type Db = pg.Pool

export function createPool(connectionString: string): Db {
  return new pg.Pool({ connectionString, max: 10 })
}
