import { isIsoDateString } from "./dates.js";
import { invariant } from "./errors.js";

/**
 * Generador de recurrencia de rutinas: la ÚNICA fuente de la aritmética de
 * repetición de la casa (§2.8 de `docs/rutinas-y-calendario.md`). Sustituye a
 * las tres copias que hoy tienen que coincidir a mano —la función definer
 * `app.advance_routine_after_completion` de la migración 0009, `advanceDueDate`
 * en `packages/server/src/commands/rhythm.ts` y `nextRoutineDue` en
 * `apps/web/src/lib/food/dates.ts`, cuyo comentario dice literalmente «réplica
 * exacta»—.
 *
 * Cuatro decisiones que gobiernan todo lo demás y conviene tener a la vista:
 *
 * · SE GENERA DESDE EL ANCLA, no desde la última ocurrencia completada. Es lo
 *   que arregla la deriva permanente de una rutina mensual anclada el 31, que
 *   hoy se degrada 31/01 → 28/02 → 28/03 → 28/04 para siempre. Desde el ancla
 *   hace 31/01 → 28/02 → 31/03. Corolario: marcar tarde NO mueve el
 *   calendario, y por tanto desaparece la cinta de correr de la rutina diaria
 *   olvidada una semana.
 *
 * · RECORTE Y NO SALTO. La RFC 5545 se salta los meses que no tienen ese día;
 *   nosotros recortamos al último. Saltar significaría que en febrero no se
 *   hace la limpieza a fondo, lo cual es incorrecto para una casa. Es además
 *   lo que producción ya hace (`make_interval` en la 0009).
 *
 * · ARITMÉTICA SOBRE CADENAS ISO EN UTC. Ni `Date` en hora local, ni `Intl`,
 *   ni la zona del proceso: una ocurrencia es un día de calendario, no un
 *   instante. Así el cambio de hora de Madrid (25/10, 29/03) no pierde ni
 *   duplica ninguna ocurrencia, y el resultado es idéntico se ejecute donde se
 *   ejecute. El orden lexicográfico de `YYYY-MM-DD` coincide con el temporal,
 *   de modo que las comparaciones de ventana son comparaciones de cadena.
 *
 * · «TODAVÍA NO SE SABE» ES UN PATRÓN DE PRIMERA CLASE. `null` significa «esto
 *   se hace, falta decidir cuándo» (§2.3) y no genera NADA, nunca: ni hoy, ni
 *   en el calendario, ni hacia atrás. Es el estado real de unas 21 de las ~32
 *   tareas del manual y por eso se modela, no se evita.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Tipos
// ─────────────────────────────────────────────────────────────────────────────

export type RoutinePattern =
  | "every_n_days"
  | "days_of_week"
  | "day_of_month"
  | "months_of_year";

/**
 * Regla de repetición. `anchorOn` da la FASE (desde cuándo rige y con qué
 * alineación), nunca «la última vez que se hizo». Los días de la semana van en
 * convención ISO 1=lunes … 7=domingo, la misma de `extract(isodow …)`; la
 * conversión a la convención 0..6 del ICS se hace solo en esa frontera.
 */
export type RoutineRule =
  | {
      readonly pattern: "every_n_days";
      readonly anchorOn: string;
      /** 1..366 días entre ocurrencias. 1 = «todos los días». */
      readonly repeatEvery: number;
      readonly endsOn?: string | null;
    }
  | {
      readonly pattern: "days_of_week";
      readonly anchorOn: string;
      /** 1..12 semanas entre semanas activas. 1 = todas las semanas. */
      readonly repeatEvery: number;
      /** ISO 1..7; se normaliza (orden y duplicados) al usarse. */
      readonly weekdays: readonly number[];
      readonly endsOn?: string | null;
    }
  | {
      readonly pattern: "day_of_month";
      readonly anchorOn: string;
      /** 1..36 meses entre ocurrencias (36 = `quarterly` con intervalo 12). */
      readonly repeatEvery: number;
      /** 1..31, o -1 = «el último día del mes». */
      readonly monthDay: number;
      readonly endsOn?: string | null;
    }
  | {
      readonly pattern: "months_of_year";
      readonly anchorOn: string;
      /** 1..12; se normaliza al usarse. `repeatEvery` no interviene. */
      readonly months: readonly number[];
      /** 1..31, o -1 = «el último día del mes». */
      readonly monthDay: number;
      readonly endsOn?: string | null;
    };

