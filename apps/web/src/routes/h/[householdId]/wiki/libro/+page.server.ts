import { error, redirect } from '@sveltejs/kit';

import { loadGuideBook } from '$lib/server/wiki.server';
import type { PageServerLoad } from './$types';

/**
 * Portada del modo libro: no tiene pantalla propia porque no hace falta. Lleva
 * directamente a por dónde toca seguir —la primera nota pendiente, o la
 * primera del libro si ya está entera leída— para que «Leer la guía» sea un
 * solo gesto.
 */
export const load: PageServerLoad = async ({ locals, params, depends }) => {
  depends('cc:wiki');
  const base = `/h/${encodeURIComponent(params.householdId)}/wiki`;
  const book = locals.user ? await loadGuideBook({ id: locals.user.id }, params.householdId, null) : null;

  if (!book) redirect(303, base);
  if (book.kind === 'redirect') redirect(303, `${base}/libro/${encodeURIComponent(book.slug)}`);
  if (book.kind === 'empty') {
    error(404, 'La guía de esta casa todavía no tiene ninguna nota publicada.');
  }
  redirect(303, base);
};
