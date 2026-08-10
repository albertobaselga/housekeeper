import { building } from '$app/environment';
import { env } from '$env/dynamic/private';

import { checkDeploymentConfig } from './deployment-config.js';
import type { DeploymentProblem } from './deployment-config.js';

/**
 * La regla indivisible de `deployment-config.js`, aplicada en el arranque del
 * servidor.
 *
 * ## Por qué también aquí, si ya está en la build
 *
 * Porque el paquete y su entorno se separan. Un `vercel deploy --prebuilt`, un
 * «Promote to Production» de un despliegue viejo o una variable retirada del
 * panel dejan corriendo un artefacto que se construyó bajo otras condiciones.
 * La build es la primera reja y la barata; ésta es la última y la que mira lo
 * que de verdad hay puesto cuando llega la primera petición.
 *
 * ## Por qué negarse aquí no deja a la casa fuera
 *
 * Se evalúa UNA vez, en el primer arranque, y sólo se activa en configuraciones
 * en las que ya no hay ningún acceso legítimo que perder: con `DATABASE_URL`
 * puesta y la identidad incompleta, `getAuth()` es nulo y ninguna persona de la
 * casa puede entrar con su contraseña. Lo único que la aplicación sabría hacer
 * en ese estado es servir cuentas de mentira sobre los datos de verdad. Negarse
 * no cierra una puerta buena: quita la única mala que quedaba.
 *
 * Y la reparación no vive dentro de la aplicación. Se arregla en el panel de
 * variables y con un despliegue, así que la persona que tiene que arreglarlo no
 * depende de poder entrar. Por eso la respuesta nombra las variables que faltan
 * una a una: para que sea una instrucción y no un muro.
 *
 * Sin `DATABASE_URL` este guardián no dice nada. El desarrollo local sin base y
 * las suites de maqueta no ven ninguna diferencia.
 */

let verdict: DeploymentProblem | null | undefined;

/**
 * Verdicto de arranque, calculado una sola vez por proceso. `null` = adelante.
 *
 * @param source       Sólo para pruebas: por omisión, el entorno de ejecución.
 * @param fixtureLogin Sólo para pruebas: por omisión, la forma de ESTE paquete.
 *   Se puede pasar a mano porque bajo vitest la constante siempre vale `true`
 *   (el banco de pruebas corre como servidor de desarrollo) y hay que poder
 *   ejercitar también el paquete de producción, que es el que importa.
 */
export function bootRefusal(
  source: Readonly<Record<string, string | undefined>> = env,
  fixtureLogin: boolean = __FIXTURE_LOGIN__
): DeploymentProblem | null {
  if (verdict !== undefined) return verdict;
  const check = checkDeploymentConfig({ env: source, fixtureLogin });
  verdict = check.problem;
  if (verdict) {
    // Una línea en el registro del arranque, para quien mire los logs antes que
    // la pantalla. El detalle completo va también en la respuesta.
    console.error(`[casa-clara] arranque rechazado (${verdict.code}): ${verdict.message}`);
  }
  return verdict;
}

/** Sólo para pruebas: olvida el verdicto memorizado. */
export function resetBootRefusal(): void {
  verdict = undefined;
}

/**
 * Respuesta única mientras dure la configuración incoherente. Texto llano a
 * propósito: no se renderiza la aplicación, porque la aplicación es justamente
 * lo que no debe servirse. Y `Cache-Control: no-store` para que ninguna capa
 * intermedia conserve esta página cuando las variables ya estén bien.
 */
export function refusalResponse(problem: DeploymentProblem): Response {
  const body = [
    'Casa Clara no está sirviendo esta casa ahora mismo.',
    '',
    'La configuración del despliegue está a medias, y a medias es peor que vacía:',
    'la aplicación prefiere no abrir a abrir una puerta que no es la de esta casa.',
    '',
    problem.message,
    ...(problem.missing.length > 0 ? ['', `Variables que faltan: ${problem.missing.join(', ')}`] : []),
    '',
    `(código: ${problem.code})`,
    ''
  ].join('\n');

  return new Response(body, {
    status: 503,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      // La reparación es humana (panel de variables + despliegue): un minuto de
      // espera para los reintentos automáticos, no un segundo.
      'retry-after': '60'
    }
  });
}

/** `true` cuando SvelteKit está construyendo y no hay entorno real que juzgar. */
export function skipDuringBuild(): boolean {
  return building;
}
