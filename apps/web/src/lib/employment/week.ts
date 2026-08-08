import type { WeeklyReportSubmitPayloadV1 } from '@casa-clara/contracts';

/**
 * Helpers puros para el parte semanal de la empleada. La semana laboral
 * empieza SIEMPRE en lunes (el servidor lo rechaza si no) y el formulario
 * admite como máximo una fila por día de la semana.
 */

export const MAX_WEEK_ROWS = 7;
export const MAX_DAY_MINUTES = 24 * 60;

const DAY_MS = 86_400_000;

/** Fecha ISO (YYYY-MM-DD) del instante dado en la zona horaria del hogar. */
export function localIsoDate(now = new Date(), timeZone = 'Europe/Madrid'): string {
  // en-CA formatea como YYYY-MM-DD, exactamente el ISO que necesitamos.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(now);
}

export function addDaysIso(iso: string, days: number): string {
  const time = Date.parse(`${iso}T00:00:00Z`) + days * DAY_MS;
  return new Date(time).toISOString().slice(0, 10);
}

/** Lunes de la semana que contiene la fecha ISO dada. */
export function mondayOf(iso: string): string {
  const dayOfWeek = new Date(Date.parse(`${iso}T00:00:00Z`)).getUTCDay(); // 0 = domingo
  return addDaysIso(iso, -((dayOfWeek + 6) % 7));
}

/** Lunes de la semana en curso, calculado en el cliente. */
export function currentWeekMonday(now = new Date(), timeZone = 'Europe/Madrid'): string {
  return mondayOf(localIsoDate(now, timeZone));
}

/** Los siete días ISO de la semana que empieza en `monday`. */
export function weekDays(monday: string): string[] {
  return Array.from({ length: 7 }, (_, index) => addDaysIso(monday, index));
}

export interface WeekEntryDraft {
  workedOn: string;
  /** Minutos como texto del input; se valida como entero 0..1440. */
  minutes: string | number;
  note: string;
}

export type WeekEntriesResult =
  | { ok: true; entries: WeeklyReportSubmitPayloadV1['entries'] }
  | { ok: false; error: string };

/**
 * Convierte las filas del formulario en las entradas del payload congelado.
 * Rechaza filas fuera de la semana, minutos no enteros o fuera de rango,
 * fechas duplicadas y más de siete filas.
 */
export function buildWeekEntries(
  weekStartsOn: string,
  rows: readonly WeekEntryDraft[]
): WeekEntriesResult {
  if (rows.length === 0) return { ok: false, error: 'Añade al menos un día trabajado.' };
  if (rows.length > MAX_WEEK_ROWS) {
    return { ok: false, error: `Una semana admite como máximo ${MAX_WEEK_ROWS} días.` };
  }
  const weekEndsOn = addDaysIso(weekStartsOn, 6);
  const seen = new Set<string>();
  const entries: WeeklyReportSubmitPayloadV1['entries'] = [];
  for (const row of rows) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.workedOn)) {
      return { ok: false, error: 'Cada fila necesita una fecha del calendario.' };
    }
    if (row.workedOn < weekStartsOn || row.workedOn > weekEndsOn) {
      return { ok: false, error: 'Cada día debe caer dentro de la semana en curso.' };
    }
    if (seen.has(row.workedOn)) {
      return { ok: false, error: 'Hay dos filas con el mismo día; usa una fila por día.' };
    }
    seen.add(row.workedOn);
    const minutes = typeof row.minutes === 'number' ? row.minutes : Number(row.minutes.trim());
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > MAX_DAY_MINUTES) {
      return { ok: false, error: 'El tiempo de cada día debe estar entre 0 y 24 horas.' };
    }
    const note = row.note.trim();
    if (note.length > 500) {
      return { ok: false, error: 'La nota admite 500 caracteres como máximo.' };
    }
    entries.push({ workedOn: row.workedOn, regularMinutes: minutes, ...(note ? { note } : {}) });
  }
  entries.sort((left, right) => left.workedOn.localeCompare(right.workedOn));
  return { ok: true, entries };
}
