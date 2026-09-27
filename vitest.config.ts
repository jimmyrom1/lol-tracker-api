import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Los tests comparten una base de datos PostgreSQL real: se ejecutan de uno en uno.
    fileParallelism: false,
    testTimeout: 15_000,
  },
})
