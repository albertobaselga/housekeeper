/**
 * Guarda del entorno solo-sintético (control 9 del baseline).
 *
 * `ALLOW_SYNTHETIC_DATA_ONLY=true` declara que este despliegue solo puede
 * contener datos ficticios (staging sintético, CI de navegador). Ese flag se
 * lee UNA vez por petición en hooks.server.ts y viaja por layout data hasta el
 * banner del AppShell.
 *
 * El antiguo `demoPasswordBlocked()` desapareció con el selector de cuentas
 * demo por contraseña: ya no existe ese modo. Sin base de datos de identidad
 * solo queda el selector de fixtures, y solo en local (login/+page.server.ts).
 *
 * Las funciones aceptan el entorno como parámetro (por defecto `process.env`,
 * que con adapter-node es exactamente lo que expone `$env/dynamic/private`)
 * para que las pruebas unitarias ejerciten ambos estados sin mutar globals.
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
