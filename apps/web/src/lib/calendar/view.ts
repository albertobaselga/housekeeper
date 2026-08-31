import { occurrencesBetween, type RoutineOverduePolicy, type RoutineSchedule } from '@housekeeper/domain';

import { addDays, isIsoDate, mondayOf } from '$lib/food/dates';

/**
 * Del conjunto de REGLAS a lo que se pinta en un día concreto.
 *
 * Este módulo es puro y vive TAMBIÉN en el navegador a propósito (§4.3 de
 * `docs/rutinas-y-calendario.md`): con las reglas ya descargadas, cualquier
 * semana, mes o año se pinta sin volver al servidor y por tanto sin red. Lo que
 * NO se puede calcular —los eventos del calendario enlazado y quién marcó qué—
 * viaja con su ventana declarada, y fuera de ella este módulo dice `unknown` en
 * vez de inventar.
 *
 * Esa última distinción es la regla más importante del fichero. Una ocurrencia
 * pasada de la que no se han descargado las finalizaciones NO es una ocurrencia
 * sin hacer: es una ocurrencia de la que no se sabe nada. Pintarlas igual sería
 * fabricar un falso negativo que recaería siempre sobre la misma persona, justo
 * lo que la enmienda E2 prohíbe.
 *
 * Aquí no se cuenta cuántas se hicieron ni sobre cuántas: no hay porcentajes,
 * rachas, medias ni comparativas, y no puede haberlas (AC-26 revisado).
 */

// ─────────────────────────────────────────────────────────────────────────────
// Alcances y ventanas (compartidos por el load del servidor y la navegación)
// ─────────────────────────────────────────────────────────────────────────────

/** Los tres alcances de la enmienda E1, con el nombre que viaja en la URL. */
export const CALENDAR_SCOPES = ['semana', 'mes', 'ano'] as const;
export type CalendarScope = (typeof CALENDAR_SCOPES)[number];

/** Celdas de la rejilla del mes: seis semanas completas, siempre las mismas. */
export const MONTH_GRID_DAYS = 42;

export function resolveScope(value: string | null | undefined): CalendarScope {
  return (CALENDAR_SCOPES as readonly string[]).includes(value ?? '')
    ? (value as CalendarScope)
    : 'semana';
}

/** Día de referencia de la vista. Una fecha inventada en la URL cae en hoy. */
export function resolveAnchor(value: string | null | undefined, todayISO: string): string {
  return typeof value === 'string' && isIsoDate(value) ? value : todayISO;
}

/**
 * Ventana de DETALLE que se descarga: la rejilla de seis semanas del mes del
 * ancla. Cubre de una vez el alcance «mes» entero y cualquier semana de ese
 * mes, de modo que alternar entre semana y mes —el gesto más frecuente— nunca
 * pide red. El alcance «año» no necesita detalle: no enseña ni eventos ni
 * autoría, solo lo previsto.
 */
