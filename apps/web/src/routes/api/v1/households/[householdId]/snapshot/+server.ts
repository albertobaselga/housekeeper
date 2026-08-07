import { error, json } from '@sveltejs/kit';

import { loadSnapshotContacts } from '$lib/server/contacts.server';
import { getSnapshotKeys } from '$lib/server/keys.server';
import { buildCriticalSnapshot } from '$lib/server/snapshot.server';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, params }) => {
  if (!locals.user) error(401, 'Inicia sesión para continuar');
  if (!locals.user.householdIds.includes(params.householdId)) error(404, 'Hogar no encontrado');

  // Con pool los contactos del snapshot son los reales del hogar (RLS);
  // sin pool la demo conserva la fixture sintética.
  const snapshotContacts = await loadSnapshotContacts({ id: locals.user.id }, params.householdId);

  return json(
    {
      snapshot: buildCriticalSnapshot(params.householdId, locals.user.membershipId, snapshotContacts),
      publicKey: getSnapshotKeys().publicKeyRaw
    },
    { headers: { 'cache-control': 'no-store' } }
  );
};
