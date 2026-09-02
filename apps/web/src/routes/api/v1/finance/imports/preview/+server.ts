import { error, isHttpError, json } from '@sveltejs/kit';

import { AuthorizationError, CommandRejectedError, FinanceParserError, createLogger, errorCode } from '@housekeeper/server';

import { MAX_IMPORT_BYTES, previewImport } from '$lib/server/finance-imports.server';
import { DATA_UNAVAILABLE_MESSAGE, DATA_UNAVAILABLE_STATUS } from '$lib/server/data-source.server';
import { requireFinanceRequest } from '$lib/server/finance.server';
import type { RequestHandler } from './$types';

const log = createLogger('web:finance-imports');

/**
 * El guard del hook no cubre /api. Sesión, hogar, membresía y pool los resuelve
 * `requireFinanceRequest` (fase 4) con sus códigos; aquí solo se añade lo que es
 * propio de una escritura multipart.
 */
export const POST: RequestHandler = async ({ locals, request, url }) => {
  const origin = request.headers.get('origin');
  if (origin && origin !== url.origin) error(403, 'Origen no permitido');
  const { user, householdId, pool } = requireFinanceRequest(locals, url);

  // Tope de tamaño ANTES de tocar el cuerpo: mismo criterio que el adjunto
  // (`content-length` declarado, no el real, que aún no se ha leído).
  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (declaredLength > MAX_IMPORT_BYTES) {
    error(413, `El extracto supera el máximo de ${Math.round(MAX_IMPORT_BYTES / 1024 / 1024)} MB`);
  }

  const form = await request.formData().catch(() => null);
  if (!form) error(400, 'No se pudo leer el fichero');
  const file = form.get('file');
  if (!(file instanceof File)) error(422, 'No llegó ningún fichero');
  if (file.size > MAX_IMPORT_BYTES) {
    error(413, `El extracto supera el máximo de ${Math.round(MAX_IMPORT_BYTES / 1024 / 1024)} MB`);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());

  try {
    const preview = await previewImport(user, householdId, bytes, file.name, pool);
    return json({ apiVersion: 1, ...preview }, { headers: { 'cache-control': 'no-store' } });
  } catch (cause) {
    if (cause instanceof FinanceParserError) error(422, cause.message);
    // Sin membresía o sin concesión: 404, como en las lecturas de la fase 4.
    if (cause instanceof AuthorizationError) error(404, 'Hogar no encontrado');
    if (cause instanceof CommandRejectedError) error(404, 'Hogar no encontrado');
    if (isHttpError(cause)) throw cause;
    // Simetría con `financeRead` (finance.server.ts): un fallo inesperado no
    // sale como 500 pelado y sin rastro, sale como el mismo 503 honesto.
    log.error('finance import unavailable', { code: errorCode(cause) });
    error(DATA_UNAVAILABLE_STATUS, DATA_UNAVAILABLE_MESSAGE);
  }
};
