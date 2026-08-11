import {
  SEASONS,
  cadenceClause,
  spanishDateLabel,
  weekdayName,
  type RoutineSchedule
} from '@casa-clara/domain';

/**
 * Capa fina de presentación de la cadencia de una rutina (§4.1 de
 * `docs/rutinas-y-calendario.md`).
 *
 * Aquí NO se calcula recurrencia. Las frases y las fechas las produce el motor
 * puro `@casa-clara/domain` (`recurrence.ts`), que es el único sitio donde vive
 * la aritmética —la ola anterior la tenía triplicada y ese fue el fallo—. Este
 * módulo solo traduce entre la regla del dominio y los cinco controles que la
 * familia ve, con los literales exactos que fija la especificación.
 */

/**
 * Las cinco respuestas a «¿Cuándo toca?». Son a la vez las opciones del
 * formulario y los títulos de los grupos de la lista: la pantalla nombra una
 * sola vez cada clase de ritmo.
 */
export type CadenceChoice = 'daily' | 'weekdays' | 'interval' | 'season' | 'unset';

export interface CadenceChoiceCopy {
  readonly value: CadenceChoice;
  /** Literal de §4.5: etiqueta del radio Y encabezado de grupo, idénticos. */
  readonly label: string;
  /** Ayuda bajo el subcontrol revelado, o `null` si la opción no lleva. */
  readonly help: string | null;
}

export const CADENCE_CHOICES: readonly CadenceChoiceCopy[] = Object.freeze([
  Object.freeze({ value: 'daily' as const, label: 'Todos los días', help: null }),
  Object.freeze({
    value: 'weekdays' as const,
    label: 'Días fijos de la semana',
    help: 'Marca los días que toca.'
  }),
  Object.freeze({ value: 'interval' as const, label: 'Cada cierto tiempo', help: null }),
  Object.freeze({
    value: 'season' as const,
    label: 'Por temporada',
    help: 'Te avisará el primer día de cada temporada que marques.'
  }),
  Object.freeze({
    value: 'unset' as const,
    label: 'Todavía no lo sabemos',
    help: 'Quedará apuntada en esta página. No aparecerá en Hoy hasta que le pongáis día.'
  })
]);

/**
 * Unidades del selector de «Cada cierto tiempo»: día(s) · semana(s) · mes(es).
 * «Trimestre» se va a propósito (§4.1): «cada 3 meses» dice lo mismo en lengua
 * de casa y evita que la familia lea «cada 2 trimestres» para decir «medio año».
 */
export type IntervalUnit = 'days' | 'weeks' | 'months';

/**
 * El tope de cada unidad es el de la base, traído al control para que el
 * formulario no pueda escribir una regla que la CHECK `routines_pattern_shape`
 * rechace: `every_n_days` admite 1..366 (52 semanas son 364 días) y
 * `day_of_month` admite 1..36 meses.
 */
const INTERVAL_UNITS: Readonly<
  Record<IntervalUnit, { readonly singular: string; readonly plural: string; readonly max: number }>
> = Object.freeze({
  days: { singular: 'día', plural: 'días', max: 366 },
  weeks: { singular: 'semana', plural: 'semanas', max: 52 },
  months: { singular: 'mes', plural: 'meses', max: 36 }
});

export const INTERVAL_UNIT_VALUES: readonly IntervalUnit[] = Object.freeze([
  'days' as const,
  'weeks' as const,
  'months' as const
]);

/** «semana» o «semanas» según la cifra elegida: nada de «cada 1 semana(s)». */
export function intervalUnitLabel(unit: IntervalUnit, count: number): string {
  const copy = INTERVAL_UNITS[unit];
  return count === 1 ? copy.singular : copy.plural;
}

export function intervalUnitMax(unit: IntervalUnit): number {
  return INTERVAL_UNITS[unit].max;
}

export interface WeekdayButton {
  /** ISO 1=lunes … 7=domingo, la convención del motor y de `extract(isodow …)`. */
  readonly iso: number;
  /** La inicial que se ve, L M X J V S D; decorativa. */
  readonly initial: string;
  /** El nombre entero, que es lo que anuncia el lector de pantalla. */
  readonly name: string;
}

const WEEKDAY_INITIALS = ['L', 'M', 'X', 'J', 'V', 'S', 'D'] as const;

/** Los siete botones, lunes primero, con su nombre completo para el `aria-label`. */
export const WEEKDAY_BUTTONS: readonly WeekdayButton[] = Object.freeze(
  WEEKDAY_INITIALS.map((initial, index) =>
    Object.freeze({ iso: index + 1, initial, name: weekdayName(index + 1) })
  )
);

/** Primavera · Verano · Otoño · Invierno, con su mes meteorológico de inicio. */
export { SEASONS };

