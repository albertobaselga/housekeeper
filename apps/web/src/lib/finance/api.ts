/**
 * Cliente de las lecturas REST de finanzas (§7). Solo lecturas: toda escritura
 * va por comandos de /api/v1/sync (fase 5). Los tipos DTO se importan SOLO
 * como tipos del paquete servidor: se borran al compilar y nada de
 * @housekeeper/server llega al navegador.
 */
import type {
  AnalyticsRow,
  FinanceCategoryRowDto,
  FinanceEventDetailDto,
  FinanceEventSummaryDto,
  FinancePivotRowDto,
  FinanceProviderRowDto,
  FinanceSeriesPointDto,
  FinanceSummaryDto,
  FinanceTransactionsPage,
  FinanceTxDto
} from '@housekeeper/server';
import type { PivotDimension } from '@housekeeper/domain/finance';

import { apiQuery, type FinanceFilters } from './filters';
import { serializeDims } from './pivot-state';

export class FinanceApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'FinanceApiError';
  }
}

/** Modo de apertura del panel de detalle (§8: ids / grupo / movimiento). */
export type FinanceDetailMode =
  | { kind: 'movimiento'; tx: FinanceTxDto }
  | { kind: 'ids'; ids: string[]; label: string; sub?: string | null }
  | { kind: 'grupo'; groupId: string; label: string };

async function getJson<T>(fetchFn: typeof fetch, path: string, params: URLSearchParams): Promise<T> {
  const response = await fetchFn(`/api/v1/finance/${path}?${params}`);
  if (!response.ok) {
    // El cuerpo puede traer el motivo (código de dominio, límite excedido…);
    // si no hay cuerpo legible, el status ya es información suficiente.
    const detail = await response.text().catch(() => '');
    throw new FinanceApiError(response.status, detail || `GET /api/v1/finance/${path} → ${response.status}`);
  }
  try {
    return (await response.json()) as T;
  } catch {
    // Un 200 con cuerpo no-JSON (redirección de sesión, error de plataforma)
    // no debe escapar como SyntaxError crudo: unifica el contrato de error.
    throw new FinanceApiError(response.status, 'respuesta no válida');
  }
}

export function financeApi(householdId: string, fetchFn: typeof fetch = fetch) {
  const withHousehold = (params: URLSearchParams): URLSearchParams => {
    params.set('household', householdId);
    return params;
  };
  const base = (filters: FinanceFilters): URLSearchParams => withHousehold(apiQuery(filters));
  return {
    summary: (filters: FinanceFilters, excludeEventIds: string[] = []): Promise<FinanceSummaryDto> => {
      const params = base(filters);
      if (excludeEventIds.length > 0) params.set('exev', excludeEventIds.join(','));
      return getJson(fetchFn, 'summary', params);
    },
    // months: cantidad de puntos de la serie temporal, nunca céntimos.
    series: (filters: FinanceFilters, months = 12): Promise<FinanceSeriesPointDto[]> => {
      const params = base(filters);
      params.set('g', filters.granularity);
      params.set('months', String(months));
      return getJson(fetchFn, 'series', params);
    },
    breakdown: (filters: FinanceFilters): Promise<FinanceCategoryRowDto[]> => getJson(fetchFn, 'breakdown', base(filters)),
    // limit: tope de filas del ranking de proveedores, nunca céntimos.
    providers: (filters: FinanceFilters, limit = 10): Promise<FinanceProviderRowDto[]> => {
      const params = base(filters);
      params.set('limit', String(limit));
      return getJson(fetchFn, 'providers', params);
    },
    analytics: (filters: FinanceFilters): Promise<{ rows: AnalyticsRow[] }> =>
      getJson(fetchFn, 'analytics', base(filters)),
    pivot: (
      filters: FinanceFilters,
      dims: readonly PivotDimension[] = [],
      dupEventIds: string[] = []
    ): Promise<{ months: string[]; dims: PivotDimension[]; dupEventIds: string[]; rows: FinancePivotRowDto[] }> => {
      const params = base(filters);
      // serializeDims devuelve null para el orden por defecto: la URL se queda limpia.
      const serialized = dims.length > 0 ? serializeDims(dims) : null;
      if (serialized) params.set('dims', serialized);
      if (dupEventIds.length > 0) params.set('dupev', dupEventIds.join(','));
      return getJson(fetchFn, 'pivot', params);
    },
    transactions: (filters: FinanceFilters, extra: Record<string, string> = {}): Promise<FinanceTransactionsPage> => {
      const params = base(filters);
      for (const [key, value] of Object.entries(extra)) if (value) params.set(key, value);
      return getJson(fetchFn, 'transactions', params);
    },
    // Precondición para el handler de `transactions`: `ids`/`group_ids` vacíos
    // deben leerse como «sin coincidencias», nunca como «sin filtro» (el cliente
    // no fabrica aquí una página vacía porque no conoce la forma canónica de
    // `FinanceTransactionsPage` que decida el propio handler).
    transactionsByIds: (ids: string[]): Promise<FinanceTransactionsPage> =>
      getJson(fetchFn, 'transactions', withHousehold(new URLSearchParams({ ids: ids.join(',') }))),
    transactionsByGroups: (groupIds: string[]): Promise<FinanceTransactionsPage> =>
      getJson(fetchFn, 'transactions', withHousehold(new URLSearchParams({ group_ids: groupIds.join(',') }))),
    eventsSummary: (filters: FinanceFilters): Promise<FinanceEventSummaryDto[]> => getJson(fetchFn, 'events-summary', base(filters)),
    // El id viaja en el PATH, no por URLSearchParams (que escapa solo): hay que
    // codificarlo a mano para que un id con `/`, `?` o `#` no cambie de recurso.
    eventDetail: (id: string, filters: FinanceFilters): Promise<FinanceEventDetailDto> =>
      getJson(fetchFn, `events/${encodeURIComponent(id)}`, base(filters))
  };
}
