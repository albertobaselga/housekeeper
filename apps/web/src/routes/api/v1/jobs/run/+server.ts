import { runJobDrainRequest } from '$lib/server/job-runner.server';
import type { RequestHandler } from './$types';

/**
 * Vaciado de la cola de trabajos, disparado por el planificador de la base
 * (`pg_cron` + `pg_net`). Toda la lógica —autenticación por secreto compartido,
 * presupuesto de tiempo y drenaje— vive en `job-runner.server.ts`, que se puede
 * ejercitar con una `Request` real sin levantar SvelteKit.
 *
 * Solo POST: vaciar la cola tiene efectos, y un GET invitaría a que cualquier
 * cosa que siga enlaces lo dispare. Los comandos exactos del planificador están
 * en `docs/runbooks/planificador-cola.md`.
 */
export const POST: RequestHandler = ({ request }) => runJobDrainRequest(request);
