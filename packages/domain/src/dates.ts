import { invariant } from "./errors.js";

declare const localDateBrand: unique symbol;

/** Fecha de calendario `YYYY-MM-DD` sin zona horaria. */
export type LocalDate = string & { readonly [localDateBrand]: "LocalDate" };

export function isIsoDateString(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

export function localDate(value: string): LocalDate {
  invariant(isIsoDateString(value), "INVALID_LOCAL_DATE", `Fecha de calendario no válida: ${value}`);
  return value as LocalDate;
}

export function addCalendarDays(value: LocalDate, days: number): LocalDate {
  invariant(
    Number.isInteger(days),
    "INVALID_DAY_COUNT",
    "El número de días de calendario debe ser entero.",
  );
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year as number, (month as number) - 1, day as number));
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return localDate(parsed.toISOString().slice(0, 10));
}

/** Comparación en rango cerrado [from, through]; el orden lexicográfico ISO coincide con el temporal. */
export function isDateInClosedRange(
  value: LocalDate,
  from: LocalDate,
  through: LocalDate,
): boolean {
  return value >= from && value <= through;
}

export interface IsoWeek {
  /** Lunes de la semana ISO que contiene la fecha. */
  readonly monday: LocalDate;
  /** Domingo de la misma semana ISO. */
  readonly sunday: LocalDate;
}

/** Límites lunes–domingo de la semana ISO 8601 de la fecha (base del parte semanal). */
export function isoWeekBounds(value: LocalDate): IsoWeek {
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year as number, (month as number) - 1, day as number));
  // getUTCDay: 0 = domingo … 6 = sábado; en ISO el lunes es el día 1.
  const daysSinceMonday = (parsed.getUTCDay() + 6) % 7;
  const monday = addCalendarDays(value, -daysSinceMonday);
  return Object.freeze({ monday, sunday: addCalendarDays(monday, 6) });
}
