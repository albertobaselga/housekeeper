import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

import { resolveFixtureLogin } from './src/lib/server/fixture-login-flag.js';

export default defineConfig(({ command }) => ({
  plugins: [sveltekit()],
  define: {
    // Constante de COMPILACIÓN, no condición de ejecución: con el valor `false`
    // Rollup se lleva por delante la acción `demo` de /login, la rama de sesión
    // de maqueta del hook y la lista de cuentas, y el servidor desplegado deja
    // de contener código capaz de emitir una sesión sintética. Se comprueba
    // sobre la salida de la build en scripts/verify-fixture-login.mjs.
    __FIXTURE_LOGIN__: JSON.stringify(resolveFixtureLogin(process.env, command))
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Evidencia JUnit para CI (assert-junit-nonempty.py) sin tocar la salida normal.
    reporters: ['default', 'junit'],
    outputFile: { junit: '../../artifacts/unit/web.xml' }
  }
}));
