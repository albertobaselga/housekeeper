import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { sveltekit } from '@sveltejs/kit/vite';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

import { resolveFixtureLogin } from './src/lib/server/fixture-login-flag.js';

/**
 * Deja escrito, tras cada construcción del cliente, qué módulo fuente aporta
 * cuántos bytes a cada trozo: `.svelte-kit/casa-clara-module-map.json`.
 *
 * No viaja al despliegue (vive fuera de `output/`) y no cuesta nada en `dev`.
 * Existe porque el presupuesto de arranque de Hoy se mide en bytes de FICHERO y
 * el troceo de rolldown reparte por alcanzabilidad de módulo: sin este mapa, un
 * trozo que engorda es un misterio y averiguar quién lo llena cuesta varias
 * construcciones a ciegas. `scripts/verify-today-bundle.mjs` lo usa para señalar
 * al culpable y para vigilar la matriz de capacidades.
 */
function clientModuleMap(): Plugin {
  return {
    name: 'casa-clara:client-module-map',
    apply: 'build',
    async writeBundle(options, bundle) {
      const directory = (options.dir ?? '').replaceAll('\\', '/');
      if (!directory.endsWith('.svelte-kit/output/client')) return;
      const appRoot = path.resolve(directory, '../../..');
      const map: Record<string, Record<string, number>> = {};
      for (const [fileName, output] of Object.entries(bundle)) {
        if (output.type !== 'chunk') continue;
        const modules: Record<string, number> = {};
        for (const [id, rendered] of Object.entries(output.modules ?? {})) {
          const bytes = rendered?.renderedLength ?? 0;
          if (bytes <= 0) continue;
          modules[path.relative(appRoot, id).replaceAll('\\', '/')] = bytes;
        }
        map[fileName] = modules;
      }
      const target = path.resolve(directory, '../../casa-clara-module-map.json');
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, `${JSON.stringify(map, null, 1)}\n`);
    }
  };
}

export default defineConfig(({ command }) => ({
  plugins: [sveltekit(), clientModuleMap()],
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
