/**
 * Filtros de URL del módulo Finanzas (§7 de la spec, doc de interfaces).
 * Claves gestionadas aquí: from, to, g, acc, ev. Las demás (exev, dims, q,
 * cat, rec, dupev) pertenecen a otras pantallas y el merge las CONSERVA:
 * es el contrato del original (home-finance state/filters.tsx) que evitaba
 * romper la navegación cruzada entre pantallas.
 */

import { MONTHS_LONG, MONTHS_SHORT } from './format';

export type FinanceGranularity = 'month' | 'quarter' | 'year';

export interface FinanceFilters {
  from: string;
  to: string;
  granularity: FinanceGranularity;
  accountIds: string[];
  eventId: string | null;
}

const GRANULARITIES: readonly FinanceGranularity[] = ['month', 'quarter', 'year'];

// Exportado a propósito: las tareas 7 y 8 importan este patrón de fecha ISO
// en vez de copiar el regex (resolución del coordinador de la fase 4).
export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Exportado a propósito: las tareas 7 y 8 importan esta comprobación de UUID
// en vez de copiar el regex (resolución del coordinador de la fase 4).
export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function split(iso: string): [number, number, number] {
  const [year = 1970, month = 1, day = 1] = iso.split('-').map(Number);
  return [year, month, day];
}

function isoOf(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Mes `delta` meses después de (year, month), como par [año, mes 1-12]. */
function addMonths(year: number, month: number, delta: number): [number, number] {
  const index = year * 12 + (month - 1) + delta;
  return [Math.floor(index / 12), ((index % 12) + 12) % 12 + 1];
}

export function monthRange(anchor: string): { from: string; to: string } {
  const [year, month] = split(anchor);
  return { from: isoOf(year, month, 1), to: isoOf(year, month, daysInMonth(year, month)) };
}

export function ytdRange(today: string): { from: string; to: string } {
  const [year] = split(today);
  return { from: isoOf(year, 1, 1), to: today };
}

export function rangeOfMonths(anchor: string, months: number): { from: string; to: string } {
  const [year, month] = split(anchor);
  const [startYear, startMonth] = addMonths(year, month, -(months - 1));
  return { from: isoOf(startYear, startMonth, 1), to: isoOf(year, month, daysInMonth(year, month)) };
}

export function spanMonths(filters: Pick<FinanceFilters, 'from' | 'to'>): number {
  const [fromYear, fromMonth] = split(filters.from);
  const [toYear, toMonth] = split(filters.to);
  return (toYear - fromYear) * 12 + (toMonth - fromMonth) + 1;
}

export function shiftRange(filters: FinanceFilters, direction: 1 | -1): FinanceFilters {
  const delta = spanMonths(filters) * direction;
  const [fromYear, fromMonth] = split(filters.from);
  const [toYear, toMonth] = split(filters.to);
  const [newFromYear, newFromMonth] = addMonths(fromYear, fromMonth, delta);
  const [newToYear, newToMonth] = addMonths(toYear, toMonth, delta);
  return {
    ...filters,
    from: isoOf(newFromYear, newFromMonth, 1),
    to: isoOf(newToYear, newToMonth, daysInMonth(newToYear, newToMonth))
  };
}

export function rangeLabel(filters: Pick<FinanceFilters, 'from' | 'to'>): string {
  const [fromYear, fromMonth] = split(filters.from);
  const [toYear, toMonth] = split(filters.to);
  if (spanMonths(filters) === 1) return `${MONTHS_LONG[fromMonth - 1]} ${fromYear}`;
  return `${MONTHS_SHORT[fromMonth - 1]} ${fromYear} – ${MONTHS_SHORT[toMonth - 1]} ${toYear}`;
}

export function presetRanges(today: string): { label: string; range: { from: string; to: string } }[] {
  const [year, month] = split(today);
  const [prevYear, prevMonth] = addMonths(year, month, -1);
  return [
    { label: 'Año hasta hoy', range: ytdRange(today) },
    { label: 'Este mes', range: monthRange(today) },
    { label: 'Mes anterior', range: monthRange(isoOf(prevYear, prevMonth, 1)) },
    { label: 'Trimestre', range: rangeOfMonths(today, 3) },
    { label: '12 meses', range: rangeOfMonths(today, 12) },
    { label: 'Año', range: { from: isoOf(year, 1, 1), to: isoOf(year, 12, 31) } }
  ];
}

export function parseFilters(params: URLSearchParams, today: string): FinanceFilters {
  const fallback = ytdRange(today);
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const granularity = params.get('g');
  return {
    from: DATE_PATTERN.test(from) ? from : fallback.from,
    to: DATE_PATTERN.test(to) ? to : fallback.to,
    granularity: (GRANULARITIES as readonly string[]).includes(granularity ?? '')
      ? (granularity as FinanceGranularity)
      : 'month',
    accountIds: (params.get('acc') ?? '').split(',').map((piece) => piece.trim()).filter(Boolean),
    eventId: params.get('ev') || null
  };
}

/** Merge NO destructivo: parte del query string vivo y solo toca sus claves. */
export function mergeFilters(current: URLSearchParams, next: FinanceFilters): URLSearchParams {
  const merged = new URLSearchParams(current);
  merged.set('from', next.from);
  merged.set('to', next.to);
  merged.set('g', next.granularity);
  if (next.accountIds.length > 0) merged.set('acc', next.accountIds.join(','));
  else merged.delete('acc');
  if (next.eventId) merged.set('ev', next.eventId);
  else merged.delete('ev');
  return merged;
}

/** Merge genérico de claves sueltas (q, cat, rec, offset…); null o vacío borra. */
export function mergeParams(current: URLSearchParams, patch: Record<string, string | null>): URLSearchParams {
  const merged = new URLSearchParams(current);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === '') merged.delete(key);
    else merged.set(key, value);
  }
  return merged;
}

/** Parámetros de las lecturas REST (`/api/v1/finance/*`): from,to[,acc][,ev]. */
export function apiQuery(filters: FinanceFilters): URLSearchParams {
  const params = new URLSearchParams({ from: filters.from, to: filters.to });
  if (filters.accountIds.length > 0) params.set('acc', filters.accountIds.join(','));
  if (filters.eventId) params.set('ev', filters.eventId);
  return params;
}

/** Fecha local del hogar (patrón currentPeriod de $lib/employment/model). */
export function todayLocal(now: Date = new Date(), timeZone = 'Europe/Madrid'): string {
  const parts = new Intl.DateTimeFormat('es-ES', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year').padStart(4, '0')}-${get('month').padStart(2, '0')}-${get('day').padStart(2, '0')}`;
}
