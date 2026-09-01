import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import {
  FIXTURE_LOGIN_MARKERS,
  resolveFixtureLogin
} from '../src/lib/server/fixture-login-flag.js';

/**
 * `__FIXTURE_LOGIN__` decide en tiempo de COMPILACIÓN si el selector de cuentas
 * sintéticas viaja dentro del paquete. Las dos promesas que tiene que sostener
 * a la vez, y que se comprueban aquí:
 *
 * - el olvido cae del lado seguro (una build que no la declara no lleva el
 *   selector dentro);
 * - el desarrollo local sin base de datos no se rompe (el servidor de
 *   desarrollo sí lo lleva, sin exportar nada).
 *
 * La comprobación de que Rollup se lo lleva DE VERDAD no cabe en una prueba
 * unitaria: vive en `scripts/verify-fixture-login.mjs`, encadenado a la build,
 * y mira la salida real. Lo que sí se comprueba aquí es que ese guion busca
 * marcas que existen en el código.
 */

describe('resolveFixtureLogin: el olvido cae del lado seguro', () => {
  it('sin declarar, `vite build` deja el selector FUERA', () => {
    expect(resolveFixtureLogin({}, 'build')).toBe(false);
  });

  it('sin declarar, `vite dev` lo lleva: el modo local sin base sigue entrando', () => {
    expect(resolveFixtureLogin({}, 'serve')).toBe(true);
  });

  it('una variable vacía o en blanco es «sin declarar», no «sí»', () => {
    expect(resolveFixtureLogin({ HOUSEKEEPER_FIXTURE_LOGIN: '' }, 'build')).toBe(false);
    expect(resolveFixtureLogin({ HOUSEKEEPER_FIXTURE_LOGIN: '   ' }, 'build')).toBe(false);
  });
});

describe('resolveFixtureLogin: la declaración explícita manda', () => {
  it('"true" lo mete: es lo que piden las dos configuraciones de Playwright', () => {
    expect(resolveFixtureLogin({ HOUSEKEEPER_FIXTURE_LOGIN: 'true' }, 'build')).toBe(true);
  });

  it('"false" lo saca incluso del servidor de desarrollo', () => {
    // Sirve para comprobar en local cómo se comporta el paquete de producción.
    expect(resolveFixtureLogin({ HOUSEKEEPER_FIXTURE_LOGIN: 'false' }, 'serve')).toBe(false);
  });

  it('tolera mayúsculas y espacios alrededor, que es como se cuelan en un panel', () => {
    expect(resolveFixtureLogin({ HOUSEKEEPER_FIXTURE_LOGIN: ' TRUE ' }, 'build')).toBe(true);
    expect(resolveFixtureLogin({ HOUSEKEEPER_FIXTURE_LOGIN: 'False' }, 'serve')).toBe(false);
  });

  it('un valor que no es ni "true" ni "false" mata la build en vez de adivinar', () => {
    // Interpretar `1` como falso sería un fallo silencioso justo en la variable
    // que no los admite; interpretarlo como cierto sería peor.
    expect(() => resolveFixtureLogin({ HOUSEKEEPER_FIXTURE_LOGIN: '1' }, 'build')).toThrow(
      /HOUSEKEEPER_FIXTURE_LOGIN="1"/
    );
    expect(() => resolveFixtureLogin({ HOUSEKEEPER_FIXTURE_LOGIN: 'yes' }, 'build')).toThrow(
      /"true" o "false"/
    );
  });

  it('la variable renombrada revienta en voz alta en vez de leerse como «sin declarar»', () => {
    // CASA_CLARA_FIXTURE_LOGIN era el nombre anterior al renombrado del
    // proyecto. Si alguien la deja puesta en un panel de variables, el fallo
    // silencioso más peligroso sería tratarla como ausente y dejar el selector
    // fuera sin que nadie se entere de que la variable que cree haber puesto
    // no hace nada.
    expect(() => resolveFixtureLogin({ CASA_CLARA_FIXTURE_LOGIN: 'true' }, 'build')).toThrow(
      /CASA_CLARA_FIXTURE_LOGIN ya no existe; renombrada a HOUSEKEEPER_FIXTURE_LOGIN/
    );
  });
});

describe('las marcas que audita la build existen en el código', () => {
  /**
   * Sin esto, `verify-fixture-login.mjs` podría estar buscando cadenas que ya
   * no existen y pasar en verde para siempre. Cada marca se ancla a su fuente.
   */
  it.each([
    ['cc_demo_session', '../src/lib/server/session.server.ts'],
    ['listDemoUsers', '../src/lib/server/fixtures.server.ts'],
    ['getDemoUser', '../src/lib/server/fixtures.server.ts']
  ])('«%s» sigue estando en %s', async (marker, relative) => {
    const source = await readFile(new URL(relative, import.meta.url), 'utf8');
    expect(source).toContain(marker);
  });

  it('la lista de marcas es exactamente la que se ancló arriba', () => {
    expect(FIXTURE_LOGIN_MARKERS.map(({ text }) => text)).toEqual([
      'cc_demo_session',
      'listDemoUsers',
      'getDemoUser'
    ]);
  });

  it('cada marca explica qué demuestra su ausencia', () => {
    for (const marker of FIXTURE_LOGIN_MARKERS) {
      expect(marker.proves.length, marker.text).toBeGreaterThan(20);
    }
  });
});

describe('la constante llega compilada al código de servidor', () => {
  it('está definida como booleano, no como una lectura de process.env', () => {
    // Si `define` desapareciera de vite.config.ts, esto sería un ReferenceError.
    expect(typeof __FIXTURE_LOGIN__).toBe('boolean');
  });

  it('bajo vitest vale lo mismo que en el servidor de desarrollo', () => {
    expect(__FIXTURE_LOGIN__).toBe(resolveFixtureLogin(process.env, 'serve'));
  });
});
