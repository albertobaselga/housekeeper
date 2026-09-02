import { error } from '@sveltejs/kit';
import { readFinanceSeries } from '@housekeeper/server';

import { financeRead, parseReadFilters } from '$lib/server/finance.server';
import type { RequestHandler } from './$types';

function isGranularity(value: string): value is 'month' | 'quarter' | 'year' {
  return value === 'month' || value === 'quarter' || value === 'year';
}

export const GET: RequestHandler = async ({ locals, url }) => {
  const granularityParam = url.searchParams.get('g') ?? 'month';
  if (!isGranularity(granularityParam)) error(400, 'Parámetro g inválido');
  // El tope es 240 meses: con g=year, 12 cubos son 120 meses (ver SERIES_MONTHS
  // en finance.server.ts). Un tope de 60 dejaría fuera la vista anual.
  const months = Number(url.searchParams.get('months') ?? '12');
  if (!Number.isInteger(months) || months < 1 || months > 240) error(400, 'Parámetro months inválido');
  return financeRead(locals, url, (client, householdId) =>
    readFinanceSeries(client, householdId, parseReadFilters(url), granularityParam, months));
};
