import { error } from '@sveltejs/kit';
import { readFinanceEventDetail } from '@housekeeper/server';

import { isUuid } from '$lib/finance/filters';
import { financeRead, parseReadFilters } from '$lib/server/finance.server';
import type { RequestHandler } from './$types';

// m11: `isUuid(params.id)` se valida DENTRO del closure de `financeRead`
// (antes, antes de llamarlo). Con esto: anónimo -> 401 de
// `requireFinanceRequest` (nunca ve el id); no autorizado -> 404 «Hogar no
// encontrado» (requireFinanceAdmin corta antes de llegar aquí); autorizado
// con id malformado -> 404 «Evento no encontrado», el mensaje específico de
// esta ruta.
export const GET: RequestHandler = async ({ locals, url, params }) =>
  financeRead(locals, url, async (client, householdId) => {
    if (!isUuid(params.id)) error(404, 'Evento no encontrado');
    const detail = await readFinanceEventDetail(client, householdId, params.id, parseReadFilters(url));
    if (!detail) error(404, 'Evento no encontrado');
    return detail;
  });
