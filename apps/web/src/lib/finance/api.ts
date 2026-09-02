/**
 * Cliente de las lecturas REST de finanzas (§7). Solo lecturas: toda escritura
 * va por comandos de /api/v1/sync (fase 5). Los tipos DTO se importan SOLO
 * como tipos del paquete servidor: se borran al compilar y nada de
 * @housekeeper/server llega al navegador.
 *
 * [T12-R1, despacho de cierre F5] También expone `isRecord` y las guardas de
 * forma de las dos respuestas de importación (`isFinanceImportPreview`,
 * `isFinanceImportConfirmResult`): son utilidades puras sin red propia — las
 * dos rutas de `imports/{preview,confirm}` son REST, no lecturas de este
 * cliente, pero viven aquí para que `importar/+page.svelte` no repita un
 * guard sin `as` (R7) y para que su unidad de prueba tenga un módulo `.ts`
 * importable desde vitest (el repo no tiene `@testing-library/svelte`).
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

/**
 * [T12-R1, despacho de cierre F5] Guarda de narrowing sin `as` (R7): un
 * `value is T` genérico deja que el llamador elija el tipo esperado sin que
 * la función finja verificar su FORMA completa — `getJson` es genérico sobre
 * DTOs muy distintos (varios de ellos arrays, p. ej. `series`/`breakdown`),
 * así que el único caso real a descartar aquí es que el cuerpo del JSON sea
 * `null`/`undefined` o un primitivo (número, cadena, booleano): lo que de
 * verdad puede llegar en una redirección de sesión o un error de plataforma
 * con un 200. Un objeto con la forma equivocada sigue sin detectarse aquí —
 * para eso están las guardas de forma completa como `isFinanceImportPreview`
 * en `importar/+page.svelte`, que sí conocen sus campos.
 */
export function isRecord<T = Record<string, unknown>>(value: unknown): value is T {
  return typeof value === 'object' && value !== null;
}

/** Forma de la previsualización de `POST /api/v1/finance/imports/preview`. */
export interface FinanceImportPreviewDto {
  bank: string;
  newCount: number;
  dupCount: number;
  unknownRefs: string[];
  sample: Array<{ opDate: string; concept: string; provider: string | null; amountCents: string }>;
}

/**
 * A diferencia de `isRecord`, esta guarda SÍ conoce los campos: un objeto
 * bien formado pero vacío, o con un campo del tipo equivocado, también cae —
 * el caso real de una redirección de sesión que devuelve `{}` con 200 (o de
 * un cambio de contrato del servidor que ninguna prueba de tipos detecta
 * porque el cast que sustituye era precisamente el problema, T12-R1).
 */
export function isFinanceImportPreview(value: unknown): value is FinanceImportPreviewDto {
  return (
    isRecord(value) &&
    typeof value.bank === 'string' &&
    typeof value.newCount === 'number' &&
    typeof value.dupCount === 'number' &&
    Array.isArray(value.unknownRefs) &&
    Array.isArray(value.sample)
  );
}

/** Forma de la respuesta de `POST /api/v1/finance/imports/confirm`. */
export interface FinanceImportConfirmResultDto {
  newCount: number;
  dupCount: number;
}

export function isFinanceImportConfirmResult(value: unknown): value is FinanceImportConfirmResultDto {
  return isRecord(value) && typeof value.newCount === 'number' && typeof value.dupCount === 'number';
}

async function getJson<T>(fetchFn: typeof fetch, path: string, params: URLSearchParams): Promise<T> {
  const response = await fetchFn(`/api/v1/finance/${path}?${params}`);
  if (!response.ok) {
    // El cuerpo puede traer el motivo (código de dominio, límite excedido…);
    // si no hay cuerpo legible, el status ya es información suficiente.
    const detail = await response.text().catch(() => '');
    throw new FinanceApiError(response.status, detail || `GET /api/v1/finance/${path} → ${response.status}`);
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    // Un 200 con cuerpo no-JSON (redirección de sesión, error de plataforma)
    // no debe escapar como SyntaxError crudo: unifica el contrato de error.
    throw new FinanceApiError(response.status, 'respuesta no válida');
  }
  if (!isRecord<T>(parsed)) throw new FinanceApiError(response.status, 'respuesta no válida');
  return parsed;
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
