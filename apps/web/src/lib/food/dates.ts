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

/** Suma meses en UTC recortando el día al último del mes destino (31/01 + 1 mes → 28/02). */
export function addMonthsClamped(dateISO: string, months: number): string {
  const year = Number(dateISO.slice(0, 4));
  const monthIndex = Number(dateISO.slice(5, 7)) - 1;
  const day = Number(dateISO.slice(8, 10));
  const total = monthIndex + months;
  const targetYear = year + Math.floor(total / 12);
  const targetMonth = ((total % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const targetDay = Math.min(day, lastDay);
  return `${String(targetYear).padStart(4, '0')}-${String(targetMonth + 1).padStart(2, '0')}-${String(targetDay).padStart(2, '0')}`;
}

/**
 * Próxima ocurrencia de una rutina tras completar la vigente. Réplica exacta
 * de `app.advance_routine_after_completion` (migración 0009) y de
 * `advanceDueDate` en el servidor: permite pintar «Hecha ✓ · próxima el X»
 * de forma OPTIMISTA con la misma fecha que confirmará el servidor.
 */
export function nextRoutineDue(
  dueOn: string,
  frequency: 'daily' | 'weekly' | 'monthly' | 'quarterly',
  intervalCount: number
): string {
  switch (frequency) {
    case 'daily':
      return addDays(dueOn, intervalCount);
    case 'weekly':
      return addDays(dueOn, 7 * intervalCount);
    case 'monthly':
      return addMonthsClamped(dueOn, intervalCount);
    case 'quarterly':
      return addMonthsClamped(dueOn, 3 * intervalCount);
  }
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

/**
 * Índice del día activo por defecto en la vista semanal del menú: el día
 * pedido explícitamente si pertenece a la semana; si no, hoy cuando la semana
 * visible lo contiene; y en último término el lunes. Así la página abre en el
 * día actual (cambiar «la comida de hoy» no exige el click correctivo) sin
 * romper la navegación a otras semanas.
 */
export function activeMenuDayIndex(days: readonly string[], requested: string | null, today: string): number {
  if (requested) {
    const index = days.indexOf(requested);
    if (index >= 0) return index;
  }
  const todayIndex = days.indexOf(today);
  return todayIndex >= 0 ? todayIndex : 0;
}

/** Etiqueta "3 ago – 9 ago" para la cabecera de la semana. */
export function weekLabel(mondayISO: string): string {
  return `${DATE_LABEL.format(new Date(`${mondayISO}T00:00:00Z`))} – ${DATE_LABEL.format(new Date(`${addDays(mondayISO, 6)}T00:00:00Z`))}`;
}