/**
 * Estado del bloque «¿Cuándo toca?». Es lo que el formulario liga a sus
 * controles; `scheduleFromForm` lo convierte en la regla que viaja al servidor.
 */
export interface CadenceForm {
  choice: CadenceChoice;
  /** ISO 1..7 marcados en «Días fijos de la semana». */
  weekdays: number[];
  /** La cifra de «cada [2] [semanas]». */
  intervalCount: number;
  intervalUnit: IntervalUnit;
  /**
   * «¿Cuándo toca la próxima vez?» → escribe `anchor_on`. Solo «Cada cierto
   * tiempo» lo pregunta; en las demás ramas la fecha es derivada y pedirla
   * sería pedir a la familia que resuelva a mano lo que la app ya sabe.
   */
  anchorOn: string;
  /** Meses de inicio de las temporadas marcadas. */
  months: number[];
  /**
   * Día del mes de `day_of_month`; `null` = se deriva de `anchorOn`. Se
   * conserva al editar para que una rutina anclada el 31 no se degrade a 28 al
   * pasar por el formulario, que es justo la deriva que esta ola arregla.
   */
  monthDay: number | null;
  /**
   * Semanas entre semanas activas de `days_of_week`. La fase 1 no tiene control
   * («Días fijos de la semana» escribe 1), pero editar el título de la compra
   * personal quincenal —sembrada como `days_of_week` cada 2 semanas— no puede
   * convertirla en semanal a espaldas de nadie: se conserva, y la frase de
   * vuelta lo dice en voz alta («cada 2 semanas, los lunes»).
   */
  weekRepeatEvery: number;
  /** No hay control para `ends_on` (§2.10); se conserva para no borrarlo al editar. */
  endsOn: string | null;
}

export function emptyCadenceForm(todayISO: string): CadenceForm {
  return {
    choice: 'daily',
    weekdays: [],
    intervalCount: 2,
    intervalUnit: 'weeks',
    anchorOn: todayISO,
    months: [],
    monthDay: null,
    weekRepeatEvery: 1,
    endsOn: null
  };
}

