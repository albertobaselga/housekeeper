import { error } from '@sveltejs/kit';

import { belongsToHousehold } from '$lib/auth/membership';
import { getDatabasePool } from '$lib/server/db.server';
import { buildSettlementDocument } from '$lib/server/settlement-document.server';
import type { RequestHandler } from './$types';

/**
 * El documento de pago de una cuenta, en PDF y generado al momento. Quién
 * puede verlo lo decide RLS en `buildSettlementDocument`; sin fila, 404, sin
 * distinguir «no existe» de «no te toca» (misma disciplina que los
 * justificantes).
 */
export const GET: RequestHandler = async ({ locals, params, setHeaders }) => {
  if (!locals.user) error(401, 'Inicia sesión para ver el documento de pago');
  if (!belongsToHousehold(locals.user, params.householdId)) error(404, 'Hogar no encontrado');
  // Un identificador que ni siquiera tiene forma de uuid es un 404 directo:
  // dejarlo llegar a Postgres convertía cada URL malformada en un 503 con su
  // línea de registro, y eso es un grifo de ruido abierto a cualquiera.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(params.settlementId)) {
    error(404, 'Esa cuenta no está disponible');
  }
  // Sin base de datos no hay cuenta que servir, y decir 404 mentiría un
  // borrado: mismo 503 honesto que la exportación del expediente.
  if (!getDatabasePool()) error(503, 'El documento de pago requiere la base de datos del hogar');

  const document = await buildSettlementDocument(
    { id: locals.user.id },
    params.householdId,
    params.settlementId
  );
  if (!document) error(404, 'Esa cuenta no está disponible');

  setHeaders({ 'cache-control': 'private, no-store' });
  return new Response(new Uint8Array(document.pdf), {
    headers: {
      'content-type': 'application/pdf',
      // Se descarga con nombre propio: es el documento que se guarda o se
      // manda, no una página que mirar.
      'content-disposition': `attachment; filename="${document.filename}"`,
      'content-length': String(document.pdf.length),
      // Sin antivirus delante, la red de seguridad de servir un fichero desde
      // nuestro origen: `nosniff` impide reinterpretar los bytes y el sandbox
      // deja el documento sin origen. Ver docs/security/adjuntos-sin-antivirus.md.
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox; frame-ancestors 'none'"
    }
  });
};
