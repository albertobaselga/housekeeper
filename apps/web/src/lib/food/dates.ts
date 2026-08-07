/**
 * Fechas de la semana de menú (lunes → domingo) como cadenas ISO puras.
 * Módulo compartido por el load del servidor y la navegación en cliente;
 * opera en UTC sobre la cadena para que el resultado no dependa de la zona
 * del proceso.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function addDays(dateISO: string, days: number): string {
  const date = new Date(`${dateISO}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Lunes de la semana a la que pertenece la fecha (la propia fecha si ya es lunes). */
export function mondayOf(dateISO: string): string {
  const date = new Date(`${dateISO}T00:00:00Z`);
  // getUTCDay: 0 = domingo … 6 = sábado; distancia hasta el lunes anterior.
  const offset = (date.getUTCDay() + 6) % 7;
  return addDays(dateISO, -offset);
}

/** Los siete días de la semana que empieza en `mondayISO`. */
export function weekDays(mondayISO: string): string[] {
  return Array.from({ length: 7 }, (_, index) => addDays(mondayISO, index));
}

const DAY_LABEL = new Intl.DateTimeFormat('es-ES', { weekday: 'short', timeZone: 'UTC' });
const DATE_LABEL = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', timeZone: 'UTC' });

export function dayLabel(dateISO: string): { day: string; date: string } {
  const date = new Date(`${dateISO}T00:00:00Z`);
  return { day: DAY_LABEL.format(date), date: DATE_LABEL.format(date) };
}

/** Etiqueta "3 ago – 9 ago" para la cabecera de la semana. */
export function weekLabel(mondayISO: string): string {
  return `${DATE_LABEL.format(new Date(`${mondayISO}T00:00:00Z`))} – ${DATE_LABEL.format(new Date(`${addDays(mondayISO, 6)}T00:00:00Z`))}`;
}