function ascending(values: readonly number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

/** El día del mes que declara una fecha ISO, para anclar `day_of_month`. */
function monthDayOf(dateISO: string): number {
  return Number(dateISO.slice(8, 10));
}

/**
 * Los controles → la regla. `null` es un valor de primera clase, no un hueco:
 * significa «se hace, falta decidir cuándo» (§2.3).
 */
export function scheduleFromForm(form: CadenceForm): RoutineSchedule {
  const endsOn = form.endsOn;
  switch (form.choice) {
    case 'unset':
      return null;
    case 'daily':
      return { pattern: 'every_n_days', anchorOn: form.anchorOn, repeatEvery: 1, endsOn };
    case 'weekdays':
      return {
        pattern: 'days_of_week',
        anchorOn: form.anchorOn,
        repeatEvery: form.weekRepeatEvery,
        weekdays: ascending(form.weekdays),
        endsOn
      };
    case 'season':
      return {
        pattern: 'months_of_year',
        anchorOn: form.anchorOn,
        months: ascending(form.months),
        monthDay: 1,
        endsOn
      };
    case 'interval':
      return form.intervalUnit === 'months'
        ? {
            pattern: 'day_of_month',
            anchorOn: form.anchorOn,
            repeatEvery: form.intervalCount,
            monthDay: form.monthDay ?? monthDayOf(form.anchorOn),
            endsOn
          }
        : {
            pattern: 'every_n_days',
            anchorOn: form.anchorOn,
            repeatEvery:
              form.intervalUnit === 'weeks' ? form.intervalCount * 7 : form.intervalCount,
            endsOn
          };
  }
}

/** ¿Falta algo por marcar para que la regla sea válida? */
export function cadenceFormIsComplete(form: CadenceForm): boolean {
  if (form.choice === 'weekdays') return form.weekdays.length > 0;
  if (form.choice === 'season') return form.months.length > 0;
  if (form.choice === 'interval') return form.anchorOn !== '' && form.intervalCount >= 1;
  return true;
}

/**
 * En qué grupo cae una rutina. Es la misma clasificación que el formulario, de
 * modo que la lista y el alta hablan de las mismas cinco clases de ritmo.
 */
export function cadenceChoiceOf(schedule: RoutineSchedule): CadenceChoice {
  if (schedule === null) return 'unset';
  switch (schedule.pattern) {
    case 'every_n_days':
      return schedule.repeatEvery === 1 ? 'daily' : 'interval';
    case 'days_of_week':
      return 'weekdays';
    case 'day_of_month':
      return 'interval';
    case 'months_of_year':
      return 'season';
  }
}

export interface CadenceGroup<T> {
  readonly choice: CadenceChoice;
  /** El mismo literal que la opción del formulario, palabra por palabra. */
  readonly title: string;
  readonly items: readonly T[];
}

/**
 * La lista agrupada por clase de ritmo, en el orden de las cinco opciones y sin
 * grupos vacíos. En Rutinas se GESTIONA —el eje útil es «qué clase de ritmo
 * tiene esto»—; en Hoy se HACE, y allí el eje es «qué me queda». Dos páginas,
 * dos ordenaciones, a propósito.
 */
export function groupByCadence<T extends { readonly schedule: RoutineSchedule }>(
  routines: readonly T[]
): CadenceGroup<T>[] {
  return CADENCE_CHOICES.map(({ value, label }) => ({
    choice: value,
    title: label,
    items: routines.filter((routine) => cadenceChoiceOf(routine.schedule) === value)
  })).filter((group) => group.items.length > 0);
}

/**
 * La regla → los controles, para editar. `nextOccurrenceOn` importa solo en
 * «Cada cierto tiempo», donde la fecha visible se llama «¿Cuándo toca la
 * próxima vez?» y enseñar el ancla original (que puede ser de hace años) sería
 * mentir. Reanclar en la próxima ocurrencia NO cambia la cadencia: esa fecha
 * es, por construcción, una ocurrencia de la misma regla —el mismo argumento
 * con el que la migración 0023 ancla en la próxima fecha sin mover ninguna—.
 */
export function formFromSchedule(
  schedule: RoutineSchedule,
  options: { readonly todayISO: string; readonly nextOccurrenceOn?: string | null }
): CadenceForm {
  const base = emptyCadenceForm(options.todayISO);
  if (schedule === null) return { ...base, choice: 'unset' };
  const endsOn = schedule.endsOn ?? null;
  const nextOrAnchor = options.nextOccurrenceOn ?? schedule.anchorOn;
  switch (schedule.pattern) {
    case 'every_n_days': {
      if (schedule.repeatEvery === 1) {
        return { ...base, choice: 'daily', anchorOn: schedule.anchorOn, endsOn };
      }
      const weeks = schedule.repeatEvery % 7 === 0 ? schedule.repeatEvery / 7 : null;
      return {
        ...base,
        choice: 'interval',
        intervalUnit: weeks === null ? 'days' : 'weeks',
        intervalCount: weeks ?? schedule.repeatEvery,
        anchorOn: nextOrAnchor,
        endsOn
      };
    }
    case 'days_of_week':
      return {
        ...base,
        choice: 'weekdays',
        weekdays: [...schedule.weekdays],
        weekRepeatEvery: schedule.repeatEvery,
        anchorOn: schedule.anchorOn,
        endsOn
      };
    case 'day_of_month':
      return {
        ...base,
        choice: 'interval',
        intervalUnit: 'months',
        intervalCount: schedule.repeatEvery,
        monthDay: schedule.monthDay,
        anchorOn: nextOrAnchor,
        endsOn
      };
    case 'months_of_year':
      return {
        ...base,
        choice: 'season',
        months: [...schedule.months],
        anchorOn: schedule.anchorOn,
        endsOn
      };
  }
}

/**
 * Segunda línea de la lista: «los lunes y los jueves · la próxima, el jueves 13
 * de agosto». La cadencia sale de `cadenceClause`, la MISMA función que sostiene
 * la frase de vuelta del formulario, para que editar una rutina no la haga
 * leerse distinta de como se leía en la lista.
 *
 * «Todos los días» no lleva próxima fecha: es hoy, siempre. Las temporadas la
 * llevan sin día de la semana, que a seis meses vista es ruido.
 */
export function cadenceSummary(
  schedule: RoutineSchedule,
  nextOccurrenceOn: string | null,
  todayISO?: string
): string {
  const clause = cadenceClause(schedule);
  if (schedule === null || nextOccurrenceOn === null) return clause;
  // Lo vencido dice que está vencido, aquí también. Hoy ya lo hacía bien
  // («Vencía el 9 ago») y Rutinas seguía anunciando «la próxima, el dom, 9 ago»
  // para una fecha que ya pasó: una fecha en futuro para algo atrasado no es
  // un matiz de redacción, es decirle a quien la lee que va bien de tiempo.
  if (todayISO && nextOccurrenceOn < todayISO) {
    return `${clause} · vencía el ${spanishDateLabel(nextOccurrenceOn, { weekday: false })}`;
  }
  if (schedule.pattern === 'every_n_days' && schedule.repeatEvery === 1) return clause;
  const weekday = schedule.pattern !== 'months_of_year';
  return `${clause} · la próxima, el ${spanishDateLabel(nextOccurrenceOn, { weekday })}`;
}
