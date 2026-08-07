import { isIsoDate, mondayOf } from '$lib/food/dates';
import { loadMenuWeek, loadShoppingList } from '$lib/server/food.server';
import { getMenuFixture } from '$lib/server/fixtures.server';
import type { PageServerLoad } from './$types';

const MADRID_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' });

export const load: PageServerLoad = async ({ locals, params, url }) => {
  const requested = url.searchParams.get('week');
  const monday = mondayOf(requested && isIsoDate(requested) ? requested : MADRID_DATE.format(new Date()));

  const week = locals.user ? await loadMenuWeek({ id: locals.user.id }, params.householdId, monday) : null;
  if (week) {
    const shopping = await loadShoppingList({ id: locals.user!.id }, params.householdId, monday);
    return { week, shopping, menu: null };
  }
  // Sin base de datos (o sin membresía autorizada) la demo conserva la fixture.
  return { week: null, shopping: null, menu: getMenuFixture() };
};
