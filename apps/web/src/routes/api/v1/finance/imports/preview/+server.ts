import { error, json } from '@sveltejs/kit';

import { AuthorizationError, CommandRejectedError, FinanceParserError } from '@housekeeper/server';

import { previewImport } from '$lib/server/finance-imports.server';
import { requireFinanceRequest } from '$lib/server/finance.server';
import type { RequestHandler } from './$types';

/**
 * El guard del hook no cubre /api. Sesión, hogar, membresía y pool los resuelve
 * `requireFinanceRequest` (fase 4) con sus códigos; aquí solo se añade lo que es
 * propio de una escritura multipart.
 */
export const POST: RequestHandler = async ({ locals, request, url }) => {
  const origin = request.headers.get('origin');
  if (origin && origin !== url.origin) error(403, 'Origen no permitido');
  const { user, householdId, pool } = requireFinanceRequest(locals, url);

  const form = await request.formData().catch(() => null);
  if (!form) error(400, 'No se pudo leer el fichero');
  const file = form.get('file');
  if (!(file instanceof File)) error(422, 'No llegó ningún fichero');
  const bytes = new Uint8Array(await file.arrayBuffer());

  try {
    const preview = await previewImport(user, householdId, bytes, file.name, pool);
    return json({ apiVersion: 1, ...preview }, { headers: { 'cache-control': 'no-store' } });
  } catch (cause) {
    if (cause instanceof FinanceParserError) error(422, cause.message);
    // Sin membresía o sin concesión: 404, como en las lecturas de la fase 4.
    if (cause instanceof AuthorizationError) error(404, 'Hogar no encontrado');
    if (cause instanceof CommandRejectedError) error(404, 'Hogar no encontrado');
    throw cause;
  }
};
