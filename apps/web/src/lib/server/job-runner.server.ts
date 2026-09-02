/**
 * Drenaje de `app_private.job_queue` desde una función de la web.
 *
 * La aplicación lleva tiempo fabricando trabajos que nadie ejecutaba: no hay
 * worker desplegado, así que el calendario no se refrescaba solo y los PDF de
 * los recibos no se generaban. En vez de añadir un host —y un coste, y otra
 * superficie que endurecer— el planificador vive en la propia base: `pg_cron`
 * llama con `pg_net` a este endpoint cada pocos minutos y aquí se vacía lo que
 * haya. Los comandos exactos están en `docs/runbooks/planificador-cola.md`.
 *
 * Lo que NO hay aquí es lógica de trabajos: el catálogo de manejadores y el
 * reclamo de la cola son los mismos de `apps/worker` (`@housekeeper/worker/jobs`).
 * Este módulo aporta tres cosas que el demonio no necesitaba:
 *
 *   1. **Autenticación.** Un secreto compartido por cabecera, comparado en
 *      tiempo constante. Es la única puerta: el endpoint no tiene sesión.
 *   2. **Presupuesto de tiempo.** Una función de Vercel se corta sola (10 s en
 *      el plan gratuito). El bucle mira el reloj ENTRE trabajos y nunca dentro
 *      de uno: se para limpio y deja el resto para la pasada siguiente. Un
 *      trabajo empezado se termina o falla, jamás se abandona a medias.
 *   3. **Rescate de lo abandonado.** Si aun así la plataforma corta la función
 *      con un trabajo en vuelo, esa fila se queda en `running` y nadie volvería
 *      a mirarla. `reclaimStaleJobs` la devuelve a la cola pasado el arriendo,
 *      respetando el presupuesto de reintentos que ya existía.
 *
 * Reentrante por construcción: `claimNextJob` reclama con
 * `for update skip locked`, así que dos pasadas simultáneas —el cron que se
 * solapa, o el cron y el demonio a la vez— se reparten los trabajos y ninguno
 * ejecuta el mismo dos veces.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

import pg from 'pg';
import { env } from '$env/dynamic/private';

import {
  countReadyJobs,
  createJobHandlers,
  ensureCloseDueScheduled,
  ensureIcsSyncScheduled,
  ensurePruneDiscoveryScheduled,
  loadVapidConfig,
  reclaimStaleJobs,
  runOneJob,
  type JobHandler
} from '@housekeeper/worker/jobs';
import { createLogger, errorCode } from '@housekeeper/server';

import { createStorageBackend, type StorageBackend } from './attachment-deps.server';

const log = createLogger('web:jobs');

/** Cabecera con el secreto compartido que trae `pg_net`. */
export const JOB_RUNNER_TOKEN_HEADER = 'x-housekeeper-job-token';

/**
 * Cabecera legada, de cuando el proyecto se llamaba «Casa Clara». Se sigue
 * ACEPTANDO para siempre jamás hasta una migración operativa aparte: el
 * `pg_cron` ya programado en producción manda esta cabecera y no se puede
 * repuntar sin tocar el SQL del planificador (ver
 * docs/despliegue/identificadores-legado.md).
 */
export const LEGACY_JOB_RUNNER_TOKEN_HEADER = 'x-casa-clara-job-token';

/**
 * Presupuesto por omisión, en milisegundos. El plan gratuito de Vercel corta a
 * los 10 s: 8 s deja margen para cerrar la respuesta y, sobre todo, hace que el
 * caso normal —cola vacía o con dos o tres trabajos— termine mucho antes.
 */
export const DEFAULT_BUDGET_MS = 8_000;

