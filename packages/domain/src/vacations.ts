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

// ─── Lo que todavía no se le ha contado ──────────────────────────────────────

/**
 * Un periodo tal y como lo guarda `app.vacation_periods`, con los dos sellos
 * de tiempo que dicen cuándo pasó cada cosa. Es EL MISMO hecho que pinta la
 * sección de vacaciones: aquí no hay una copia ni un aviso aparte.
 */
export interface VacationEventInput extends VacationPeriodInput {
  readonly status: "recorded" | "voided";
  /** Instante en que la administración lo apuntó. */
  readonly recordedAt: string;
  /** Instante en que lo anuló, o `null` si sigue vigente. */
  readonly voidedAt?: string | null;
}

export interface VacationNews {
  /** Periodos vigentes apuntados después de la marca: días nuevos para ella. */
  readonly recorded: readonly VacationEventInput[];
  /**
   * Periodos que ella YA había visto apuntados y que se han anulado después.
   * Los que se apuntaron y se anularon sin que llegara a verlos no salen: no
   * llegaron a ser suyos, y contarlos sería ruido con forma de noticia.
   */
  readonly voided: readonly VacationEventInput[];
  /** `recorded.length + voided.length`. Cero = nada que contar. */
  readonly count: number;
  /**
   * Instante más reciente de TODO lo mirado, sea nuevo o no. Es la marca de
   * agua que hay que guardar cuando ella lo ve: guardar `now()` en su lugar
   * daría por contado lo que se apuntara mientras la pantalla estaba abierta.
   * `null` si no hay ni un periodo.
   */
  readonly newestAt: string | null;
}

function instant(value: string, label: string): number {
  const parsed = Date.parse(value);
  invariant(
    Number.isFinite(parsed),
    "INVALID_VACATION_INSTANT",
    `${label} no es un instante válido: ${value}`,
  );
  return parsed;
}

/**
 * Qué le ha pasado a sus vacaciones desde la última vez que miró.
 *
 * La regla vive aquí, en el dominio, y no dentro de la pantalla que hoy la
 * usa, porque va a tener dos consumidores: el aviso dentro de la aplicación y
 * —cuando exista— la notificación al móvil (docs/notificaciones.md). Dos copias
 * de esta regla serían dos definiciones distintas de «nuevo», y la segunda
 * acabaría avisando de cosas que la primera ya había dado por vistas.
 *
 * `seenThrough` es la marca de agua de `app.vacation_notice_marks`; `null`
 * significa que nunca ha mirado, y entonces todo lo vigente es nuevo.
 */
export function vacationNewsSince(
  periods: readonly VacationEventInput[],
  seenThrough: string | null,
): VacationNews {
  const seen = seenThrough === null ? null : instant(seenThrough, "La marca de lo ya visto");
  const recorded: VacationEventInput[] = [];
  const voided: VacationEventInput[] = [];
  let newest = Number.NEGATIVE_INFINITY;
  let newestValue: string | null = null;

  for (const period of periods) {
    const recordedAt = instant(period.recordedAt, "El sello de lo apuntado");
    if (recordedAt > newest) {
      newest = recordedAt;
      newestValue = period.recordedAt;
    }
    const voidedAt =
      period.voidedAt === undefined || period.voidedAt === null
        ? null
        : instant(period.voidedAt, "El sello de la anulación");
    if (voidedAt !== null && voidedAt > newest) {
      newest = voidedAt;
      newestValue = period.voidedAt ?? null;
    }

    if (period.status === "recorded") {
      if (seen === null || recordedAt > seen) recorded.push(period);
      continue;
    }
    // Anulado: solo es noticia si llegó a verlo apuntado. Si nació y murió
    // entre dos miradas suyas, para ella nunca existió.
    if (voidedAt !== null && seen !== null && voidedAt > seen && recordedAt <= seen) {
      voided.push(period);
    }
  }

  // Del más reciente al más antiguo dentro de cada grupo: lo último que le han
  // apuntado es lo primero que quiere leer.
  const byRecency = (left: VacationEventInput, right: VacationEventInput): number =>
    Date.parse(right.recordedAt) - Date.parse(left.recordedAt);

  return Object.freeze({
    recorded: Object.freeze([...recorded].sort(byRecency)),
    voided: Object.freeze([...voided].sort(byRecency)),
    count: recorded.length + voided.length,
    newestAt: newestValue,
  });
}
