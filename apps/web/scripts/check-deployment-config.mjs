#!/usr/bin/env node
/**
 * Guardián de configuración, encadenado ANTES de `vite build`.
 *
 * Fallar aquí es gratis: el despliegue anterior de Vercel sigue sirviendo la
 * casa mientras alguien corrige las variables, y la configuración mala nunca
 * llega a producción. Es el mismo patrón que ya usa el worker
 * (`apps/worker/src/config.ts`), llevado al único momento del ciclo en el que
 * negarse no le quita el acceso a nadie.
 *
 * Distingue tres desenlaces a propósito:
 *
 * - **Incoherente** (base sí, identidad no; el selector dentro de un paquete de
 *   producción; el cartel de solo-sintético en producción) → la build muere.
 * - **Vacío** (ninguna variable de base) → aviso ruidoso, pero la build sigue.
 *   Un despliegue sin base no tiene nada real que filtrar: sin el selector
 *   dentro no hay cuentas de mentira ni datos de mentira, sólo una casa que
 *   todavía no tiene dentro. Matar la build aquí bloquearía el despliegue de
 *   arranque, que es exactamente el que hay que poder hacer.
 * - **Completo** → silencio, salvo un resumen de una línea.
 */
import { argv, env, exit } from 'node:process';
import { fileURLToPath } from 'node:url';

import { checkDeploymentConfig, missingDurabilityVars } from '../src/lib/server/deployment-config.js';
import { resolveFixtureLogin } from '../src/lib/server/fixture-login-flag.js';

/**
 * @typedef {object} BuildVerdict
 * @property {'fail' | 'warn' | 'ok'} level
 * @property {string[]} lines
 */

/**
 * @param {Readonly<Record<string, string | undefined>>} environment
 * @returns {BuildVerdict}
 */
export function inspectBuildEnvironment(environment) {
  const fixtureLogin = resolveFixtureLogin(environment, 'build');
  const vercelProduction = (environment.VERCEL_ENV ?? '').trim() === 'production';
  const hasDatabase = (environment.DATABASE_URL ?? '').trim() !== '';

  /** @type {string[]} */
  const fatal = [];
  /** @type {string[]} */
  const warnings = [];

  // La misma regla que aplicará el servidor, evaluada aquí primero. Se le pasa
  // VERCEL_ENV tal cual: en Vercel la build de producción ya lo trae puesto.
  const check = checkDeploymentConfig({ env: environment, fixtureLogin });
  if (!check.ok && check.problem) fatal.push(check.problem.message);

  // Dos rechazos que sólo tienen sentido en la build, porque hablan de con qué
  // se está construyendo y no de con qué se está sirviendo.
  if (vercelProduction && fixtureLogin) {
    fatal.push(
      'No se construye producción con CASA_CLARA_FIXTURE_LOGIN=true. Esa variable mete el selector de cuentas ' +
        'sintéticas dentro del paquete; sin declararla, `vite build` ya lo deja fuera.'
    );
  }
  if (vercelProduction && environment.ALLOW_SYNTHETIC_DATA_ONLY !== undefined) {
    fatal.push(
      'ALLOW_SYNTHETIC_DATA_ONLY está definida en una build de producción. En producción no se define: ' +
        'ni siquiera a "false", para que nadie la lea como una opción que se pueda cambiar.'
    );
  }

  // El aviso sólo tiene sentido si la ausencia de base es una SORPRESA. En un
  // paquete construido con el selector dentro no lo es: ése es su estado
  // normal, y avisar allí sería ruido en cada `pnpm build` de las suites de
  // maqueta, que es la mejor forma de enseñar a la gente a no leer los avisos.
  if (!hasDatabase && !fixtureLogin) {
    warnings.push(
      'Sin DATABASE_URL: este paquete se servirá sin datos. Es un estado seguro pero inútil para una casa real; ' +
        'si esperabas que hubiera base, revisa las variables antes de promocionar el despliegue.'
    );
  }

  const durability = missingDurabilityVars(environment);
  if (durability.length > 0) {
    warnings.push(
      `Hay base de datos pero falta ${durability.join(', ')}: los snapshots firmados se firmarán con una clave ` +
        'efímera por proceso y dejarán de validar entre arranques en frío. No impide servir, pero rompe el modo ' +
        'sin conexión en cuanto haya más de una instancia.'
    );
  }

  if (fatal.length > 0) return { level: 'fail', lines: fatal };
  if (warnings.length > 0) return { level: 'warn', lines: warnings };
  return {
    level: 'ok',
    lines: [
      `Configuración coherente: base ${hasDatabase ? 'sí' : 'no'}, selector sintético ${fixtureLogin ? 'dentro' : 'fuera'}.`
    ]
  };
}

function main() {
  /** @type {BuildVerdict} */
  let verdict;
  try {
    verdict = inspectBuildEnvironment(env);
  } catch (cause) {
    // resolveFixtureLogin rechaza valores que no son "true" ni "false".
    console.error(`\nLa build no puede continuar:\n  - ${String(cause instanceof Error ? cause.message : cause)}\n`);
    return 1;
  }

  if (verdict.level === 'fail') {
    console.error(
      ['', 'La build de Casa Clara se detiene por configuración incoherente:', ...verdict.lines.map((l) => `  - ${l}`), ''].join(
        '\n'
      )
    );
    console.error(
      'Nadie se ha quedado fuera por esto: el despliegue anterior sigue sirviendo mientras se corrigen las variables.\n'
    );
    return 1;
  }

  for (const line of verdict.lines) {
    if (verdict.level === 'warn') console.warn(`Aviso de configuración: ${line}`);
    else console.log(line);
  }
  return 0;
}

if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) {
  exit(main());
}
