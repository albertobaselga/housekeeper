import { env } from '$env/dynamic/private';
import { error, isHttpError } from '@sveltejs/kit';
import { AuthorizationError, errorCode, type Logger } from '@casa-clara/server';

/**
 * La regla de la casa: CON BASE DE DATOS CONFIGURADA, LAS MAQUETAS NO EXISTEN.
 *
 * Este módulo es el único sitio donde se decide si una pantalla puede caer a
 * datos de demostración, y la respuesta es «solo si este despliegue no tiene
 * hogar real detrás». La razón es literal y no teórica: mientras el fallback a
 * fixtures se disparaba ante *cualquier* fallo de lectura, un corte de la base
 * hacía que la pantalla de Emergencias del hogar real enseñara teléfonos e
 * instrucciones inventados —sin ningún aviso— a quien estuviera solo en casa
 * buscando a quién llamar (auditoría §R2).
 *
 * De aquí salen tres piezas:
 *
 * 1. `databaseConfigured()` / `fixturesAllowed()`: la condición, en un sitio.
 * 2. `unreadable()`: el `catch` compartido de los cargadores. Separa «no te
 *    toca» (AuthorizationError, que es un 403/404 legítimo y sigue devolviendo
 *    null) de «no hemos podido leer» (infraestructura), que sale como 503 con
 *    su registro en vez de colapsarse en un null indistinguible.
 * 3. `demoOnly()`: envoltorio de cada maqueta. Con base configurada la maqueta
 *    ya no es que no se use: es que no se puede obtener. Si una ruta olvidara
 *    la guarda, revienta con un error explícito en vez de mentir en silencio.
 * 4. `demoOrUnavailable()`: la rama de maqueta de un `load`, con la regla
 *    dentro, para que ninguna página tenga que acordarse de escribirla.
 */

type EnvSource = Readonly<Record<string, string | undefined>>;

/** Mensaje llano, único, de «no hemos podido leer los datos de la casa». */
export const DATA_UNAVAILABLE_MESSAGE =
  'Ahora mismo no podemos leer los datos de la casa. Vuelve a intentarlo en un momento.';

/**
 * ¿Hay hogar real detrás de este despliegue? Es exactamente la condición que
 * usa `getDatabasePool()` para abrir el pool, leída aquí sin abrirlo.
 */
export function databaseConfigured(source: EnvSource = env): boolean {
  return (source.DATABASE_URL ?? '').trim() !== '';
}

/** Complemento legible de la anterior: sin base, y solo sin base, hay maqueta. */
export function fixturesAllowed(source: EnvSource = env): boolean {
  return !databaseConfigured(source);
}

/** Código HTTP del «no hemos podido leer»: temporal, reintentable, honesto. */
export const DATA_UNAVAILABLE_STATUS = 503;

/**
 * ¿Este fallo es el «no hemos podido leer los datos de la casa»? Lo usan los
 * pocos sitios que tienen una alternativa segura y deben seguir pintando —el
 * layout del hogar y Emergencias— en vez de tumbar la pantalla entera.
 */
export function isDataUnavailable(cause: unknown): boolean {
  return isHttpError(cause) && cause.status === DATA_UNAVAILABLE_STATUS;
}

/**
 * Se pidió una maqueta en un despliegue que tiene hogar real. Es un fallo de
 * programación, no una condición de ejecución: por eso lleva el nombre de la
 * maqueta y no un mensaje de cara al público.
 */
export class FixturesForbiddenError extends Error {
  override readonly name = 'FixturesForbiddenError';

  constructor(fixture: string) {
    super(
      `La maqueta «${fixture}» se pidió con DATABASE_URL configurada. Con base de datos ` +
        'las maquetas no existen: usa los datos reales o un error honesto.'
    );
  }
}

/**
 * `catch` compartido de los cargadores. Devuelve null SOLO cuando la causa es
 * de autorización (membresía inexistente, revocada o caducada), que la página
 * traduce a 403/404. Cualquier otra causa se registra con su código estable y
 * sale como 503: un fallo de infraestructura no puede seguir pareciendo un
 * hogar vacío, porque «vacío» es justo lo que abría la puerta a la maqueta.
 */
export function unreadable(log: Logger, scope: string, cause: unknown): null {
  if (cause instanceof AuthorizationError) return null;
  // Un error HTTP ya decidido más adentro (un 404 de nota inexistente, por
  // ejemplo) es una respuesta pensada: pasa tal cual, no se disfraza de avería.
  if (isHttpError(cause)) throw cause;
  log.error(`${scope} unavailable`, { code: errorCode(cause) });
  error(DATA_UNAVAILABLE_STATUS, DATA_UNAVAILABLE_MESSAGE);
}

/**
 * Rama de maqueta de un `load`, en una línea y con la regla dentro: la maqueta
 * solo se construye si este despliegue no tiene hogar real. Con base de datos
 * configurada esto es un 503 registrado, nunca una casa inventada.
 */
export function demoOrUnavailable<T>(build: () => T): T {
  if (!fixturesAllowed()) error(DATA_UNAVAILABLE_STATUS, DATA_UNAVAILABLE_MESSAGE);
  return build();
}

/**
 * Envuelve el constructor de una maqueta para que solo exista sin base de
 * datos. El nombre viaja al error para que el sitio olvidado se identifique
 * sin depurar.
 */
export function demoOnly<Args extends unknown[], Result>(
  fixture: string,
  build: (...args: Args) => Result
): (...args: Args) => Result {
  return (...args: Args): Result => {
    if (databaseConfigured()) throw new FixturesForbiddenError(fixture);
    return build(...args);
  };
}