/** Una rutina sin cadencia confirmada es `null`: se hace, falta decidir cuándo. */
export type RoutineSchedule = RoutineRule | null;

/**
 * `carry` = se arrastra hasta que alguien la marque, y se enseña UNA sola
 * línea, la más antigua. `skip` = si no se hizo, se pasa por alto; la
 * ocurrencia de hoy sustituye a la de ayer.
 */
export type RoutineOverduePolicy = "carry" | "skip";

/** Fila de `app.routine_completions`: qué ocurrencia se hizo, cuándo y quién la marcó. */
export interface RoutineCompletion {
  /** `due_on`: la ocurrencia que se marcó, no el día en que se pulsó el botón. */
  readonly dueOn: string;
  /**
   * Día de calendario del hogar (Europe/Madrid) en que se pulsó «Marcar
   * hecha». Se pide ya convertido —`(completed_at AT TIME ZONE 'Europe/Madrid')::date`
   * en SQL— porque este módulo no toca zonas horarias a propósito.
   */
  readonly completedOn?: string | null;
  /** `completed_at` tal cual, para enseñar la hora si alguna vista la quiere. */
  readonly completedAt?: string | null;
  readonly completedByMembershipId?: string | null;
  /** Nombre de quien la marcó, para el «quién» del calendario (E2). */
  readonly completedByName?: string | null;
}

/**
 * Estado de una ocurrencia frente a hoy. `missed` describe un HECHO —esta
 * ocurrencia pasó sin marcarse—, no una deuda: con `skip` no reaparece en Hoy.
 */
export type RoutineOccurrenceStatus = "done" | "due" | "missed" | "upcoming";

export interface RoutineOccurrence {
  readonly dueOn: string;
  readonly status: RoutineOccurrenceStatus;
  readonly completion: RoutineCompletion | null;
  /** Días entre la ocurrencia y su marcado (0 = el mismo día); `null` si no consta. */
  readonly completedLateDays: number | null;
}

export interface RoutinePending {
  /** Ocurrencias de HOY sin fila en `routine_completions`. */
  readonly due: readonly string[];
  /** Con `skip`, siempre `null`; con `carry`, la más antigua pendiente y solo esa. */
  readonly overdue: string | null;
  /** Las próximas ocurrencias > hoy sin completar, para el chip optimista. */
  readonly upcoming: readonly string[];
  /**
   * Valor de la caché `app.routines.next_due_on`: cota INFERIOR de la próxima
   * ocurrencia pendiente. Si se queda anticuada solo puede quedarse atrás, de
   * modo que el prefiltro SQL `next_due_on <= hoy` selecciona de más y este
   * módulo descarta después. Nunca puede ocultar una rutina.
   */
  readonly nextDueHint: string | null;
}

export interface OccurrenceWindowOptions {
  /** Tope duro de fechas devueltas; corta por la cola. */
  readonly limit?: number;
}

export interface RoutineHistoryInput {
  readonly fromISO: string;
  readonly toISO: string;
  readonly todayISO: string;
  readonly completions: readonly RoutineCompletion[];
  readonly limit?: number;
}

export interface CadencePhraseOptions {
  /** Si se da, la frase calcula ella misma la próxima ocurrencia ≥ hoy. */
  readonly todayISO?: string;
  /** Próxima ocurrencia ya conocida; tiene prioridad sobre `todayISO`. */
  readonly nextOccurrence?: string | null;
}

