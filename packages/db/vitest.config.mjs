import { defineConfig } from 'vitest/config';

// Solo la suite del importador; los tests SQL del esquema siguen en test:db.
export default defineConfig({
  test: {
    include: ['scripts/**/*.test.mjs'],
    testTimeout: 30000,
    hookTimeout: 30000,
    // Las suites del importador y del corpus del manual comparten
    // TEST_DATABASE_URL y recrean el esquema: en secuencia, nunca en paralelo.
    fileParallelism: false,
  },
});
