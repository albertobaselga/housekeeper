/**
 * `ALLOW_SYNTHETIC_DATA_ONLY` — control 9 del baseline.
 *
 * ## Qué era
 *
 * Un cartel. Se leía una vez por petición, viajaba por los datos de layout y
 * terminaba pintando un párrafo en el AppShell. No gobernaba ninguna decisión
 * de autorización, de escritura, de envío ni el selector de login. Con datos
 * reales dentro no protegía absolutamente nada y, peor, seguía afirmando en un
 * banner permanente que allí no había datos reales.
 *
 * ## Qué debe hacer, y por qué eso
 *
 * Lo primero es reconocer lo que esta variable NO puede hacer nunca en la web:
 * **no puede distinguir un dato real de uno inventado**. Nadie puede, desde
 * dentro del proceso. Un guardián que pretenda «impedir que entren datos
 * reales» es necesariamente teatro, y el teatro en una casilla de seguridad es
 * peor que la casilla vacía, porque alguien lo tacha en una lista.
 *
 * Lo que sí es: **una afirmación que el despliegue hace sobre sí mismo**. Dice
 * «yo no soy la casa de nadie». Y una afirmación sí se puede convertir en
 * cerrojo, del único modo honesto: **haciendo que sea cara si es falsa**.
 *
 * De ahí la decisión, en tres piezas:
 *
 * 1. **Declararla y ser producción son incompatibles, y gana la negativa.**
 *    Con `VERCEL_ENV=production`, un despliegue que lleve esta variable no
 *    arranca: responde 503 diciendo exactamente esa contradicción
 *    (`deployment-config.js`, código `synthetic-flag-in-production`). Colarla en
 *    producción ya no sirve un banner mentiroso sobre la casa de EG112: tumba
 *    el despliegue antes de servir nada. El fallo pasa de silencioso y
 *    permanente a ruidoso e inmediato, que es la única mejora que importa.
 *
 * 2. **La build de producción la rechaza por existir**, no por su valor
 *    (`scripts/check-deployment-config.mjs`). Ni siquiera a `"false"`: una
 *    variable presente en el panel es una variable que alguien puede cambiar un
 *    martes por la tarde, y la ausencia es el único estado que no se puede
 *    voltear por accidente. Así el rechazo llega en la build, donde no le
 *    cuesta el acceso a nadie, y el 503 del punto 1 queda como red de abajo.
 *
 * 3. **El banner se queda, y ahora dice la verdad.** Es lo único que la web
 *    puede aportar de verdad a una persona que esté delante: avisarle de que lo
 *    que ve no es su casa. Antes era una afirmación sin respaldo; ahora hay
 *    código que impide que se pronuncie donde sería falsa.
 *
 * Además pasa a ser **comprobable desde fuera**: `/api/health` publica
 * `synthetic`, de modo que «verificar que no está definida en producción» es un
 * `curl` y no un inicio de sesión y una inspección visual.
 *
 * ## Lo que se deja fuera a propósito
 *
 * No se le cuelga ninguna prohibición de escritura ni de exportación. Staging
 * es un entorno de pruebas de la aplicación entera: prohibirle escribir lo
 * volvería inútil, y una variable que hay que apagar para trabajar acaba
 * apagada en todas partes. El único cerrojo *de datos* que esta variable tiene
 * y merece seguir teniendo es el del worker, que rechaza cualquier destinatario
 * de correo fuera de los TLD reservados (`apps/worker/src/integrations.ts`):
 * ahí sí hay algo concreto que sale del sistema y se puede parar.
 *
 * ## Para Casa EG112
 *
 * No se define. Ni a `true` ni a `false`. Ver
 * `docs/despliegue/runbook-despliegue.md`.
 *
 * Las funciones aceptan el entorno como parámetro (por omisión `process.env`,
 * que con adapter-node es exactamente lo que expone `$env/dynamic/private`)
 * para que las pruebas ejerciten ambos estados sin mutar globals.
 */

export interface SyntheticGuard {
  /** true solo si el flag vale literalmente 'true'. */
  readonly syntheticOnly: boolean;
}

type EnvSource = Readonly<Record<string, string | undefined>>;

export function syntheticGuard(env: EnvSource = process.env): SyntheticGuard {
  return { syntheticOnly: env.ALLOW_SYNTHETIC_DATA_ONLY === 'true' };
}

/** Hostnames considerados locales para el arranque de sesiones demo. */
export function isLocalHostname(hostname: string): boolean {
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname);
}

/** Texto único del banner persistente del entorno sintético. */
export const SYNTHETIC_BANNER_TEXT = 'Entorno sintético: no introduzcas datos reales';
