import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 60000,
    // Integration tests each launch a browser; run files sequentially and in
    // child processes (tree-sitter's native binding is not worker-thread safe).
    fileParallelism: false,
    pool: 'forks',
  },
})
