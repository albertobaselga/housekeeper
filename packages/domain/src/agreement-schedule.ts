import { invariant } from "./errors.js";

/**
 * El horario pactado en una versión del contrato: a qué hora se entra, a qué
 * hora se sale, qué días se libra y cuánto dura el descanso largo.
 *
 * Es el reflejo puro de `app.agreement_schedules` y
 * `app.agreement_schedule_days` (migración 0025). Vive aquí porque tres capas
 * necesitan las mismas tres respuestas —«¿cuánto suma esto a la semana?»,
 * «¿cuadra con lo contratado?» y «¿cómo se dice en castellano llano?»— y
 * ninguna de las tres debería contestarlas por su cuenta.
 *
 * DOS DECISIONES que conviene tener a la vista porque todo lo demás se apoya en
 * ellas:
 *
 * · SOLO SE APUNTA LO QUE SE DESVÍA. Un día sin fila propia trabaja la jornada
 *   tipo. La consecuencia honesta —y deliberada— es que un horario que no
 *   declara ninguna libranza se lee como siete días de trabajo. No se inventa
 *   un «de lunes a viernes» que nadie pactó: si el contrato no dice qué día se
 *   libra, la semana sale enorme, no cuadra con la jornada contratada y la
 *   pantalla lo dice. Es justo lo que hay que arreglar pactándolo.
 *
 * · LA INCOHERENCIA SE CUENTA, NO SE CORRIGE. `scheduleCoherence` compara los
 *   minutos que suma el horario con los `contractedWeeklyMinutes` de la versión
 *   y devuelve la diferencia. No lanza, no ajusta y no elige un ganador: que el
 *   horario y la jornada contratada se contradigan es una conversación
 *   pendiente entre dos personas, y el programa solo tiene que ponerla encima
 *   de la mesa.
 */

/** ISO-8601, igual que la columna `weekday`: 1 lunes … 7 domingo. */
export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export const WEEKDAYS: readonly Weekday[] = Object.freeze([1, 2, 3, 4, 5, 6, 7]);

const WEEKDAY_NAMES: Readonly<Record<Weekday, string>> = Object.freeze({
  1: "lunes",
  2: "martes",
  3: "miércoles",
  4: "jueves",
  5: "viernes",
  6: "sábado",
  7: "domingo",
});

export function weekdayName(weekday: Weekday): string {
  return WEEKDAY_NAMES[weekday];
}

/** Excepción de un día concreto. `null` en un campo = «como la jornada tipo». */
export interface ScheduleDay {
  readonly weekday: Weekday;
  /** false = libranza. */
  readonly works: boolean;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly longBreakMinutes: number | null;
  readonly note: string;
}

export interface AgreementSchedule {
  /** «HH:MM», hora de entrada de la jornada tipo. */
  readonly startsAt: string;
  /** «HH:MM», hora de salida de la jornada tipo. */
  readonly endsAt: string;
  /** Minutos del descanso largo del mediodía. 0 = no se pactó ninguno. */
  readonly longBreakMinutes: number;
  readonly note: string;
  /** Solo los días que se desvían; los demás siguen la jornada tipo. */
  readonly days: readonly ScheduleDay[];
}

/** Lo que de verdad se trabaja un día concreto, ya resuelto contra el tipo. */
export interface ResolvedDay {
  readonly weekday: Weekday;
  readonly works: boolean;
  /** null los días de libranza. */
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly longBreakMinutes: number;
  /** Minutos efectivos: presencia menos descanso. 0 los días de libranza. */
  readonly effectiveMinutes: number;
  /** true si este día NO es la jornada tipo (libra o cambia alguna hora). */
  readonly differs: boolean;
  readonly note: string;
}

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** «08:30» → 510. Rechaza cualquier cosa que no sea una hora del día. */
export function minutesOfDay(time: string): number {
  const match = TIME_PATTERN.exec(time);
  invariant(
    match !== null,
    "INVALID_SCHEDULE_TIME",
    `«${time}» no es una hora válida del día en formato HH:MM.`,
  );
  return Number(match![1]) * 60 + Number(match![2]);
}

