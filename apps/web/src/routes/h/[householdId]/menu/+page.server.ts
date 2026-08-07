import { isIsoDate, mondayOf } from '$lib/food/dates';
import { loadMenuWeek, loadShoppingList } from '$lib/server/food.server';
import { getMenuFixture } from '$lib/server/fixtures.server';
import type { PageServerLoad } from './$types';

const MADRID_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' });

export const load: PageServerLoad = async ({ locals, params, url }) => {
  const today = MADRID_DATE.format(new Date());
  const requested = url.searchParams.get('week');
  const monday = mondayOf(requested && isIsoDate(requested) ? requested : today);
  // Día pedido explícitamente (la navegación de semanas lo arrastra para
  // conservar el día de la semana activo); si no, la página abre en hoy.
  const requestedDay = url.searchParams.get('day');
  const day = requestedDay && isIsoDate(requestedDay) ? requestedDay : null;

  const week = locals.user ? await loadMenuWeek({ id: locals.user.id }, params.householdId, monday) : null;
  if (week) {
    const shopping = await loadShoppingList({ id: locals.user!.id }, params.householdId, monday);
    return { week, shopping, today, day, menu: null };
  }
  // Sin base de datos (o sin membresía autorizada) la demo conserva la fixture.
  return { week: null, shopping: null, today, day: null, menu: getMenuFixture() };
};
