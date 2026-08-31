/**
 * Resolución de `__FIXTURE_LOGIN__`, la constante de COMPILACIÓN que decide si
 * el paquete lleva dentro el selector de cuentas sintéticas.
 *
 * Está en JavaScript llano a propósito: la lee `vite.config.ts` (que se evalúa
 * antes de que exista ninguna transformación de TypeScript del proyecto) y la
 * leen las pruebas. Una sola fuente de verdad, sin copiarla en dos sitios.
 *
 * La regla, y por qué está en este orden:
 *
 * 1. `HOUSEKEEPER_FIXTURE_LOGIN=true` → dentro. Es la ÚNICA forma de meter el
 *    selector en un paquete construido, y hay exactamente dos consumidores
 *    legítimos: las dos configuraciones de Playwright.
 * 2. `HOUSEKEEPER_FIXTURE_LOGIN=false` → fuera, incluso en el servidor de
 *    desarrollo. Sirve para comprobar en local cómo se comporta el paquete de
 *    producción.
 * 3. Cualquier otro valor → error. Un `HOUSEKEEPER_FIXTURE_LOGIN=1` que se
 *    interpretase como «falso» sería un fallo silencioso justo en la variable
 *    que no admite fallos silenciosos; y uno que se interpretase como «cierto»
 *    sería peor.
 * 4. Sin declarar → `vite dev` lo lleva, `vite build` no.
 *
 * El punto 4 es el que sostiene las dos promesas a la vez. Olvidar la variable
 * en Vercel deja el selector FUERA (el olvido cae del lado seguro), y el
 * desarrollo local sin base de datos —que es como corren las suites de
 * maqueta— sigue arrancando con las cinco cuentas de siempre sin que nadie
 * tenga que exportar nada.
 *
 * `CASA_CLARA_FIXTURE_LOGIN` era el nombre anterior (renombrado con el
 * proyecto). Declararla hoy es casi seguro un despliegue con el nombre viejo
 * que dejaría el selector fuera en silencio, así que se rechaza en voz alta en
 * vez de ignorarla.
 *
 * @param {Readonly<Record<string, string | undefined>>} env
 * @param {'build' | 'serve'} command  El `command` que Vite pasa a defineConfig.
 * @returns {boolean}
 */
export function resolveFixtureLogin(env, command) {
  if ((env.CASA_CLARA_FIXTURE_LOGIN ?? '').trim() !== '') {
    throw new Error('CASA_CLARA_FIXTURE_LOGIN ya no existe; renombrada a HOUSEKEEPER_FIXTURE_LOGIN');
  }
  const declared = (env.HOUSEKEEPER_FIXTURE_LOGIN ?? '').trim().toLowerCase();
  if (declared === 'true') return true;
  if (declared === 'false') return false;
  if (declared !== '') {
    throw new Error(
      `HOUSEKEEPER_FIXTURE_LOGIN="${env.HOUSEKEEPER_FIXTURE_LOGIN}" no es un valor válido; usa "true" o "false"`
    );
  }
  return command !== 'build';
}

/**
 * Marcas textuales del camino de cuentas sintéticas en el servidor construido.
 * `verify-fixture-login.mjs` las busca sobre la salida de la build, de modo que
 * «no está en el paquete» sea una comprobación y no una confianza depositada en
 * el sacudido de árbol de Rollup.
 *
 * Cada marca nombra la propiedad que su ausencia demuestra. Entre las tres
 * cubren las dos únicas formas que tenía un identificador sintético de llegar a
 * `locals.user.id` y de ahí a `set_config('app.user_id', …)`: acuñar la sesión
 * y volver a leerla.
 *
 * Se busca sobre la salida de servidor de SvelteKit, que NO va minificada: los
 * nombres de función sobreviven tal cual. Si algún día se minificara, la mitad
 * «tiene que estar» de la comprobación fallaría y lo diría en voz alta, que es
 * justo lo que se quiere de una comprobación que se comprueba a sí misma.
 *
 * Fuera de esta lista queda a propósito `fixture:roble:`. Esos identificadores
 * siguen en el paquete porque `getSettingsFixture()` los lleva dentro, y ese es
 * el camino de maquetas de las páginas (la degradación silenciosa a datos
 * inventados), no la puerta de acceso. Poner aquí una marca que hoy no puede
 * estar limpia convertiría este guion en un fallo permanente que alguien
 * acabaría desactivando.
 */
export const FIXTURE_LOGIN_MARKERS = /** @type {const} */ ([
  {
    text: 'cc_demo_session',
    proves: 'la cookie de sesión de maqueta; sin ella nada puede acuñar ni leer una sesión sintética'
  },
  {
    text: 'listDemoUsers',
    proves: 'el censo de cuentas sintéticas que alimentaba el selector de /login'
  },
  {
    text: 'getDemoUser',
    proves: 'la resolución de un identificador sintético a un principal con hogar y rol'
  }
]);
