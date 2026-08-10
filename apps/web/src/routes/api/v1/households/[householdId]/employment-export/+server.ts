import { error } from '@sveltejs/kit';

import { membershipIn } from '$lib/auth/membership';
import { getDatabasePool } from '$lib/server/db.server';
import { buildEmploymentExport } from '$lib/server/employment-export.server';
import type { RequestHandler } from './$types';

/**
 * Descarga del expediente laboral de la propia empleada (AC-13). Es SU export:
 * el rol se comprueba aquí con la sesión y otra vez dentro del builder contra
 * la membresía RLS real; la familia, el apoyo o un visor reciben 403. Sin base
 * de datos no hay expediente (503): la fixture de demostración no es un
 * historial que exportar.
 */
export const GET: RequestHandler = async ({ locals, params }) => {
  if (!locals.user) error(401, 'Inicia sesión para continuar');
  const membership = membershipIn(locals.user, params.householdId);
  if (!membership) error(404, 'Hogar no encontrado');
  // Ser empleada en otra casa no da expediente en ésta.
  if (membership.role !== 'employee_live_in') {
    error(403, 'Solo la propia empleada puede descargar su expediente');
  }

  const pool = getDatabasePool();
  if (!pool) error(503, 'El expediente requiere la base de datos del hogar');

  const zip = await buildEmploymentExport({ id: locals.user.id }, params.householdId, pool);
  if (!zip) error(403, 'Solo la propia empleada puede descargar su expediente');

  return new Response(new Uint8Array(zip), {
    headers: {
      'content-type': 'application/zip',
      'content-disposition': 'attachment; filename="mi-expediente.zip"',
      'cache-control': 'no-store'
    }
  });
};
