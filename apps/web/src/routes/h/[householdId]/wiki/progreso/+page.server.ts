import { error } from '@sveltejs/kit';

import { loadGuideProgress } from '$lib/server/wiki.server';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params, depends }) => {
  depends('cc:wiki');
  const progress = locals.user
    ? await loadGuideProgress({ id: locals.user.id }, params.householdId)
    : null;
  // Sin base de datos (demo con fixture) no hay progreso real que enseñar.
  if (!progress) error(404, 'El avance de la guía necesita los datos reales de la casa.');
  return { progress };
};
