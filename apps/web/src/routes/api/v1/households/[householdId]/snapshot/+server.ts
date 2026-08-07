import { error, json } from '@sveltejs/kit';

import { getSnapshotKeys } from '$lib/server/keys.server';
import { buildCriticalSnapshot } from '$lib/server/snapshot.server';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ locals, params }) => {
  if (!locals.user) error(401, 'Inicia sesión para continuar');
  if (!locals.user.householdIds.includes(params.householdId)) error(404, 'Hogar no encontrado');

  return json(
    {
      snapshot: buildCriticalSnapshot(params.householdId, locals.user.membershipId),
      publicKey: getSnapshotKeys().publicKeyRaw
    },
    { headers: { 'cache-control': 'no-store' } }
  );
};
