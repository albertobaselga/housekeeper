// El ÚNICO endpoint que parsea `dims` y `dupev` (contrato del doc de
// interfaces). Ambos se validan aquí y se devuelven junto a las filas: quien
// pinta el pivot (fase 6) llama después a buildPivotTree(rows, dims,
// { monthsCount: months.length, dupEventIds }).
import { error } from '@sveltejs/kit';
import { readFinancePivot, serializePivotRows } from '@housekeeper/server';

import { isUuid } from '$lib/finance/filters';
import { parseDims } from '$lib/finance/pivot-state';
import { financeRead, parseReadFilters } from '$lib/server/finance.server';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, url }) => {
  const dims = parseDims(url.searchParams.get('dims'));
  const dupEventIds = (url.searchParams.get('dupev') ?? '')
    .split(',')
    .map((piece) => piece.trim())
    .filter(Boolean);
  for (const id of dupEventIds) if (!isUuid(id)) error(400, 'Parámetro dupev inválido');
  return financeRead(locals, url, async (client, householdId) => {
    const { months, rows } = await readFinancePivot(client, householdId, parseReadFilters(url));
    // Los bigint no viajan por JSON: céntimos como cadena, como en todo el módulo.
    return { months, dims, dupEventIds, rows: serializePivotRows(rows) };
  });
};
