import { isIsoDateString } from "./dates.js";
import { invariant } from "./errors.js";

/**
 * Vacaciones: derecho anual pactado y días naturales disfrutados.
 *
 * Todo se cuenta en DÍAS NATURALES, no laborables: es la unidad del contrato
 * («30 días naturales al año») y la única que no obliga a inventar un
 * calendario laboral que la casa no ha pactado.
 *
 * Dos decisiones que conviene tener a la vista porque el resto se apoya en
 * ellas:
 *
 * · EXCESO PERMITIDO. Si lo disfrutado supera el derecho, el saldo queda en
 *   negativo y se enseña. No se rechaza. La realidad manda: la familia apunta
 *   lo que de verdad pasó, y un registro que se niega a admitirlo empuja a no
 *   apuntar nada, que es peor. El número negativo es la conversación que hay
 *   que tener, no un error del programa.
 *
 * · PRORRATEO DEL PRIMER (Y ÚLTIMO) AÑO. Si el acuerdo empieza o acaba a mitad
 *   de año, el derecho de ese año se prorratea por los días naturales que el
 *   acuerdo cubre. Enseñar 30 días a quien empezó en noviembre sería mentir
 *   con un número redondo. El redondeo es hacia arriba, a favor de quien
 *   trabaja, y el año completo sale exacto (365/365 no infla nada).
 */

export interface VacationPeriodInput {
  /** Primer día natural de vacaciones, incluido. */
  readonly startsOn: string;
  /** Último día natural de vacaciones, incluido. */
  readonly endsOn: string;
}

export interface VacationYearBalanceInput {
  /** Año natural que se está mirando. */
  readonly year: number;
  /** Días naturales al año que pacta la versión del acuerdo vigente. */
  readonly annualVacationDays: number;
  /** Primer día del acuerdo. */
  readonly agreementStartsOn: string;
  /** Último día del acuerdo, o `null` si sigue vivo. */
  readonly agreementEndsOn?: string | null;
  /** Periodos VIGENTES (los anulados no se pasan: no cuentan). */
  readonly periods: readonly VacationPeriodInput[];
}

export interface VacationYearBalance {
  readonly year: number;
  /** Derecho de ESTE año, ya prorrateado si el acuerdo no lo cubre entero. */
  readonly entitledDays: number;
  /** Derecho anual completo pactado, para poder explicar el prorrateo. */
  readonly annualVacationDays: number;
  /** `true` si `entitledDays` es un prorrateo y no el derecho completo. */
  readonly prorated: boolean;
  /** Primer día del año cubierto por el acuerdo. */
  readonly coveredFrom: string;
  /** Último día del año cubierto por el acuerdo. */
  readonly coveredThrough: string;
  /** Días naturales del año que el acuerdo cubre. */
  readonly coveredDays: number;
  /** Días naturales del año (366 en bisiesto). */
  readonly daysInYear: number;
  /** Días disfrutados que caen dentro de este año. */
  readonly takenDays: number;
  /** Derecho menos disfrutado. NEGATIVO si se pasó: eso se enseña, no se oculta. */
  readonly remainingDays: number;
}

function assertIsoDate(value: string, label: string): void {
  invariant(isIsoDateString(value), "INVALID_VACATION_DATE", `${label} no es una fecha válida: ${value}`);
}

/** Días naturales entre dos fechas con AMBOS extremos incluidos: del 1 al 15 son 15. */
export function vacationCalendarDays(startsOn: string, endsOn: string): number {
  assertIsoDate(startsOn, "La fecha de inicio");
  assertIsoDate(endsOn, "La fecha de fin");
  invariant(
    endsOn >= startsOn,
    "INVALID_VACATION_INTERVAL",
    "Las vacaciones no pueden acabar antes de empezar.",
  );
  const from = Date.parse(`${startsOn}T00:00:00Z`);
  const through = Date.parse(`${endsOn}T00:00:00Z`);
  return Math.round((through - from) / 86_400_000) + 1;
}

/** Dos periodos se pisan si comparten al menos un día natural. */
export function vacationPeriodsOverlap(
  left: VacationPeriodInput,
  right: VacationPeriodInput,
): boolean {
  return left.startsOn <= right.endsOn && left.endsOn >= right.startsOn;
}

function daysInYear(year: number): number {
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return leap ? 366 : 365;
}

/**
 * Días de un periodo que caen DENTRO del año dado. Un periodo del 24 de
 * diciembre al 5 de enero no es «del año que empieza»: son ocho días de un año
 * y cinco del siguiente, y cada uno gasta el derecho de su año.
 */
export function vacationDaysInYear(period: VacationPeriodInput, year: number): number {
  assertIsoDate(period.startsOn, "La fecha de inicio");
  assertIsoDate(period.endsOn, "La fecha de fin");
  const from = period.startsOn > `${year}-01-01` ? period.startsOn : `${year}-01-01`;
  const through = period.endsOn < `${year}-12-31` ? period.endsOn : `${year}-12-31`;
  if (through < from) return 0;
  return vacationCalendarDays(from, through);
}

/**
 * Saldo de vacaciones de un año natural. `remainingDays` puede salir negativo
 * a propósito (ver la cabecera del módulo).
 */
export function vacationYearBalance(input: VacationYearBalanceInput): VacationYearBalance {
  invariant(
    Number.isInteger(input.year) && input.year >= 1970 && input.year <= 9999,
    "INVALID_VACATION_YEAR",
    `Año no válido: ${input.year}`,
  );
  invariant(
    Number.isInteger(input.annualVacationDays) && input.annualVacationDays >= 0,
    "INVALID_VACATION_ENTITLEMENT",
    "El derecho anual de vacaciones debe ser un número entero de días no negativo.",
  );
  assertIsoDate(input.agreementStartsOn, "El inicio del acuerdo");
  const agreementEndsOn = input.agreementEndsOn ?? null;
  if (agreementEndsOn !== null) assertIsoDate(agreementEndsOn, "El fin del acuerdo");

  const yearStart = `${input.year}-01-01`;
  const yearEnd = `${input.year}-12-31`;
  const coveredFrom = input.agreementStartsOn > yearStart ? input.agreementStartsOn : yearStart;
  const coveredThrough =
    agreementEndsOn !== null && agreementEndsOn < yearEnd ? agreementEndsOn : yearEnd;
  const total = daysInYear(input.year);
  const coveredDays = coveredThrough < coveredFrom ? 0 : vacationCalendarDays(coveredFrom, coveredThrough);

  const prorated = coveredDays < total;
  // Redondeo hacia arriba, a favor de quien trabaja. Con el año entero el
  // cociente es exacto, así que el caso normal no se infla.
  const entitledDays = prorated
    ? Math.ceil((input.annualVacationDays * coveredDays) / total)
    : input.annualVacationDays;

  const takenDays = input.periods.reduce(
    (accumulated, period) => accumulated + vacationDaysInYear(period, input.year),
    0,
  );

  return Object.freeze({
    year: input.year,
    entitledDays,
    annualVacationDays: input.annualVacationDays,
    prorated,
    coveredFrom,
    coveredThrough,
    coveredDays,
    daysInYear: total,
    takenDays,
    remainingDays: entitledDays - takenDays,
  });
}