export function monthGridRange(anchorISO: string): { fromISO: string; toISO: string } {
  const fromISO = mondayOf(`${anchorISO.slice(0, 7)}-01`);
  return { fromISO, toISO: addDays(fromISO, MONTH_GRID_DAYS - 1) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Lo que viaja del servidor a la página
// ─────────────────────────────────────────────────────────────────────────────

export interface CalendarEventView {
  id: string;
  /** Día civil de Madrid en el que empieza; la página agrupa por aquí. */
  dateISO: string;
  /** «16:45», o «Todo el día» para eventos de día completo. */
  timeLabel: string;
  /** «17:30» si el evento acaba el mismo día; null en el resto de casos. */
  endLabel: string | null;
  allDay: boolean;
  title: string;
  location: string | null;
  /** Nombre del calendario enlazado del que viene el evento. */
  sourceLabel: string;
}

/**
 * Una rutina tal y como viaja a la página: su REGLA, no sus fechas. La frase de
 * cadencia («los lunes y los jueves») se calcula en el servidor porque no
 * depende del día que se esté mirando, y así el navegador no necesita el
 * vocabulario en castellano del motor.
 */
export interface CalendarRoutineView {
  id: string;
  title: string;
  details: string;
  audience: 'family' | 'employee' | 'all';
  audienceLabel: string;
  cadence: string;
  rule: RoutineSchedule;
  overduePolicy: RoutineOverduePolicy;
}

/** Un hecho: esta ocurrencia se marcó, y quién la marcó. Nada más (E2). */
export interface CalendarCompletionView {
  routineId: string;
  /** La ocurrencia marcada, no el día en que se pulsó el botón. */
  dueOn: string;
  /** Día civil de Madrid del marcado; permite decir «se marcó el viernes». */
  completedOn: string;
  /**
   * Nombre de quien la marcó, o «Alguien de la casa» cuando la RLS de
   * `app.user_profiles` no deja leerlo (solo la administración ve los nombres
   * de terceros: política `user_profiles_admin_read` de la 0005). Se prefiere
   * una etiqueta neutra a esconder el hecho.
   */
  byName: string;
}

/**
 * Lo que SÍ hay que descargar: eventos del calendario enlazado y autoría de lo
 * marcado. Se pide por ventanas (`GET …/calendar/ventana?d=…`) en vez de
 * navegando, porque una navegación que falla sin red echa a quien mira de la
 * pantalla y le quita hasta lo que su navegador ya sabía calcular.
 */
export interface CalendarWindow {
  windowFromISO: string;
  windowToISO: string;
  events: CalendarEventView[];
  completions: CalendarCompletionView[];
  /** Año para el que se conocen los días con eventos (alcance «año»). */
  eventDaysYear: number;
  /** Días de ese año con al menos un evento. Densidad, no detalle. */
  eventDaysISO: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Lo que la página tiene que confesar
// ─────────────────────────────────────────────────────────────────────────────

export interface CalendarNoticeInput {
  /** `navigator.onLine`. */
  readonly online: boolean;
  /** ¿Lo que se está mirando cae fuera de la ventana descargada? */
  readonly outsideWindow: boolean;
  /** «7 ago, 21:04» de cuando el servidor sirvió estos datos. */
  readonly loadedAtLabel: string;
}

/**
 * Las bandas honestas de la pantalla, en orden. Son dos hechos distintos y por
 * eso no se funden en uno:
 *
 *  · SIN RED, la página la sirve el service worker desde su caché. Las rutinas
 *    siguen siendo verdad —se calculan de sus reglas, aquí mismo—, pero los
 *    eventos son los de la última descarga y hay que decir de cuándo.
 *  · FUERA DE LO DESCARGADO (con red o sin ella) las rutinas también se
 *    calculan, pero de los eventos y de quién marcó cada cosa no se sabe NADA.
 *    Callarlo dejaría un día pasado con aspecto de «no se hizo».
 *
 * Función pura para que el texto se pueda probar sin navegador: bajo
 * Playwright, `context.setOffline` no cambia `navigator.onLine`, así que la
 * primera banda no es comprobable de extremo a extremo.
 */
export function calendarNotices(input: CalendarNoticeInput): string[] {
  const notices: string[] = [];
  if (!input.online) {
    notices.push(
      `Sin conexión. Las rutinas se calculan igual; los eventos son los de la última descarga (${input.loadedAtLabel}).`
    );
  }
  if (input.outsideWindow) {
    notices.push(
      'Fuera de lo descargado: se ven las rutinas que tocan, pero los eventos del calendario y quién marcó cada cosa necesitan conexión.'
    );
  }
  return notices;
}

// ─────────────────────────────────────────────────────────────────────────────
// Días con sus rutinas y sus eventos
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Estado de una ocurrencia. `missed` describe un hecho —pasó y nadie la
 * marcó—, nunca una nota; `unknown` es «esto cae fuera de lo descargado».
 */
export type OccurrenceState = 'done' | 'due' | 'missed' | 'unknown' | 'upcoming';

export interface CalendarRoutineItem {
  routineId: string;
  title: string;
  details: string;
  audienceLabel: string;
  cadence: string;
  dueOn: string;
  state: OccurrenceState;
  /** Quién la marcó; solo con `state === 'done'`. */
  doneBy: string | null;
  /** Días entre la ocurrencia y su marcado (0 = el mismo día). */
  doneLateDays: number | null;
  /**
   * Marcar hecha solo lo de HOY y lo atrasado que de verdad se arrastra. El
   * futuro no se marca (sería mentira) y una ocurrencia `skip` pasada tampoco:
   * su semántica es justamente que caducó al acabar su día.
   */
  canComplete: boolean;
}

export interface CalendarDay {
  dateISO: string;
  isToday: boolean;
  /** ¿Se han descargado los eventos y las finalizaciones de este día? */
  known: boolean;
  routines: CalendarRoutineItem[];
  events: CalendarEventView[];
}

export interface CalendarDaysInput {
  routines: readonly CalendarRoutineView[];
  completions: readonly CalendarCompletionView[];
  events: readonly CalendarEventView[];
  fromISO: string;
  toISO: string;
  todayISO: string;
  /** Ventana con detalle descargado (eventos y autoría). */
  knownFromISO: string;
  knownToISO: string;
}

/** Días transcurridos entre dos fechas ISO; solo para «se marcó 2 días después». */
export function daysBetween(fromISO: string, toISO: string): number {
  return Math.round(
    (Date.parse(`${toISO}T00:00:00Z`) - Date.parse(`${fromISO}T00:00:00Z`)) / 86_400_000
  );
}

/**
 * Ocurrencias de una regla en la ventana, blindadas: una regla incoherente
 * (una fila vieja, un patrón que la base ya no acepta) devuelve la lista vacía
 * en vez de tumbar la pantalla entera. El calendario es de solo lectura; que un
 * dato raro esconda una rutina es malo, que apague la página es peor.
 */
function safeOccurrences(
  routine: CalendarRoutineView,
  fromISO: string,
  toISO: string,
  limit: number
): string[] {
  if (routine.rule === null) return [];
  try {
    return occurrencesBetween(routine.rule, fromISO, toISO, { limit });
  } catch {
    return [];
  }
}

function completionKey(routineId: string, dueOn: string): string {
  return `${routineId} ${dueOn}`;
}

/**
 * Primera ocurrencia posterior a `dueOn`, para el chip optimista «Hecha ✓ ·
 * próxima el X». Mira poco más de un año: es de sobra para cualquier cadencia
 * que el modelo sabe expresar salvo las de varios años, donde el chip se queda
 * en «Hecha ✓» antes que inventar una fecha.
 */
export function nextOccurrenceAfter(rule: RoutineSchedule, dueOn: string): string | null {
  if (rule === null) return null;
  try {
    return (
      occurrencesBetween(rule, addDays(dueOn, 1), addDays(dueOn, 400), { limit: 1 })[0] ?? null
    );
  } catch {
    return null;
  }
}

/** Índice de finalizaciones por (rutina, ocurrencia): el `due_on` es la clave. */
export function indexCompletions(
  completions: readonly CalendarCompletionView[]
): Map<string, CalendarCompletionView> {
  const index = new Map<string, CalendarCompletionView>();
  for (const completion of completions) {
    index.set(completionKey(completion.routineId, completion.dueOn), completion);
  }
  return index;
}

/**
 * Los días de `[fromISO, toISO]` con sus rutinas y sus eventos. Devuelve
 * SIEMPRE todos los días del rango, también los vacíos: la rejilla del mes y la
 * tira de la semana necesitan la celda aunque no haya nada dentro.
 */
export function buildCalendarDays(input: CalendarDaysInput): CalendarDay[] {
  const span = daysBetween(input.fromISO, input.toISO) + 1;
  const completions = indexCompletions(input.completions);

  const byDay = new Map<string, CalendarDay>();
  const days: CalendarDay[] = [];
  for (let offset = 0; offset < span; offset += 1) {
    const dateISO = addDays(input.fromISO, offset);
    const day: CalendarDay = {
      dateISO,
      isToday: dateISO === input.todayISO,
      known: dateISO >= input.knownFromISO && dateISO <= input.knownToISO,
      routines: [],
      events: []
    };
    byDay.set(dateISO, day);
    days.push(day);
  }

  for (const routine of input.routines) {
    // Una regla no puede dar más de una ocurrencia por día: el tope natural es
    // el propio ancho de la ventana.
    for (const dueOn of safeOccurrences(routine, input.fromISO, input.toISO, span)) {
      const day = byDay.get(dueOn);
      if (!day) continue;
      const completion = completions.get(completionKey(routine.id, dueOn));
      let state: OccurrenceState;
      if (completion) state = 'done';
      else if (dueOn === input.todayISO) state = 'due';
      else if (dueOn > input.todayISO) state = 'upcoming';
      else state = day.known ? 'missed' : 'unknown';
      day.routines.push({
        routineId: routine.id,
        title: routine.title,
        details: routine.details,
        audienceLabel: routine.audienceLabel,
        cadence: routine.cadence,
        dueOn,
        state,
        doneBy: completion?.byName ?? null,
        doneLateDays: completion ? daysBetween(dueOn, completion.completedOn) : null,
        canComplete: state === 'due' || (state === 'missed' && routine.overduePolicy === 'carry')
      });
    }
  }

  for (const event of input.events) {
    byDay.get(event.dateISO)?.events.push(event);
  }

  return days;
}

// ─────────────────────────────────────────────────────────────────────────────
// Alcance «año»: densidad y lo señalado, nunca detalle ni marcado
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cuántas veces al año puede repetirse algo y seguir siendo «señalado». Por
 * encima de esto —quincenal, semanal, diario— marcar el día en la rejilla del
 * año no informa: informa el mes. Veinticuatro es «dos veces al mes».
 */
export const YEAR_HIGHLIGHT_MAX_OCCURRENCES = 24;

/** Tope de fechas por rutina al expandir un año. Una diaria da 365 o 366. */
const YEAR_OCCURRENCE_LIMIT = 400;

export interface YearHighlight {
  dateISO: string;
  day: number;
  title: string;
  cadence: string;
  audienceLabel: string;
}

export interface YearMonth {
  month: number;
  label: string;
  /** Días del mes (1..31) con alguna rutina prevista. */
  routineDays: boolean[];
  /** Días del mes con algún evento del calendario enlazado. */
  eventDays: boolean[];
  /** Lo poco frecuente de ese mes: lo que la vista de año existe para contestar. */
  highlights: YearHighlight[];
  /** Cuántos días del mes tienen algo previsto (rutina o evento). */
  busyDays: number;
}

const MONTH_LABELS = [
  'Enero',
  'Febrero',
  'Marzo',
  'Abril',
  'Mayo',
  'Junio',
  'Julio',
  'Agosto',
  'Septiembre',
  'Octubre',
  'Noviembre',
  'Diciembre'
] as const;

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * El año entero, mes a mes: qué días tienen algo previsto y cuáles son las
 * cosas poco frecuentes —el cambio de armarios, la revisión trimestral—, que
 * es la pregunta que esta vista existe para contestar (E1).
 *
 * Deliberadamente NO mira las finalizaciones: a escala de año, pintar lo hecho
 * y lo no hecho sería un mapa de calor del cumplimiento de una persona, que es
 * exactamente lo que la enmienda E2 prohíbe. El año enseña lo PREVISTO.
 */
export function buildCalendarYear(
  year: number,
  routines: readonly CalendarRoutineView[],
  eventDaysISO: readonly string[]
): YearMonth[] {
  const fromISO = `${year}-01-01`;
  const toISO = `${year}-12-31`;
  const months: YearMonth[] = MONTH_LABELS.map((label, index) => ({
    month: index + 1,
    label,
    routineDays: new Array<boolean>(daysInMonth(year, index + 1)).fill(false),
    eventDays: new Array<boolean>(daysInMonth(year, index + 1)).fill(false),
    highlights: [],
    busyDays: 0
  }));

  for (const routine of routines) {
    const occurrences = safeOccurrences(routine, fromISO, toISO, YEAR_OCCURRENCE_LIMIT);
    const rare = occurrences.length <= YEAR_HIGHLIGHT_MAX_OCCURRENCES;
    for (const dueOn of occurrences) {
      const month = months[Number(dueOn.slice(5, 7)) - 1];
      if (!month) continue;
      const day = Number(dueOn.slice(8, 10));
      month.routineDays[day - 1] = true;
      if (rare) {
        month.highlights.push({
          dateISO: dueOn,
          day,
          title: routine.title,
          cadence: routine.cadence,
          audienceLabel: routine.audienceLabel
        });
      }
    }
  }

  for (const dateISO of eventDaysISO) {
    if (!dateISO.startsWith(`${year}-`)) continue;
    const month = months[Number(dateISO.slice(5, 7)) - 1];
    if (month) month.eventDays[Number(dateISO.slice(8, 10)) - 1] = true;
  }

  for (const month of months) {
    month.highlights.sort((a, b) => (a.dateISO === b.dateISO ? 0 : a.dateISO < b.dateISO ? -1 : 1));
    month.busyDays = month.routineDays.filter(
      (value, index) => value || month.eventDays[index]
    ).length;
  }
  return months;
}
