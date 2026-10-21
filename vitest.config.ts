import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    setupFiles: ['dotenv/config'],
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
