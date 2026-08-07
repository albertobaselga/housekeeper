import { defineConfig } from 'vitest/config';

// Solo la suite del importador; los tests SQL del esquema siguen en test:db.
export default defineConfig({
  test: {
    include: ['scripts/**/*.test.mjs'],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
