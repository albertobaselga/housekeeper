import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [sveltekit()],
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Evidencia JUnit para CI (assert-junit-nonempty.py) sin tocar la salida normal.
    reporters: ['default', 'junit'],
    outputFile: { junit: '../../artifacts/unit/web.xml' }
  }
});
