import { error, json } from '@sveltejs/kit';

import { loadSnapshotContacts } from '$lib/server/contacts.server';
import { getSnapshotKeys } from '$lib/server/keys.server';
import { buildCriticalSnapshot, loadSnapshotHousehold } from '$lib/server/snapshot.server';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, params }) => {
  if (!locals.user) error(401, 'Inicia sesión para continuar');
  if (!locals.user.householdIds.includes(params.householdId)) error(404, 'Hogar no encontrado');

  // Con pool el contenido del snapshot es el real del hogar (RLS): contactos,
  // menú de hoy, rutinas que vencen y notas fijadas de la Guía. Sin pool la
  // demo conserva la fixture sintética.
  const [snapshotContacts, snapshotHousehold] = await Promise.all([
    loadSnapshotContacts({ id: locals.user.id }, params.householdId),
    loadSnapshotHousehold({ id: locals.user.id }, params.householdId)
  ]);

  return json(
    {
      snapshot: buildCriticalSnapshot(
        params.householdId,
        locals.user.membershipId,
        snapshotContacts,
        snapshotHousehold
      ),
      publicKey: getSnapshotKeys().publicKeyRaw
    },
    { headers: { 'cache-control': 'no-store' } }
  );
};