export interface Season {
  readonly key: "primavera" | "verano" | "otono" | "invierno";
  readonly label: string;
  /** Mes meteorológico de inicio, con `monthDay = 1`. */
  readonly month: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constantes de ventana
// ─────────────────────────────────────────────────────────────────────────────

/** Tope duro de fechas por rutina y llamada (§2.9). */
export const MAX_OCCURRENCES_PER_CALL = 1000;

/** Cuánto se mira hacia atrás al buscar atrasadas: rescata sin volverse arqueología. */
export const PENDING_LOOKBACK_DAYS = 400;

/** Cuántas próximas devuelve `pendingFor` para el chip optimista. */
export const UPCOMING_COUNT = 3;

/**
 * Horizonte hacia delante. 1500 días cubren con holgura el ciclo más largo que
 * el modelo puede expresar: `day_of_month` con `repeatEvery = 36` son ~1096
 * días. Así `nextDueHint` nunca es `null` por quedarse corto el horizonte.
 */
export const UPCOMING_HORIZON_DAYS = 1500;

/** Temporadas meteorológicas (§4.1): las astronómicas se mueven cada año. */
export const SEASONS: readonly Season[] = Object.freeze([
  Object.freeze({ key: "primavera", label: "Primavera", month: 3 }),
  Object.freeze({ key: "verano", label: "Verano", month: 6 }),
  Object.freeze({ key: "otono", label: "Otoño", month: 9 }),
  Object.freeze({ key: "invierno", label: "Invierno", month: 12 }),
] as const);

const WEEKDAY_NAMES = [
  "lunes",
  "martes",
  "miércoles",
  "jueves",
  "viernes",
  "sábado",
  "domingo",
] as const;

const WEEKDAY_PLURALS = [
  "lunes",
  "martes",
  "miércoles",
  "jueves",
  "viernes",
  "sábados",
  "domingos",
] as const;

const MONTH_NAMES = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
] as const;

const SEASON_ARTICLES: Readonly<Record<number, string>> = Object.freeze({
  3: "la",
  6: "el",
  9: "el",
  12: "el",
});

const SEASON_LOWER: Readonly<Record<number, string>> = Object.freeze({
  3: "primavera",
  6: "verano",
  9: "otoño",
  12: "invierno",
});

// ─────────────────────────────────────────────────────────────────────────────
// Aritmética de días de calendario (UTC, sin zona)
// ─────────────────────────────────────────────────────────────────────────────

const MS_PER_DAY = 86_400_000;

function assertDate(value: string, label: string): void {
  invariant(
    typeof value === "string" && isIsoDateString(value),
    "INVALID_ROUTINE_DATE",
    `${label} no es una fecha de calendario válida: ${value}`,
  );
}

/** Días transcurridos desde 1970-01-01; la unidad de toda la aritmética. */
function epochDay(dateISO: string): number {
  const year = Number(dateISO.slice(0, 4));
  const month = Number(dateISO.slice(5, 7));
  const day = Number(dateISO.slice(8, 10));
  return Date.UTC(year, month - 1, day) / MS_PER_DAY;
}

function fromEpochDay(day: number): string {
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10);
}

function addDaysISO(dateISO: string, days: number): string {
  return fromEpochDay(epochDay(dateISO) + days);
}