export interface JobRunnerConfig {
  /** Cadena de conexión con el rol `casa_clara_worker` (WORKER_DATABASE_URL). */
  databaseUrl: string;
  token: string;
  budgetMs: number;
  maxAttempts: number;
  leaseMs: number | undefined;
  /**
   * Dónde se guardan los objetos que produce la cola (hoy, el PDF del recibo).
   * Es EL MISMO almacén que usan los adjuntos y lo elige la misma función, así
   * que Supabase Storage y S3 valen los dos y ninguno de los dos hay que
   * declararlo aquí por segunda vez.
   */
  storage: StorageBackend;
  /**
   * El entorno tal cual, para lo que el catálogo de trabajos necesite leer por
   * su cuenta —hoy, solo las claves VAPID de los avisos al móvil—. Se pasa
   * entero en vez de extraer aquí cada variable para que este módulo no tenga
   * que enterarse cada vez que un trabajo gana una opción.
   */
  environment: Partial<Record<string, string>>;
}

function positiveInteger(raw: string | undefined, fallback: number): number {
  const value = Number(raw?.trim());
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/**
 * Configuración del drenaje, o null si falta algo imprescindible.
 *
 * Exige TODO lo que necesita el catálogo entero de trabajos, no solo la base: un
 * drenaje a medias mandaría a `dead` los recibos por falta de almacén, y lo
 * haría en silencio. Sin configuración completa el endpoint responde 503 y la
 * cola espera intacta.
 *
 * Dos exigencias de más han tenido esta cola parada, y las dos por lo mismo:
 * pedir aquí, a mano, una configuración que en realidad ya no hacía falta o que
 * se declaraba de otra manera.
 *
 *  1. `SMTP_HOST` y `SMTP_FROM`. Sin remitente configurado el endpoint devolvía
 *     503 en cada pasada del cron y no se vaciaba nada —ni los recibos, ni la
 *     sincronización de calendarios, ni la poda—. Se fueron con la migración
 *     0029, que retiró la salida de correo entera: ya no queda ningún trabajo
 *     que la necesite, así que pedirla era bloquear la casa por una pieza que
 *     no existe.
 *  2. Las cuatro `S3_*`. El despliegue real guarda los adjuntos en Supabase
 *     Storage por su clave de servicio y no tiene credenciales S3 ningunas;
 *     exigirlas aquí dejaba la cola igual de parada, con el almacén perfectamente
 *     configurado al lado. El almacén ya no se declara dos veces: lo elige
 *     `createStorageBackend`, el mismo que usan los adjuntos, y admite los dos
 *     caminos.
 *
 * Lo que sí se sigue exigiendo es que HAYA almacén: un drenaje sin él mandaría
 * los recibos a `dead` en silencio, que es peor que no drenar.
 *
 * `WORKER_DATABASE_URL` y no `DATABASE_URL`: la cola solo la puede tocar el rol
 * `casa_clara_worker` (0005). El rol de la aplicación no tiene ni un GRANT
 * sobre `app_private.job_queue`, y así debe seguir.
 */
export function loadJobRunnerConfig(
  environment: Partial<Record<string, string>> = env
): JobRunnerConfig | null {
  const databaseUrl = environment.WORKER_DATABASE_URL?.trim();
  const token = environment.JOB_RUNNER_TOKEN?.trim();
  const storage = createStorageBackend(environment);
  if (!databaseUrl || !token || !storage) {
    return null;
  }
  return {
    databaseUrl,
    token,
    budgetMs: positiveInteger(environment.JOB_RUNNER_BUDGET_MS, DEFAULT_BUDGET_MS),
    // Mismo valor por omisión que el demonio (apps/worker/src/config.ts).
    maxAttempts: positiveInteger(environment.WORKER_MAX_JOB_ATTEMPTS, 5),
    // Sin declarar (o con un valor absurdo) manda el arriendo de la cola.
    leaseMs: positiveInteger(environment.JOB_RUNNER_LEASE_MS, 0) || undefined,
    storage,
    environment
  };
}

/**
 * Comparación en tiempo constante del secreto compartido.
 *
 * Se comparan los sha-256 y no las cadenas: `timingSafeEqual` exige longitudes
 * iguales —y lanzaría con un token de otro tamaño, que además filtraría la
 * longitud del bueno—, mientras que dos digests siempre miden 32 bytes.
 */
export function tokenMatches(presented: string | null, expected: string): boolean {
  if (presented === null || expected.length === 0) return false;
  const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();
  return timingSafeEqual(digest(presented), digest(expected));
}

export interface DrainOptions {
  handlers: Readonly<Record<string, JobHandler>>;
  maxAttempts: number;
  budgetMs: number;
  leaseMs?: number | undefined;
  /**
   * Si el barrido «el mes está por cerrar» (Frente D) debe re-armarse en esta
   * pasada. Solo tiene sentido —y solo tiene manejador registrado, ver
   * `registry.ts`— cuando hay canal de avisos: sin VAPID, `false`.
   */
  closeDueEnabled?: boolean;
  /** Reloj inyectable para pruebas deterministas. */
  now?: () => number;
}

export interface DrainOutcome {
  /** Trabajos ejecutados en esta pasada (completados o fallados con reintento). */
  ran: number;
  /** Trabajos listos que siguen esperando cuando la pasada termina. */
  remaining: number;
  /** Filas rescatadas de un ejecutor que desapareció: a la cola y a `dead`. */
  reclaimed: { requeued: number; dead: number };
  /** Por qué paró: `empty` (no quedaba nada) o `budget` (se acabó el tiempo). */
  stoppedBy: 'empty' | 'budget';
  elapsedMs: number;
  budgetMs: number;
}

/**
 * Vacía la cola hasta agotarla o hasta consumir el presupuesto.
 *
 * El reloj se mira SOLO entre trabajos. Es la diferencia entre parar limpio y
 * dejar la cola con una fila a medias: `runOneJob` reclama, ejecuta y cierra
 * (completado, reintento o `dead`) dentro de la misma llamada, así que cortar
 * entre dos llamadas no deja nada colgando.
 */
export async function drainJobQueue(pool: pg.Pool, options: DrainOptions): Promise<DrainOutcome> {
  const now = options.now ?? (() => Date.now());
  const startedAt = now();

  const reclaimed = await reclaimStaleJobs(pool, options.maxAttempts, options.leaseMs);

  // Las cadenas periódicas se re-arman aquí. En el demonio se hacía al
  // arrancar, pero una función serverless no «arranca»: si una cadena se rompe
  // (el último `ics.sync_all` acabó en `dead`, o el hogar es nuevo y nadie la
  // sembró), sin esto no vuelve a haber sincronización de calendarios, poda ni
  // barrido de cierre de mes nunca más. Todas son idempotentes y baratas: si ya
  // hay una pendiente, no hacen nada.
  //
  // Un fallo re-armando no puede impedir el drenaje —igual que en el demonio,
  // donde tampoco tumba el bucle—: queda en el log y la pasada sigue con lo que
  // ya estuviera encolado.
  const rearms = [ensurePruneDiscoveryScheduled, ensureIcsSyncScheduled];
  if (options.closeDueEnabled) rearms.push(ensureCloseDueScheduled);
  for (const rearm of rearms) {
    try {
      await rearm(pool);
    } catch (error) {
      log.warn('periodic chain could not be rearmed', { code: errorCode(error) });
    }
  }

  let ran = 0;
  let stoppedBy: 'empty' | 'budget' = 'budget';
  while (now() - startedAt < options.budgetMs) {
    const worked = await runOneJob(pool, options.handlers, options.maxAttempts);
    if (!worked) {
      stoppedBy = 'empty';
      break;
    }
    ran += 1;
  }

  return {
    ran,
    remaining: await countReadyJobs(pool),
    reclaimed,
    stoppedBy,
    elapsedMs: now() - startedAt,
    budgetMs: options.budgetMs
  };
}

let cachedPool: pg.Pool | null = null;
let cachedPoolUrl: string | null = null;

/**
 * Pool perezoso y reutilizado entre invocaciones calientes de la misma
 * instancia. `max: 2` a propósito: cada pasada es secuencial (un trabajo detrás
 * de otro) y las conexiones de Supabase son un recurso escaso compartido con la
 * aplicación entera; dos bastan para el reclamo transaccional más la consulta
 * de estado.
 */
function jobRunnerPool(databaseUrl: string): pg.Pool {
  if (cachedPool && cachedPoolUrl === databaseUrl) return cachedPool;
  cachedPool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  cachedPoolUrl = databaseUrl;
  return cachedPool;
}

export interface JobRunnerOverrides {
  config?: JobRunnerConfig | null;
  pool?: pg.Pool;
  handlers?: Readonly<Record<string, JobHandler>>;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  });
}

