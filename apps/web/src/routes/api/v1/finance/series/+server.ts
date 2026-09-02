import { error } from '@sveltejs/kit';
import { readFinanceSeries } from '@housekeeper/server';

import { isGranularity } from '$lib/finance/filters';
import { financeRead, intParam, parseReadFilters } from '$lib/server/finance.server';
import type { RequestHandler } from './$types';

// m11: la validación propia vive DENTRO del closure de `financeRead`, como ya
// hacen `transactions` y `pivot` con `parseReadFilters` — así un anónimo
// recibe el 401 de `requireFinanceRequest` en vez de un 400 que se adelanta
// al guard de sesión/hogar.
export const GET: RequestHandler = async ({ locals, url }) =>
  financeRead(locals, url, (client, householdId) => {
    const granularityParam = url.searchParams.get('g') ?? 'month';
    if (!isGranularity(granularityParam)) error(400, 'Parámetro g inválido');
    // El tope es 240 meses: con g=year, 12 cubos son 120 meses (ver SERIES_MONTHS
    // en finance.server.ts). Un tope de 60 dejaría fuera la vista anual.
    // months: cantidad de puntos de la serie temporal, nunca céntimos.
    // Política 'reject' (m1): mismo comportamiento visible que antes (400 fuera de 1–240).
    const months = intParam(url, 'months', 12, 1, 240, { onOutOfRange: 'reject' });
    return readFinanceSeries(client, householdId, parseReadFilters(url), granularityParam, months);
  });