/** Módulo que devuelve siempre el resto no negativo (JS lo da con signo). */
function floorMod(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

/** ISO 1=lunes … 7=domingo. El día 0 de la época (1970-01-01) fue jueves. */
function isoWeekdayOfEpochDay(day: number): number {
  return floorMod(day + 3, 7) + 1;
}

/** Lunes de la semana que contiene el día (WKST=MO, el mismo criterio del ICS). */
function mondayOfEpochDay(day: number): number {
  return day - (isoWeekdayOfEpochDay(day) - 1);
}

/** Meses transcurridos desde el año 0: permite restar meses sin tocar fechas. */
function monthIndexOf(dateISO: string): number {
  return Number(dateISO.slice(0, 4)) * 12 + (Number(dateISO.slice(5, 7)) - 1);
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function formatISO(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function sortedUnique(values: readonly number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

/** Día del mes con RECORTE: -1 es el último, y 31 en febrero es el 28 (29 en bisiesto). */
function clampedMonthDay(year: number, month: number, monthDay: number): number {
  const last = daysInMonth(year, month);
  return monthDay === -1 ? last : Math.min(monthDay, last);
}

// ─────────────────────────────────────────────────────────────────────────────
// Validación de la regla
// ─────────────────────────────────────────────────────────────────────────────

function assertRepeatEvery(value: number, max: number): void {
  invariant(
    Number.isInteger(value) && value >= 1 && value <= max,
    "INVALID_ROUTINE_RULE",
    `La repetición debe ser un entero entre 1 y ${max}: ${value}`,
  );
}

function assertNumberSet(values: readonly number[], lo: number, hi: number, label: string): void {
  invariant(
    Array.isArray(values) && values.length > 0,
    "INVALID_ROUTINE_RULE",
    `Hay que marcar al menos un valor en ${label}.`,
  );
  for (const value of values) {
    invariant(
      Number.isInteger(value) && value >= lo && value <= hi,
      "INVALID_ROUTINE_RULE",
      `${label}: ${value} está fuera de ${lo}..${hi}.`,
    );
  }
}

function assertMonthDay(value: number): void {
  invariant(
    Number.isInteger(value) && (value === -1 || (value >= 1 && value <= 31)),
    "INVALID_ROUTINE_RULE",
    `El día del mes debe ser 1..31 o -1 (último día): ${value}`,
  );
}

/**
 * Comprueba la forma de la regla con los mismos límites que la CHECK
 * `routines_pattern_shape` de la base (§2.4). Una regla que aquí falla es una
 * fila que la base habría rechazado.
 */
export function assertRoutineRule(rule: RoutineRule): void {
  assertDate(rule.anchorOn, "El ancla de la rutina");
  if (rule.endsOn != null) {
    assertDate(rule.endsOn, "El fin de la rutina");
    invariant(
      rule.endsOn >= rule.anchorOn,
      "INVALID_ROUTINE_RULE",
      "Una rutina no puede acabar antes de empezar.",
    );
  }
  switch (rule.pattern) {
    case "every_n_days":
      assertRepeatEvery(rule.repeatEvery, 366);
      break;
    case "days_of_week":
      assertRepeatEvery(rule.repeatEvery, 12);
      assertNumberSet(rule.weekdays, 1, 7, "los días de la semana");
      break;
    case "day_of_month":
      assertRepeatEvery(rule.repeatEvery, 36);
      assertMonthDay(rule.monthDay);
      break;
    case "months_of_year":
      assertNumberSet(rule.months, 1, 12, "los meses del año");
      assertMonthDay(rule.monthDay);
      break;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Generación
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ocurrencias en `[fromISO, toISO]`, ambas inclusive, en orden ascendente.
 *
 * La ventana puede estar ENTERAMENTE EN EL PASADO: el calendario enseña lo que
 * ya tocó (E4). Nunca se emite nada anterior a `anchorOn` ni posterior a
 * `endsOn`, y una rutina sin cadencia (`null`) devuelve siempre la lista vacía.
 */
export function occurrencesBetween(
  rule: RoutineSchedule,
  fromISO: string,
  toISO: string,
  options: OccurrenceWindowOptions = {},
): string[] {
  if (rule === null) return [];
  assertRoutineRule(rule);
  assertDate(fromISO, "El inicio de la ventana");
  assertDate(toISO, "El fin de la ventana");

  const limit = options.limit ?? MAX_OCCURRENCES_PER_CALL;
  invariant(
    Number.isInteger(limit) && limit >= 0,
    "INVALID_ROUTINE_WINDOW",
    `El tope de ocurrencias debe ser un entero no negativo: ${limit}`,
  );
  if (limit === 0 || toISO < fromISO) return [];

  // La ventana efectiva nunca sale de [ancla, fin]. Comparación lexicográfica:
  // en `YYYY-MM-DD` coincide con la cronológica.
  const first = fromISO < rule.anchorOn ? rule.anchorOn : fromISO;
  const last = rule.endsOn != null && rule.endsOn < toISO ? rule.endsOn : toISO;
  if (last < first) return [];

  switch (rule.pattern) {
    case "every_n_days":
      return everyNDays(rule.anchorOn, rule.repeatEvery, first, last, limit);
    case "days_of_week":
      return daysOfWeek(rule.anchorOn, rule.repeatEvery, rule.weekdays, first, last, limit);
    case "day_of_month":
      return dayOfMonth(rule.anchorOn, rule.repeatEvery, rule.monthDay, first, last, limit);
    case "months_of_year":
      return monthsOfYear(rule.months, rule.monthDay, first, last, limit);
  }
}

/** `d0 = ancla + ceil((desde − ancla) / n) · n`; luego `+n` hasta el final. */
function everyNDays(
  anchorOn: string,
  repeatEvery: number,
  first: string,
  last: string,
  limit: number,
): string[] {
  const anchor = epochDay(anchorOn);
  const lastDay = epochDay(last);
  const steps = Math.max(0, Math.ceil((epochDay(first) - anchor) / repeatEvery));
  const out: string[] = [];
  for (let day = anchor + steps * repeatEvery; day <= lastDay && out.length < limit; day += repeatEvery) {
    out.push(fromEpochDay(day));
  }
  return out;
}

/**
 * La semana es activa si `((lunes(d) − lunes(ancla)) / 7) mod repeatEvery == 0`.
 * Se cuenta en lunes absolutos y no en número de semana ISO: así la alternancia
 * de «cada 2 semanas» sobrevive al cambio de año, donde la numeración ISO se
 * reinicia y una semana 53 rompería la cuenta.
 */
function daysOfWeek(
  anchorOn: string,
  repeatEvery: number,
  weekdays: readonly number[],
  first: string,
  last: string,
  limit: number,
): string[] {
  const anchorMonday = mondayOfEpochDay(epochDay(anchorOn));
  const firstDay = epochDay(first);
  const lastDay = epochDay(last);
  const firstMonday = mondayOfEpochDay(firstDay);
  const remainder = floorMod((firstMonday - anchorMonday) / 7, repeatEvery);
  const days = sortedUnique(weekdays);
  const out: string[] = [];
  const step = repeatEvery * 7;
  let monday = firstMonday + (remainder === 0 ? 0 : (repeatEvery - remainder) * 7);
  for (; monday <= lastDay && out.length < limit; monday += step) {
    for (const weekday of days) {
      if (out.length >= limit) break;
      const day = monday + weekday - 1;
      // Los días de la primera semana anteriores al ancla (o a la ventana) no
      // se emiten: el ancla a mitad de semana no resucita el lunes anterior.
      if (day < firstDay || day > lastDay) continue;
      out.push(fromEpochDay(day));
    }
  }
  return out;
}

/** El mes es activo si `(mes(d) − mes(ancla)) mod repeatEvery == 0`. Día con RECORTE. */
function dayOfMonth(
  anchorOn: string,
  repeatEvery: number,
  monthDay: number,
  first: string,
  last: string,
  limit: number,
): string[] {
  const remainder = floorMod(monthIndexOf(first) - monthIndexOf(anchorOn), repeatEvery);
  let monthIndex = monthIndexOf(first) + (remainder === 0 ? 0 : repeatEvery - remainder);
  const out: string[] = [];
  for (; out.length < limit; monthIndex += repeatEvery) {
    const year = Math.floor(monthIndex / 12);
    const month = floorMod(monthIndex, 12) + 1;
    const candidate = formatISO(year, month, clampedMonthDay(year, month, monthDay));
    if (candidate > last) break;
    if (candidate >= first) out.push(candidate);
  }
  return out;
}

/** Todos los años desde el ancla, los meses marcados, mismo recorte de día. */
function monthsOfYear(
  months: readonly number[],
  monthDay: number,
  first: string,
  last: string,
  limit: number,
): string[] {
  const wanted = sortedUnique(months);
  const lastYear = Number(last.slice(0, 4));
  const out: string[] = [];
  for (let year = Number(first.slice(0, 4)); year <= lastYear && out.length < limit; year += 1) {
    for (const month of wanted) {
      if (out.length >= limit) break;
      const candidate = formatISO(year, month, clampedMonthDay(year, month, monthDay));
      if (candidate < first || candidate > last) continue;
      out.push(candidate);
    }
  }
  return out;
}

/**
 * Primera ocurrencia en `fromISO` o después, o `null` si no hay ninguna dentro
 * del horizonte (rutina sin cadencia, o `endsOn` ya pasado).
 */
export function nextOccurrenceOnOrAfter(
  rule: RoutineSchedule,
  fromISO: string,
  options: { readonly horizonDays?: number } = {},
): string | null {
  if (rule === null) return null;
  assertRoutineRule(rule);
  assertDate(fromISO, "La fecha de referencia");
  const horizon = options.horizonDays ?? UPCOMING_HORIZON_DAYS;
  // El horizonte cuenta desde el ancla si aún no ha llegado: una rutina anclada
  // dentro de tres años sigue teniendo próxima fecha que enseñar.
  const base = fromISO < rule.anchorOn ? rule.anchorOn : fromISO;
  const [next] = occurrencesBetween(rule, fromISO, addDaysISO(base, horizon), { limit: 1 });
  return next ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Política de atraso: se DERIVA del patrón, no se pregunta (§2.5)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sub-semanal se pasa por alto; de semanal para arriba se arrastra. Es lo que
 * impide que diez rutinas diarias por siete días de vacaciones se conviertan en
 * setenta filas y setenta toques, y a la vez que el cambio de ropa de temporada
 * desaparezca por olvidarlo una semana.
 *
 * Una rutina sin cadencia devuelve `carry`, que es el DEFAULT de la columna en
 * la base; da igual, porque nunca genera ocurrencias que arrastrar.
 */
export function overduePolicyFor(rule: RoutineSchedule): RoutineOverduePolicy {
  if (rule === null) return "carry";
  switch (rule.pattern) {
    case "every_n_days":
      return rule.repeatEvery <= 6 ? "skip" : "carry";
    case "days_of_week":
      return "skip";
    case "day_of_month":
    case "months_of_year":
      return "carry";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// De ocurrencias a «lo que sale en Hoy» (§2.9)
// ─────────────────────────────────────────────────────────────────────────────

const NOTHING_PENDING: RoutinePending = Object.freeze({
  due: Object.freeze([]),
  overdue: null,
  upcoming: Object.freeze([]),
  nextDueHint: null,
});

/**
 * Lo que Hoy debe enseñar de una rutina. `completedDueOns` son los `due_on` ya
 * registrados en `app.routine_completions` para esta rutina.
 *
 * Con `carry` se devuelve UNA sola atrasada, la más antigua, nunca una lista de
 * noventa. Con `skip` no hay atrasadas: la ocurrencia de hoy sustituye a la de
 * ayer.
 */
export function pendingFor(
  rule: RoutineSchedule,
  policy: RoutineOverduePolicy,
  completedDueOns: ReadonlySet<string>,
  todayISO: string,
): RoutinePending {
  if (rule === null) return NOTHING_PENDING;
  assertRoutineRule(rule);
  assertDate(todayISO, "La fecha de hoy");

  // Una rutina que ya terminó «no genera nada, no aparece, no avisa» (§9, caso
  // 9). Ni siquiera arrastra lo que quedó sin marcar: `ends_on` es justamente la
  // forma de decir «dejad de pedirme esto», y una rutina archivada que sigue
  // reclamando en Hoy sería el peor de los dos mundos.
  if (rule.endsOn != null && rule.endsOn < todayISO) return NOTHING_PENDING;

  const past = occurrencesBetween(rule, addDaysISO(todayISO, -PENDING_LOOKBACK_DAYS), todayISO);
  const due = past.filter((dueOn) => dueOn === todayISO && !completedDueOns.has(dueOn));

  let overdue: string | null = null;
  if (policy === "carry") {
    for (const dueOn of past) {
      if (dueOn < todayISO && !completedDueOns.has(dueOn)) {
        overdue = dueOn;
        break;
      }
    }
  }

  const horizonBase = todayISO < rule.anchorOn ? rule.anchorOn : todayISO;
  const upcoming = occurrencesBetween(
    rule,
    addDaysISO(todayISO, 1),
    addDaysISO(horizonBase, UPCOMING_HORIZON_DAYS),
    // Se piden algunas de más para poder descartar las que ya estén marcadas
    // sin dejar el chip corto.
    { limit: UPCOMING_COUNT + 8 },
  )
    .filter((dueOn) => !completedDueOns.has(dueOn))
    .slice(0, UPCOMING_COUNT);

  const nextPending = due[0] ?? upcoming[0] ?? null;
  return Object.freeze({
    due: Object.freeze(due),
    overdue,
    upcoming: Object.freeze(upcoming),
    nextDueHint: overdue ?? nextPending,
  });
}

/**
 * Casa las ocurrencias de la ventana con las finalizaciones registradas: qué se
 * hizo, qué día tocaba y quién lo marcó (E2/E4). Es lo que permite al
 * calendario enseñar el pasado.
 *
 * Las finalizaciones HUÉRFANAS —cuyo `due_on` ya no es ocurrencia porque la
 * regla cambió— no se pintan, pero tampoco se borran ni se tocan: una
 * finalización es un hecho, y §2.9 acepta a propósito los `dueOn` que llegan
 * de un cliente offline con la regla anterior.
 *
 * Deliberadamente NO devuelve porcentajes, rachas, medias ni comparativas: el
 * AC-26 revisado permite enseñar hechos con su autoría y prohíbe cualquier
 * agregado que puntúe a alguien.
 */
export function occurrenceHistory(
  rule: RoutineSchedule,
  input: RoutineHistoryInput,
): RoutineOccurrence[] {
  assertDate(input.todayISO, "La fecha de hoy");
  const occurrences = occurrencesBetween(
    rule,
    input.fromISO,
    input.toISO,
    input.limit === undefined ? {} : { limit: input.limit },
  );
  const byDueOn = new Map<string, RoutineCompletion>();
  for (const completion of input.completions) {
    assertDate(completion.dueOn, "La ocurrencia finalizada");
    byDueOn.set(completion.dueOn, completion);
  }
  return occurrences.map((dueOn) => {
    const completion = byDueOn.get(dueOn) ?? null;
    let status: RoutineOccurrenceStatus;
    if (completion) status = "done";
    else if (dueOn === input.todayISO) status = "due";
    else if (dueOn < input.todayISO) status = "missed";
    else status = "upcoming";
    let completedLateDays: number | null = null;
    if (completion?.completedOn != null) {
      assertDate(completion.completedOn, "El día del marcado");
      completedLateDays = epochDay(completion.completedOn) - epochDay(dueOn);
    }
    return Object.freeze({ dueOn, status, completion, completedLateDays });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// La cadencia dicha en lengua de casa (§4.1)
// ─────────────────────────────────────────────────────────────────────────────

/** «lunes» … «domingo», para etiquetas accesibles. */
export function weekdayName(isoWeekday: number): string {
  const name = WEEKDAY_NAMES[isoWeekday - 1];
  invariant(
    name !== undefined,
    "INVALID_ROUTINE_RULE",
    `Día de la semana fuera de 1..7: ${isoWeekday}`,
  );
  return name;
}

/** «enero» … «diciembre». */
export function monthName(month: number): string {
  const name = MONTH_NAMES[month - 1];
  invariant(name !== undefined, "INVALID_ROUTINE_RULE", `Mes fuera de 1..12: ${month}`);
  return name;
}

function weekdayPlural(isoWeekday: number): string {
  const name = WEEKDAY_PLURALS[isoWeekday - 1];
  invariant(
    name !== undefined,
    "INVALID_ROUTINE_RULE",
    `Día de la semana fuera de 1..7: ${isoWeekday}`,
  );
  return name;
}

/**
 * «a», «a y b», «a, b y c». Todos los elementos que se le pasan empiezan por
 * preposición («los …», «en …», «al …»), así que nunca hace falta la «e» ante
 * palabra que empieza por i-.
 */
function joinEs(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} y ${parts[parts.length - 1]}`;
}

/** «lunes 17 de agosto», «17 de agosto», «17 de agosto de 2026». */
export function spanishDateLabel(
  dateISO: string,
  options: { readonly weekday?: boolean; readonly year?: boolean } = {},
): string {
  assertDate(dateISO, "La fecha");
  const day = Number(dateISO.slice(8, 10));
  const month = monthName(Number(dateISO.slice(5, 7)));
  const head = options.weekday === false ? "" : `${weekdayName(isoWeekdayOfEpochDay(epochDay(dateISO)))} `;
  const tail = options.year === true ? ` de ${dateISO.slice(0, 4)}` : "";
  return `${head}${day} de ${month}${tail}`;
}

function isSeasonStart(month: number): boolean {
  return SEASON_LOWER[month] !== undefined;
}

function seasonsRule(rule: RoutineRule): boolean {
  return (
    rule.pattern === "months_of_year" && rule.monthDay === 1 && rule.months.every(isSeasonStart)
  );
}

/**
 * Cadencia compacta para la segunda línea de un listado: «todos los días», «los
 * lunes y los jueves», «cada 2 semanas», «en verano y en invierno», «sin día
 * todavía».
 */
export function cadenceClause(rule: RoutineSchedule): string {
  if (rule === null) return "sin día todavía";
  assertRoutineRule(rule);
  switch (rule.pattern) {
    case "every_n_days": {
      const days = rule.repeatEvery;
      if (days === 1) return "todos los días";
      if (days % 7 === 0) {
        const weeks = days / 7;
        return weeks === 1 ? "cada semana" : `cada ${weeks} semanas`;
      }
      return `cada ${days} días`;
    }
    case "days_of_week": {
      const list = joinEs(sortedUnique(rule.weekdays).map((day) => `los ${weekdayPlural(day)}`));
      return rule.repeatEvery === 1 ? list : `cada ${rule.repeatEvery} semanas, ${list}`;
    }
    case "day_of_month": {
      const day = rule.monthDay === -1 ? "el último día" : `el día ${rule.monthDay}`;
      return rule.repeatEvery === 1
        ? `${day} de cada mes`
        : `cada ${rule.repeatEvery} meses, ${day}`;
    }
    case "months_of_year": {
      const months = sortedUnique(rule.months);
      if (seasonsRule(rule)) {
        return joinEs(months.map((month) => `en ${SEASON_LOWER[month]}`));
      }
      if (rule.monthDay === -1) {
        return joinEs(months.map((month) => `el último día de ${monthName(month)}`));
      }
      if (rule.monthDay === 1) {
        return joinEs(months.map((month) => `en ${monthName(month)}`));
      }
      return joinEs(months.map((month) => `el ${rule.monthDay} de ${monthName(month)}`));
    }
  }
}

/**
 * ¿Hace falta decir la próxima fecha? Solo cuando la frase por sí sola no la
 * fija: «todos los días» y «los lunes y los jueves» ya la dicen; «cada 2
 * semanas» no. Las temporadas nombran sus fechas dentro de la propia frase.
 */
function needsNextDate(rule: RoutineRule): boolean {
  switch (rule.pattern) {
    case "every_n_days":
    case "days_of_week":
      return rule.repeatEvery > 1;
    case "day_of_month":
      return true;
    case "months_of_year":
      return false;
  }
}

/**
 * La frase de vuelta del formulario (`aria-live="polite"`): el antídoto contra
 * la jerga. Nadie tiene que descifrar los controles, lee la frase.
 *
 * «Toca todos los días.» · «Toca los lunes y los jueves.» · «Toca cada 2
 * semanas. La próxima, el lunes 17 de agosto.» · «Toca al empezar el verano (1
 * de junio) y al empezar el invierno (1 de diciembre).» · «Sin día todavía. No
 * aparecerá en Hoy.»
 */
export function cadencePhrase(rule: RoutineSchedule, options: CadencePhraseOptions = {}): string {
  if (rule === null) return "Sin día todavía. No aparecerá en Hoy.";
  assertRoutineRule(rule);

  const body =
    rule.pattern === "months_of_year" && seasonsRule(rule)
      ? joinEs(
          sortedUnique(rule.months).map(
            (month) =>
              `al empezar ${SEASON_ARTICLES[month]} ${SEASON_LOWER[month]} (1 de ${monthName(month)})`,
          ),
        )
      : cadenceClause(rule);
  const sentence = `Toca ${body}.`;

  if (!needsNextDate(rule)) return sentence;
  const next =
    options.nextOccurrence !== undefined
      ? options.nextOccurrence
      : options.todayISO !== undefined
        ? nextOccurrenceOnOrAfter(rule, options.todayISO)
        : null;
  return next == null ? sentence : `${sentence} La próxima, el ${spanishDateLabel(next)}.`;
}