/**
 * El endpoint completo: autenticación, drenaje y respuesta.
 *
 * Vive fuera de `+server.ts` para poder ejercitarlo con una `Request` real
 * contra Postgres real (`apps/web/tests/job-runner.integration.test.ts`) sin
 * levantar SvelteKit.
 */
export async function runJobDrainRequest(
  request: Request,
  overrides: JobRunnerOverrides = {}
): Promise<Response> {
  const config = overrides.config === undefined ? loadJobRunnerConfig() : overrides.config;
  if (!config) {
    log.error('job runner not configured', { status: 503 });
    return jsonResponse(503, { error: 'job_runner_unavailable' });
  }
  // Se acepta la cabecera nueva Y la legada (nunca las dos leídas a la vez: la
  // que no venga es simplemente null y tokenMatches la rechaza igual).
  const presentedToken =
    request.headers.get(JOB_RUNNER_TOKEN_HEADER) ?? request.headers.get(LEGACY_JOB_RUNNER_TOKEN_HEADER);
  if (!tokenMatches(presentedToken, config.token)) {
    // Sin detalle: quien no trae el secreto no aprende nada de la respuesta.
    log.warn('job runner rejected an unauthenticated call', { status: 401 });
    return jsonResponse(401, { error: 'unauthorized' });
  }

  const pool = overrides.pool ?? jobRunnerPool(config.databaseUrl);
  const handlers =
    overrides.handlers ??
    createJobHandlers({
      pool,
      // El almacén no abre nada hasta el primer PUT: por el camino de Supabase
      // es HTTP y por el de S3 el SDK se importa bajo demanda. La pasada normal
      // no genera ningún PDF y no paga ninguna de las dos cosas.
      uploadDocument: (key, body, contentType) => config.storage.putObject(key, body, contentType),
      // Frente E: dónde queda anotado el recibo registrado. Es EL MISMO almacén
      // que sube el PDF, así que su bucket es el de este mismo `config.storage`.
      documentsBucket: config.storage.bucket,
      log,
      errorCode,
      // De aquí salen las claves VAPID. No entran en `loadJobRunnerConfig` —y
      // por tanto su ausencia NO devuelve 503— porque el drenaje sin avisos
      // sigue siendo un drenaje que hace falta: exigir aquí una variable de más
      // es exactamente lo que tuvo esta cola parada dos veces, con SMTP y con
      // las S3_*. Sin claves no se registra el manejador de avisos y no se
      // encola ninguno; todo lo demás se vacía igual.
      environment: config.environment
    });

  try {
    const outcome = await drainJobQueue(pool, {
      handlers,
      maxAttempts: config.maxAttempts,
      budgetMs: config.budgetMs,
      leaseMs: config.leaseMs,
      // Mismo criterio que el manejador (registry.ts): el barrido de cierre de
      // mes solo se re-arma cuando hay canal de avisos.
      closeDueEnabled: loadVapidConfig(config.environment) !== null
    });
    log.info('job queue drained', {
      counts: {
        ran: outcome.ran,
        remaining: outcome.remaining,
        requeued: outcome.reclaimed.requeued,
        dead: outcome.reclaimed.dead
      },
      ms: outcome.elapsedMs,
      status: 200
    });
    return jsonResponse(200, outcome);
  } catch (error) {
    // Un fallo aquí es de la cola, no de un trabajo: los de los trabajos ya los
    // absorbe `runOneJob` con sus reintentos. Se responde 503 para que el
    // planificador lo vea como lo que es y vuelva a intentarlo en el siguiente
    // turno; el cuerpo no lleva el mensaje, que puede arrastrar datos.
    log.error('job queue drain failed', { code: errorCode(error), status: 503 });
    return jsonResponse(503, { error: 'job_queue_unavailable' });
  }
}
