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

/*
 * Aquí vivían `addMonthsClamped` y `nextRoutineDue`, la TERCERA copia de la
 * aritmética de recurrencia (§2.8: «la misma aritmética está triplicada… las
 * tres copias tienen que coincidir a mano. Las tres desaparecen»). Las otras
 * dos —`app.advance_routine_after_completion` y `advanceDueDate`— las retira
 * la 0033 con esta.
 *
 * `addMonthsClamped` no era neutral: recortar el día al último del mes destino
 * es lo que convertía «el 31» en «el 28» al pasar por febrero, y para siempre,
 * porque la fecha recortada pasaba a ser el nuevo punto de partida. El motor
 * puro de `@housekeeper/domain` no recorta el estado: guarda «el día 31» como
 * regla y resuelve cada mes por separado (31 ene → 28 feb → 31 mar).
 *
 * Ningún componente las llamaba ya: el chip optimista de «Hecha ✓ · próxima el
 * X» sale del mismo generador que usa el servidor.
 */

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
