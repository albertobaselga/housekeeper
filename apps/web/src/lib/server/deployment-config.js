/**
 * La regla indivisible de configuración de esta instalación.
 *
 * El peligro que cierra este módulo es concreto y está medido: el selector de
 * cuentas sintéticas no dependía de `DATABASE_URL`, sino de `DATABASE_AUTH_URL`
 * y `BETTER_AUTH_SECRET`. Existía por tanto una configuración alcanzable por
 * descuido —base real puesta, identidad a medias— en la que la aplicación
 * seguía sirviendo cuentas de mentira que operan sobre los datos de la casa
 * real bajo RLS. La mitad de la configuración era peor que ninguna.
 *
 * De ahí la regla: **base e identidad entran juntas o no entra ninguna.**
 *
 * Está en JavaScript llano porque la aplican dos sitios y tiene que ser la
 * misma regla en los dos:
 *
 * - `scripts/check-deployment-config.mjs`, ANTES de `vite build`. Es el momento
 *   barato: una build que falla no deja a nadie fuera, porque el despliegue
 *   anterior sigue sirviendo y la configuración mala nunca llega a producción.
 * - `src/hooks.server.ts`, en el arranque del servidor. Es la red de abajo,
 *   para el caso en que el paquete llegue a un entorno cuyas variables no son
 *   las que había cuando se construyó (un `vercel deploy --prebuilt`, un
 *   «Promote to Production» de un despliegue antiguo, una variable retirada del
 *   panel).
 *
 * ## Cómo evita esto dejar la casa fuera
 *
 * Tres decisiones, todas deliberadas:
 *
 * 1. **La regla sólo se despierta si hay base de datos.** Sin `DATABASE_URL` no
 *    hay nada real que proteger y no hay nada que exigir: el desarrollo local y
 *    las suites de maqueta arrancan exactamente igual que antes.
 * 2. **La negativa no quita ningún acceso que existiera.** En el estado que
 *    rechaza —base sí, identidad no— `getAuth()` es nulo, `/api/auth` responde
 *    404 y NADIE puede entrar con su contraseña. No hay puerta buena que cerrar:
 *    lo único que la aplicación sabría hacer en ese estado es lo que no debe.
 * 3. **La reparación nunca está dentro de la aplicación.** Se arregla en el
 *    panel de variables y con un despliegue, así que quien tiene que arreglarlo
 *    no depende de poder entrar. Por eso el mensaje nombra las variables que
 *    faltan, una a una: es una instrucción, no un lamento.
 *
 * `SNAPSHOT_SIGNING_KEY_B64` queda deliberadamente FUERA de la negativa de
 * ejecución y sólo se avisa en la build. Su ausencia no abre ninguna puerta:
 * genera una clave efímera por proceso, lo que rompe la caducidad de los
 * snapshots entre arranques en frío. Es un fallo de durabilidad, no de
 * identidad, y tumbar la casa por él sería desproporcionado.
 */

/** Variable que declara que hay datos reales detrás. */
export const DATABASE_VAR = 'DATABASE_URL';

/**
 * Las que tienen que acompañarla siempre. Sin las tres no hay entrada con
 * contraseña, que es la única entrada legítima.
 */
export const IDENTITY_VARS = /** @type {const} */ ([
  'DATABASE_AUTH_URL',
  'BETTER_AUTH_SECRET',
  'BETTER_AUTH_URL'
]);

/** Variables que la build exige además, pero por las que no se tumba el servicio. */
export const DURABILITY_VARS = /** @type {const} */ (['SNAPSHOT_SIGNING_KEY_B64']);

const LOCAL_HOSTNAMES = ['localhost', '127.0.0.1', '::1', '[::1]'];

/**
 * @typedef {object} DeploymentProblem
 * @property {'synthetic-flag-in-production'
 *   | 'fixture-bundle-in-production'
 *   | 'fixture-bundle-with-database'
 *   | 'incomplete-identity'
 *   | 'insecure-auth-url'} code
 * @property {string[]} missing  Variables que faltan, en el orden de IDENTITY_VARS.
 * @property {string} message    Texto listo para leer, con lo que falta nombrado.
 */

/**
 * @typedef {object} DeploymentCheck
 * @property {boolean} ok
 * @property {DeploymentProblem | null} problem
 */

/** @param {Readonly<Record<string, string | undefined>>} env @param {string} key */
function present(env, key) {
  return (env[key] ?? '').trim() !== '';
}

/**
 * `true` si la URL base de identidad es defendible: https en cualquier sitio, o
 * http contra un nombre local (la demo y las suites arrancan así).
 * @param {string} value
 */
function isDefensibleBaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol === 'https:') return true;
  return parsed.protocol === 'http:' && LOCAL_HOSTNAMES.includes(parsed.hostname);
}

/**
 * Aplica la regla indivisible.
 *
 * @param {object} input
 * @param {Readonly<Record<string, string | undefined>>} input.env
 * @param {boolean} input.fixtureLogin  Valor de `__FIXTURE_LOGIN__` en este paquete.
 * @returns {DeploymentCheck}
 */
export function checkDeploymentConfig({ env, fixtureLogin }) {
  const onVercel = present(env, 'VERCEL');
  const vercelProduction = (env.VERCEL_ENV ?? '').trim() === 'production';
  const hasDatabase = present(env, DATABASE_VAR);

  // 1. Un despliegue que se declara solo-sintético no puede SER producción.
  //    El cartel pasa a costar el despliegue si miente (ver synthetic.server.ts).
  if (env.ALLOW_SYNTHETIC_DATA_ONLY === 'true' && vercelProduction) {
    return problem(
      'synthetic-flag-in-production',
      [],
      'Este despliegue declara ALLOW_SYNTHETIC_DATA_ONLY=true, que significa «aquí no hay datos reales», ' +
        'y a la vez es el despliegue de producción (VERCEL_ENV=production). Las dos cosas no pueden ser ' +
        'ciertas. Retira ALLOW_SYNTHETIC_DATA_ONLY del entorno de producción y vuelve a desplegar.'
    );
  }

  // 2. Un paquete construido con el selector dentro no es un paquete de
  //    producción, aunque alguien lo suba ya construido.
  if (fixtureLogin && vercelProduction) {
    return problem(
      'fixture-bundle-in-production',
      [],
      'Este paquete se construyó con HOUSEKEEPER_FIXTURE_LOGIN=true, es decir, lleva dentro el selector de ' +
        'cuentas sintéticas, y se está sirviendo como producción. Vuelve a construir sin esa variable: ' +
        'sin declararla, `vite build` deja el selector fuera.'
    );
  }
  if (fixtureLogin && hasDatabase && onVercel) {
    return problem(
      'fixture-bundle-with-database',
      [],
      'Este paquete lleva dentro el selector de cuentas sintéticas y tiene DATABASE_URL configurada en un ' +
        'despliegue de Vercel: sería un selector de cuentas de mentira sobre datos reales, en una URL pública. ' +
        'Esa combinación sólo se admite fuera de la plataforma (batería e2e con base de datos, en local o en CI).'
    );
  }

  // 3. La regla indivisible propiamente dicha. Sólo se despierta con base.
  if (hasDatabase && !fixtureLogin) {
    const missing = IDENTITY_VARS.filter((key) => !present(env, key));
    if (missing.length > 0) {
      return problem(
        'incomplete-identity',
        missing,
        `Hay base de datos configurada (${DATABASE_VAR}) pero la identidad está a medias: falta ` +
          `${listWithAnd(missing)}. Con la identidad incompleta nadie puede entrar con su contraseña, así que ` +
          'esta instalación prefiere no servir nada antes que servir una puerta que no es la suya. Define ' +
          `${missing.length === 1 ? 'esa variable' : 'esas variables'} —o retira ${DATABASE_VAR}— y vuelve a desplegar.`
      );
    }

    const baseUrl = (env.BETTER_AUTH_URL ?? '').trim();
    if (!isDefensibleBaseUrl(baseUrl)) {
      return problem(
        'insecure-auth-url',
        ['BETTER_AUTH_URL'],
        `BETTER_AUTH_URL vale «${baseUrl}», que no es una dirección https ni un nombre local. Las cookies de ` +
          'sesión de la casa no pueden viajar por ahí. Escribe la dirección https real del hogar y vuelve a desplegar.'
      );
    }
  }

  return { ok: true, problem: null };
}

/**
 * Variables que la build exige además de la regla indivisible, y que sólo se
 * avisan: su ausencia degrada los snapshots firmados, no la identidad.
 *
 * @param {Readonly<Record<string, string | undefined>>} env
 * @returns {string[]}
 */
export function missingDurabilityVars(env) {
  if (!present(env, DATABASE_VAR)) return [];
  return DURABILITY_VARS.filter((key) => !present(env, key));
}

/**
 * @param {DeploymentProblem['code']} code
 * @param {string[]} missing
 * @param {string} message
 * @returns {DeploymentCheck}
 */
function problem(code, missing, message) {
  return { ok: false, problem: { code, missing: [...missing], message } };
}

/** @param {readonly string[]} items */
function listWithAnd(items) {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} y ${items[items.length - 1]}`;
}
