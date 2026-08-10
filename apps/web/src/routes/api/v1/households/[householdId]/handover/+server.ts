import { error } from '@sveltejs/kit';

import { membershipIn } from '$lib/auth/membership';
import { getDatabasePool } from '$lib/server/db.server';
import { buildHandoverExport, type HandoverAudience } from '$lib/server/handover.server';
import type { RequestHandler } from './$types';

/**
 * Descarga del traspaso operativo (F4-02). Solo la administración del hogar:
 * el rol se comprueba aquí con la sesión y otra vez dentro del builder contra
 * la membresía RLS real. Sin base de datos no hay traspaso (503): la fixture
 * de demostración no es un hogar que traspasar.
 */
export const GET: RequestHandler = async ({ locals, params, url }) => {
  if (!locals.user) error(401, 'Inicia sesión para continuar');
  const membership = membershipIn(locals.user, params.householdId);
  if (!membership) error(404, 'Hogar no encontrado');
  // Administrar OTRA casa no administra ésta: el papel se lee de la membresía
  // de este hogar.
  if (membership.role !== 'family_admin') error(403, 'Solo la administración del hogar puede descargar el traspaso');

  const pool = getDatabasePool();
  if (!pool) error(503, 'El traspaso requiere la base de datos del hogar');

  const audience: HandoverAudience = url.searchParams.get('audience') === 'family' ? 'family' : 'helper';
  const zip = await buildHandoverExport({ id: locals.user.id }, params.householdId, audience, pool);
  if (!zip) error(403, 'Solo la administración del hogar puede descargar el traspaso');

  return new Response(new Uint8Array(zip), {
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="traspaso-${audience}.zip"`,
      'cache-control': 'no-store'
    }
  });
};