/**
 * «08:30» → «8:30». Sin el cero de cortesía, que es como se dice una hora en
 * voz alta y como la pidió el propietario: «De 7:30 a 20:30».
 */
export function spokenTime(time: string): string {
  minutesOfDay(time);
  return time.startsWith("0") ? time.slice(1) : time;
}

/**
 * Un rato en palabras: «hora y media», «dos horas», «media hora». Se cae a
 * «1 h 20 min» cuando no hay una forma corriente de decirlo, porque inventar
 * «una hora y un tercio» sería peor que el número.
 */
export function spokenDuration(minutes: number): string {
  invariant(
    Number.isSafeInteger(minutes) && minutes >= 0,
    "INVALID_SCHEDULE_DURATION",
    "Una duración de descanso tiene que ser un entero de minutos no negativo.",
  );
  const named: Record<number, string> = {
    15: "un cuarto de hora",
    30: "media hora",
    45: "tres cuartos de hora",
    60: "una hora",
    90: "hora y media",
    120: "dos horas",
    150: "dos horas y media",
    180: "tres horas",
  };
  if (named[minutes]) return named[minutes]!;
  const hours = Math.trunc(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

function dayOf(schedule: Readonly<AgreementSchedule>, weekday: Weekday): ScheduleDay | undefined {
  return schedule.days.find((day) => day.weekday === weekday);
}

/**
 * Qué se trabaja un día de la semana, ya resuelto: la excepción manda sobre la
 * jornada tipo campo a campo, y lo que la excepción calla lo pone el tipo.
 */
export function resolveDay(
  schedule: Readonly<AgreementSchedule>,
  weekday: Weekday,
): ResolvedDay {
  const exception = dayOf(schedule, weekday);

  if (exception && !exception.works) {
    return {
      weekday,
      works: false,
      startsAt: null,
      endsAt: null,
      longBreakMinutes: 0,
      effectiveMinutes: 0,
      differs: true,
      note: exception.note,
    };
  }

  const startsAt = exception?.startsAt ?? schedule.startsAt;
  const endsAt = exception?.endsAt ?? schedule.endsAt;
  const longBreakMinutes = exception?.longBreakMinutes ?? schedule.longBreakMinutes;
  const presence = minutesOfDay(endsAt) - minutesOfDay(startsAt);
  invariant(
    presence > 0,
    "INVALID_SCHEDULE_DAY",
    `El ${weekdayName(weekday)} termina antes de empezar.`,
  );
  invariant(
    longBreakMinutes < presence,
    "INVALID_SCHEDULE_DAY",
    `El descanso del ${weekdayName(weekday)} no cabe en la jornada.`,
  );

  return {
    weekday,
    works: true,
    startsAt,
    endsAt,
    longBreakMinutes,
    effectiveMinutes: presence - longBreakMinutes,
    // Una excepción que existe siempre desvía algo: la base de datos rechaza
    // las filas que no cambian nada ni explican nada (CHECK de 0025).
    differs: exception !== undefined,
    note: exception?.note ?? "",
  };
}

/** La semana entera resuelta, de lunes a domingo. */
export function resolveWeek(schedule: Readonly<AgreementSchedule>): readonly ResolvedDay[] {
  return Object.freeze(WEEKDAYS.map((weekday) => resolveDay(schedule, weekday)));
}

/** Minutos efectivos que suma la semana según el horario. */
export function weeklyEffectiveMinutes(schedule: Readonly<AgreementSchedule>): number {
  return resolveWeek(schedule).reduce((total, day) => total + day.effectiveMinutes, 0);
}

/** Los días que no se trabajan, en orden de lunes a domingo. */
export function restDays(schedule: Readonly<AgreementSchedule>): readonly Weekday[] {
  return Object.freeze(
    resolveWeek(schedule)
      .filter((day) => !day.works)
      .map((day) => day.weekday),
  );
}

export interface ScheduleCoherence {
  /** Lo que suma el horario. */
  readonly weeklyMinutes: number;
  /** Lo que dice la versión del contrato. */
  readonly contractedWeeklyMinutes: number;
  /** Horario menos contrato. Positivo = el horario pide más de lo pactado. */
  readonly differenceMinutes: number;
  readonly matches: boolean;
}

/**
 * ¿Cuadra el horario con la jornada contratada de la misma versión?
 *
 * Sin tolerancia y sin redondeo: los dos lados son minutos enteros, así que
 * cualquier diferencia es real y merece decirse. Quien llama decide qué hacer
 * con ella; aquí no se lanza, porque un horario que no cuadra es un dato
 * legítimo que hay que poder guardar y mirar.
 */
export function scheduleCoherence(
  schedule: Readonly<AgreementSchedule>,
  contractedWeeklyMinutes: number,
): ScheduleCoherence {
  const weeklyMinutes = weeklyEffectiveMinutes(schedule);
  const differenceMinutes = weeklyMinutes - contractedWeeklyMinutes;
  return {
    weeklyMinutes,
    contractedWeeklyMinutes,
    differenceMinutes,
    matches: differenceMinutes === 0,
  };
}

function capitalise(text: string): string {
  return text.length === 0 ? text : text[0]!.toLocaleUpperCase("es") + text.slice(1);
}

/** «lunes, martes y jueves» — la lista como la diría una persona. */
function joinNatural(items: readonly string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0]!;
  return `${items.slice(0, -1).join(", ")} y ${items[items.length - 1]}`;
}

/**
 * El horario en castellano llano, que es lo único que la empleada tiene que
 * leer: «De 8:00 a 16:30, con hora y media de descanso al mediodía. Sábado
 * hasta las 14:30. Domingo libre.»
 *
 * Se construye en tres frases, y cada una desaparece si no tiene nada que
 * decir. Los días que cambian se AGRUPAN por el horario que comparten, para no
 * repetir la misma frase dos veces cuando dos días acaban a la misma hora
 * («Jueves y sábado hasta las 15:00»).
 */
export function describeSchedule(schedule: Readonly<AgreementSchedule>): string {
  const week = resolveWeek(schedule);
  const sentences: string[] = [];

  const standard = `De ${spokenTime(schedule.startsAt)} a ${spokenTime(schedule.endsAt)}`;
  sentences.push(
    schedule.longBreakMinutes > 0
      ? `${standard}, con ${spokenDuration(schedule.longBreakMinutes)} de descanso al mediodía.`
      : `${standard}.`,
  );

  // Días trabajados que se salen del tipo, agrupados por la forma en que se
  // salen: la clave es el propio texto que los describe.
  const grouped = new Map<string, Weekday[]>();
  for (const day of week) {
    if (!day.works || !day.differs) continue;
    const changesStart = day.startsAt !== schedule.startsAt;
    const changesEnd = day.endsAt !== schedule.endsAt;
    const changesBreak = day.longBreakMinutes !== schedule.longBreakMinutes;
    let phrase: string;
    if (changesStart && changesEnd) {
      phrase = `de ${spokenTime(day.startsAt!)} a ${spokenTime(day.endsAt!)}`;
    } else if (changesEnd) {
      phrase = `hasta las ${spokenTime(day.endsAt!)}`;
    } else if (changesStart) {
      phrase = `desde las ${spokenTime(day.startsAt!)}`;
    } else if (changesBreak) {
      phrase =
        day.longBreakMinutes > 0
          ? `con ${spokenDuration(day.longBreakMinutes)} de descanso`
          : "sin descanso al mediodía";
    } else {
      // Solo trae nota: no cambia ninguna hora, así que no entra en este
      // párrafo. La nota se enseña aparte, con su día.
      continue;
    }
    const list = grouped.get(phrase) ?? [];
    list.push(day.weekday);
    grouped.set(phrase, list);
  }
  for (const [phrase, days] of grouped) {
    sentences.push(`${capitalise(joinNatural(days.map(weekdayName)))} ${phrase}.`);
  }

  const free = restDays(schedule);
  if (free.length > 0) {
    sentences.push(
      `${capitalise(joinNatural(free.map(weekdayName)))} ${free.length === 1 ? "libre" : "libres"}.`,
    );
  }

  return sentences.join(" ");
}
