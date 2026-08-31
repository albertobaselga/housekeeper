import { error } from '@sveltejs/kit';

import { belongsToHousehold } from '$lib/auth/membership';
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
