import { addCalendarDays, isIsoDateString, localDate } from "./dates.js";
import { invariant } from "./errors.js";
import { formatEuroCents, moneyCents, type MoneyCents } from "./money.js";
// Los meses se dicen en un solo sitio del dominio: `agreement-schedule.ts` ya
// hizo lo mismo con los días de la semana. Una tercera copia de «marzo» sería
// la misma frase con dos verdades el día que una de las dos cambie.
import { monthName } from "./recurrence.js";

/**
 * Vacaciones: derecho pactado por AÑO DE CONTRATO y días naturales disfrutados.
 *
 * Todo se cuenta en DÍAS NATURALES, no laborables: es la unidad del contrato
 * («30 días naturales al año») y la única que no obliga a inventar un
 * calendario laboral que la casa no ha pactado.
 *
 * Cinco decisiones que conviene tener a la vista porque el resto se apoya en
 * ellas:
 *
 * · EL AÑO ES EL DEL CONTRATO, NO EL DEL CALENDARIO. «Hasta que se cumplan los
 *   doce meses del inicio del contrato, ese es el periodo en el que se calculan
 *   los días de vacaciones». Un contrato que empezó el 5 de marzo de 2025 tiene
 *   su primer año del 5-mar-2025 al 4-mar-2026, el segundo del 5-mar-2026 al
 *   4-mar-2027, y así. El aniversario ABRE el año nuevo; el día anterior cierra
 *   el viejo.
 *
 * · POR ESO NO SE PRORRATEA EL PRIMER AÑO. Antes el corte era el 1 de enero y
 *   quien empezaba en noviembre veía un derecho recortado. Ahora el año empieza
 *   el día del contrato, así que se devenga el derecho completo. El prorrateo
 *   sobrevive sólo para el ÚLTIMO año, cuando el contrato termina a media
 *   anualidad: ahí sí hay meses que el acuerdo no llega a cubrir.
 *
 * · EXCESO PERMITIDO. Si lo disfrutado supera el derecho, el saldo queda en
 *   negativo y se enseña. No se rechaza. La realidad manda: la familia apunta
 *   lo que de verdad pasó, y un registro que se niega a admitirlo empuja a no
 *   apuntar nada, que es peor. El número negativo es la conversación que hay
 *   que tener, no un error del programa.
 *
 * · LO DEVENGADO NO ES LO QUE QUEDA. `remainingDays` dice lo que quedará al
 *   terminar el año; `accruedDays` dice cuántos días se ha ganado ya a una
 *   fecha, y `availableNowDays` cuántos tiene ahora mismo. Quien en marzo ha
 *   disfrutado 20 de sus 30 días tiene diez por delante y el devengo en
 *   negativo: las dos cifras son ciertas y dicen cosas distintas. Mezclarlas es
 *   hacer mentir a la pantalla. El devengo se prorratea con el mismo redondeo
 *   hacia arriba que el derecho, así que el primer día del año ya devenga un
 *   día: es la consecuencia coherente de redondear a favor de quien trabaja.
 *
 * · EL PRECIO DEL DÍA SE PACTA, NO SE CALCULA. Lo que vale un día de vacaciones
 *   no disfrutado es una tarifa más de las condiciones del contrato, como la
 *   hora extra o el día de descanso trabajado. Aquí sólo se multiplica por los
 *   días, en BigInt de céntimos de principio a fin: ni un `Number`, ni una
 *   división de coma flotante, ni siquiera para un intermedio. Sin tarifa
 *   pactada no hay compensación que ofrecer, y se dice.
 */

export interface VacationPeriodInput {
  /** Primer día natural de vacaciones, incluido. */
  readonly startsOn: string;
  /** Último día natural de vacaciones, incluido. */
  readonly endsOn: string;
}

/**
 * Un año de contrato: doce meses contados desde el día en que empezó el
 * acuerdo. `index` es 1 para el primero, 2 para el segundo…
 */
export interface ContractYear {
  /** 1 = primer año del contrato. */
  readonly index: number;
  /** Primer día del año de contrato, incluido. */
  readonly startsOn: string;
  /** Último día del año de contrato, incluido (la víspera del aniversario). */
  readonly endsOn: string;
}

export interface VacationYearBalanceInput {
  /** Año de contrato que se mira: 1 el primero, 2 el segundo… */
  readonly contractYearIndex: number;
  /** Días naturales al año que pacta la versión del acuerdo vigente. */
  readonly annualVacationDays: number;
  /** Primer día del acuerdo. */
  readonly agreementStartsOn: string;
  /** Último día del acuerdo, o `null` si sigue vivo. */
  readonly agreementEndsOn?: string | null;
  /** Periodos VIGENTES (los anulados no se pasan: no cuentan). */
  readonly periods: readonly VacationPeriodInput[];
  /**
   * Fecha a la que se mira el devengo, `YYYY-MM-DD`. Se INYECTA siempre: el
   * dominio no lee el reloj, porque una función que lo lee no se puede
   * comprobar y contesta distinto según el día en que se ejecute la prueba.
   */
  readonly asOf: string;
}

export interface VacationYearBalance {
  /** El año de contrato con sus fechas: sin ellas el ordinal no dice nada. */
  readonly contractYear: ContractYear;
  /** Derecho de ESTE año, ya prorrateado si el acuerdo no lo cubre entero. */
  readonly entitledDays: number;
  /** Derecho anual completo pactado, para poder explicar el prorrateo. */
  readonly annualVacationDays: number;
  /** `true` si `entitledDays` es un prorrateo y no el derecho completo. */
  readonly prorated: boolean;
  /** Primer día del año de contrato cubierto por el acuerdo. */
  readonly coveredFrom: string;
  /** Último día del año de contrato cubierto por el acuerdo. */
  readonly coveredThrough: string;
  /** Días naturales del año de contrato que el acuerdo cubre. */
  readonly coveredDays: number;
  /** Días naturales que dura el año de contrato entero. */
  readonly daysInContractYear: number;
  /** Días disfrutados que caen dentro de este año de contrato. */
  readonly takenDays: number;
  /**
   * Derecho menos disfrutado: lo que quedará AL TERMINAR el año. NEGATIVO si se
   * pasó de los días pactados: eso se enseña, no se oculta.
   */
  readonly remainingDays: number;
  /**
   * Días ya ganados a `asOf`, prorrateados por el tiempo transcurrido del año
   * de contrato. Responde «cuántos lleva devengados a día de hoy», que no es lo
   * mismo que «cuántos le tocan este año».
   */
  readonly accruedDays: number;
  /**
   * Devengado menos disfrutado: lo que tiene AHORA MISMO. Puede salir NEGATIVO,
   * y no es un error: significa que ha disfrutado días por adelantado, que es lo
   * normal cuando las vacaciones se dan en agosto y el año de contrato acaba en
   * marzo. No se recorta a cero.
   */
  readonly availableNowDays: number;
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

/** Último día del mes (1 = enero), contando bien los bisiestos. */
function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Suma meses a una fecha CLAVANDO el día al último del mes cuando el día
 * original no existe: doce meses después del 29 de febrero de 2024 es el 28 de
 * febrero de 2025, no el 1 de marzo.
 *
 * Se cuenta siempre desde la fecha ORIGINAL del contrato, nunca encadenando un
 * año sobre el anterior: si no, el aniversario de un contrato firmado un 29 de
 * febrero se iría desplazando y no volvería nunca a su día en los bisiestos.
 */
function addMonths(iso: string, months: number): string {
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  const day = Number(iso.slice(8, 10));
  const total = year * 12 + (month - 1) + months;
  const targetYear = Math.floor(total / 12);
  const targetMonth = total - targetYear * 12 + 1;
  const targetDay = Math.min(day, lastDayOfMonth(targetYear, targetMonth));
  return [
    String(targetYear).padStart(4, "0"),
    String(targetMonth).padStart(2, "0"),
    String(targetDay).padStart(2, "0"),
  ].join("-");
}

/**
 * El año de contrato número `index` de un acuerdo que empezó en
 * `agreementStartsOn`. El primero es el 1, no el 0: es un ordinal que la gente
 * lee («el segundo año»), no un índice de vector.
 */
export function contractYear(agreementStartsOn: string, index: number): ContractYear {
  assertIsoDate(agreementStartsOn, "El inicio del acuerdo");
  invariant(
    Number.isSafeInteger(index) && index >= 1,
    "INVALID_VACATION_YEAR",
    `Los años de contrato se numeran desde 1: ${index}`,
  );
  const startsOn = addMonths(agreementStartsOn, 12 * (index - 1));
  // La víspera del aniversario siguiente. Definido así, dos años consecutivos
  // no pueden solaparse ni dejar un día en tierra de nadie.
  const endsOn = addCalendarDays(localDate(addMonths(agreementStartsOn, 12 * index)), -1);
  return Object.freeze({ index, startsOn, endsOn });
}

/**
 * Los años de contrato se dicen con el ordinal que usaría una persona hasta el
 * décimo; a partir de ahí «el año 11», porque «undécimo» suena a otra cosa y
 * nadie lo diría en voz alta.
 *
 * Vive en el dominio y no en la capa de frases porque lo necesitan las dos
 * orillas: la pantalla, para titular cada bloque del historial, y el servidor,
 * para escribir la etiqueta CONGELADA del concepto que paga una compensación
 * («Vacaciones del segundo año no disfrutadas»). Dos copias serían dos formas
 * de nombrar el mismo año dentro del mismo expediente.
 */
const CONTRACT_YEAR_ORDINALS = [
  "primer",
  "segundo",
  "tercer",
  "cuarto",
  "quinto",
  "sexto",
  "séptimo",
  "octavo",
  "noveno",
  "décimo",
] as const;

/** «segundo año» · «año 12». En minúscula: casi siempre va dentro de una frase. */
export function contractYearName(index: number): string {
  const ordinal = CONTRACT_YEAR_ORDINALS[index - 1];
  return ordinal ? `${ordinal} año` : `año ${index}`;
}

/**
 * En qué año de contrato cae una fecha. `null` si es anterior al acuerdo: antes
 * de empezar no hay ningún año que contar.
 */
export function contractYearOn(agreementStartsOn: string, date: string): ContractYear | null {
  assertIsoDate(agreementStartsOn, "El inicio del acuerdo");
  assertIsoDate(date, "La fecha");
  if (date < agreementStartsOn) return null;

  // Estimación por meses completos, y luego avanzar mientras haga falta.
  //
  // El ajuste SOLO puede ir hacia delante, y no por casualidad: clavar el día al
  // último del mes (el contrato del 29 de febrero) adelanta el aniversario, no
  // lo atrasa, así que un año de contrato puede quedarse corto —364 días— pero
  // nunca empieza más tarde de lo que dice la aritmética de meses. La estimación
  // acierta o se queda por debajo; pasarse es imposible. Por eso no hay bucle
  // hacia atrás: habría sido una rama que no se ejecuta nunca y que nadie
  // volvería a mirar. Queda el invariante, que si algún día me equivoco grita en
  // vez de devolver un año en silencio.
  const months =
    (Number(date.slice(0, 4)) - Number(agreementStartsOn.slice(0, 4))) * 12 +
    (Number(date.slice(5, 7)) - Number(agreementStartsOn.slice(5, 7))) -
    (date.slice(8, 10) < agreementStartsOn.slice(8, 10) ? 1 : 0);
  let index = Math.max(1, Math.floor(months / 12) + 1);
  let year = contractYear(agreementStartsOn, index);
  invariant(
    date >= year.startsOn,
    "INVALID_VACATION_YEAR",
    `La estimación del año de contrato se pasó de largo: ${date} cae antes del ${year.startsOn}.`,
  );
  while (date > year.endsOn) {
    index += 1;
    year = contractYear(agreementStartsOn, index);
  }
  return year;
}

/**
 * Días de un periodo que caen DENTRO de la ventana `[from, through]`, ambos
 * extremos incluidos. Un periodo del 24 de diciembre al 5 de enero no es «del
 * año que empieza»: cada día gasta el derecho del año de contrato en el que
 * cae, y la ventana es justo la que dice dónde está el corte.
 */
export function vacationDaysInWindow(
  period: VacationPeriodInput,
  from: string,
  through: string,
): number {
  assertIsoDate(period.startsOn, "La fecha de inicio");
  assertIsoDate(period.endsOn, "La fecha de fin");
  assertIsoDate(from, "El principio de la ventana");
  assertIsoDate(through, "El final de la ventana");
  invariant(
    through >= from,
    "INVALID_VACATION_INTERVAL",
    "La ventana no puede acabar antes de empezar.",
  );
  const start = period.startsOn > from ? period.startsOn : from;
  const end = period.endsOn < through ? period.endsOn : through;
  if (end < start) return 0;
  return vacationCalendarDays(start, end);
}

/**
 * Saldo de vacaciones de un año de contrato. `remainingDays` puede salir
 * negativo a propósito (ver la cabecera del módulo).
 */
export function vacationYearBalance(input: VacationYearBalanceInput): VacationYearBalance {
  invariant(
    Number.isInteger(input.annualVacationDays) && input.annualVacationDays >= 0,
    "INVALID_VACATION_ENTITLEMENT",
    "El derecho anual de vacaciones debe ser un número entero de días no negativo.",
  );
  const year = contractYear(input.agreementStartsOn, input.contractYearIndex);
  const agreementEndsOn = input.agreementEndsOn ?? null;
  if (agreementEndsOn !== null) assertIsoDate(agreementEndsOn, "El fin del acuerdo");
  assertIsoDate(input.asOf, "La fecha de referencia");

  // El acuerdo empieza el mismo día que su primer año de contrato, así que por
  // arriba nunca recorta: lo único que puede recortar es el fin del contrato.
  const coveredFrom = year.startsOn;
  const coveredThrough =
    agreementEndsOn !== null && agreementEndsOn < year.endsOn ? agreementEndsOn : year.endsOn;
  const daysInContractYear = vacationCalendarDays(year.startsOn, year.endsOn);
  const coveredDays =
    coveredThrough < coveredFrom ? 0 : vacationCalendarDays(coveredFrom, coveredThrough);

  const prorated = coveredDays < daysInContractYear;
  // Redondeo hacia arriba, a favor de quien trabaja. Con el año entero el
  // cociente es exacto, así que el caso normal no se infla.
  const entitledDays = prorated
    ? Math.ceil((input.annualVacationDays * coveredDays) / daysInContractYear)
    : input.annualVacationDays;

  const takenDays = input.periods.reduce(
    (accumulated, period) =>
      accumulated + vacationDaysInWindow(period, year.startsOn, year.endsOn),
    0,
  );

  // El devengo corre por la ventana que el acuerdo CUBRE, no por el año de
  // contrato entero. En un año normal son la misma cosa. En el último año de un
  // contrato que termina no lo son, y hacerlo por el año entero diría que quien
  // trabajó hasta el final se ganó una parte de un derecho que ya estaba
  // prorrateado por ese mismo final: se lo descontaría dos veces.
  const elapsedThrough = input.asOf < coveredThrough ? input.asOf : coveredThrough;
  const accruedDays =
    coveredDays === 0 || elapsedThrough < coveredFrom
      ? 0
      : Math.ceil(
          (entitledDays * vacationCalendarDays(coveredFrom, elapsedThrough)) / coveredDays,
        );

  return Object.freeze({
    contractYear: year,
    entitledDays,
    annualVacationDays: input.annualVacationDays,
    prorated,
    coveredFrom,
    coveredThrough,
    coveredDays,
    daysInContractYear,
    takenDays,
    remainingDays: entitledDays - takenDays,
    accruedDays,
    availableNowDays: accruedDays - takenDays,
  });
}

// ─── Lo que se paga por un día de vacaciones no disfrutado ───────────────────

export interface VacationCompensationInput {
  /**
   * Tarifa PACTADA por cada día de vacaciones no disfrutado, hermana de
   * `overtime_hourly_rate_cents` y `worked_rest_day_rate_cents`. `null` cuando
   * la versión del acuerdo no la pacta: entonces no hay compensación posible.
   */
  readonly dayRateCents: MoneyCents | null;
  /**
   * Fecha desde la que rige la versión del acuerdo de la que sale la tarifa.
   * Va en la frase congelada: es lo que la hace verificable dentro de dos años.
   */
  readonly rateEffectiveFrom: string;
  /** Días con derecho que no se llegaron a disfrutar. */
  readonly unusedDays: number;
}

export interface VacationCompensation {
  /** La tarifa pactada que se ha aplicado. */
  readonly dayRateCents: MoneyCents;
  readonly unusedDays: number;
  /** Tarifa pactada × días sin disfrutar. */
  readonly compensationCents: MoneyCents;
  /**
   * La frase que explica el importe, para CONGELARLA junto a él. Se guarda tal
   * cual y no se vuelve a recalcular nunca: si mañana se pacta otra tarifa, lo
   * que se decidió en su día tiene que seguir diciendo con qué precio se
   * decidió. Por eso se basta a sí misma y nombra la versión del contrato de la
   * que salió el precio, que es lo que alguien querrá comprobar.
   */
  readonly basis: string;
}

function dayWord(count: number): string {
  return count === 1 ? "día" : "días";
}

/** «2026-03-05» → «5 de marzo de 2026», que es como se dice una fecha en voz alta. */
function spokenDate(iso: string): string {
  return `${Number(iso.slice(8, 10))} de ${monthName(Number(iso.slice(5, 7)))} de ${iso.slice(0, 4)}`;
}

/**
 * Lo que suman los días de vacaciones que no se llegaron a disfrutar.
 *
 * `compensación = tarifa pactada × días no disfrutados`, en BigInt de céntimos
 * como todo el dinero de esta casa.
 *
 * El precio del día NO se calcula: se pacta en las condiciones del contrato,
 * igual que la hora extra y el día de descanso trabajado. Por eso, si la
 * versión del acuerdo no trae tarifa, esta función devuelve `null` —la
 * AUSENCIA, no un importe— y quien la llame tiene que decir que hay que pactar
 * el precio antes de poder compensar. Estimarlo a partir del salario daría un
 * número inventado con apariencia de pactado, que es peor que no tener número:
 * dentro de dos años nadie sabría de dónde salió.
 */
export function vacationCompensation(
  input: VacationCompensationInput,
): VacationCompensation | null {
  invariant(
    Number.isInteger(input.unusedDays) && input.unusedDays >= 0,
    "INVALID_VACATION_UNUSED_DAYS",
    "Los días sin disfrutar deben ser un número entero de días no negativo.",
  );
  if (input.dayRateCents === null) return null;
  invariant(
    input.dayRateCents >= 0n,
    "INVALID_VACATION_DAY_RATE",
    "La tarifa del día de vacaciones no puede ser negativa.",
  );
  assertIsoDate(input.rateEffectiveFrom, "La fecha de la versión del acuerdo");

  const compensationCents = moneyCents(input.dayRateCents * BigInt(input.unusedDays));

  return Object.freeze({
    dayRateCents: input.dayRateCents,
    unusedDays: input.unusedDays,
    compensationCents,
    basis:
      `${input.unusedDays} ${dayWord(input.unusedDays)} sin disfrutar × ` +
      `${formatEuroCents(input.dayRateCents)} por día, pactados en las condiciones ` +
      `vigentes desde el ${spokenDate(input.rateEffectiveFrom)} = ` +
      `${formatEuroCents(compensationCents)}`,
  });
}

// ─── Hasta cuándo se pueden disfrutar los días arrastrados ───────────────────

/**
 * La política de caducidad pactada en la versión del acuerdo (apartado 4.2 del
 * diseño): seis meses por omisión, otro número de meses, o «nunca expiran».
 */
export type VacationCarryoverExpiry =
  | { readonly mode: "months"; readonly months: number }
  | { readonly mode: "never" };

/** Ausente son seis meses, y por eso ningún contrato ya firmado hubo que tocarlo. */
export const DEFAULT_VACATION_CARRYOVER_MONTHS = 6;

/**
 * Lee la política de `agreement_versions.terms`.
 *
 * Tolerante a propósito: lo que la base admite lo garantiza su CHECK de forma
 * (migración 0034), y una fila anterior —o de una instalación que se saltara la
 * restricción— tiene que seguir dando la respuesta por omisión en vez de
 * reventar la pantalla o el comando. Un `terms` ilegible NO es «no hay
 * caducidad»: es «no se pactó otra cosa», que son seis meses.
 */
export function readVacationCarryoverExpiry(terms: unknown): VacationCarryoverExpiry {
  const raw =
    terms && typeof terms === "object"
      ? (terms as Record<string, unknown>).vacationCarryoverExpiry
      : null;
  if (raw && typeof raw === "object") {
    const policy = raw as Record<string, unknown>;
    if (policy.mode === "never") return { mode: "never" };
    if (
      policy.mode === "months" &&
      typeof policy.months === "number" &&
      Number.isInteger(policy.months) &&
      policy.months >= 1
    ) {
      return { mode: "months", months: policy.months };
    }
  }
  return { mode: "months", months: DEFAULT_VACATION_CARRYOVER_MONTHS };
}

/**
 * Último día en que se pueden disfrutar los días arrastrados de un año de
 * contrato que se cierra. `null` cuando la política dice que nunca expiran, y
 * ese null es una respuesta, no un hueco: no hay fecha límite que enseñar.
 *
 * El margen se cuenta desde el FIN del año de contrato, que es cuando los días
 * dejaron de poder disfrutarse por la vía normal. Un año que acaba el 4 de
 * marzo de 2027 con seis meses de margen llega hasta el 4 de septiembre de 2027.
 */
export function vacationCarryoverDeadline(
  sourceYearEndsOn: string,
  policy: VacationCarryoverExpiry,
): string | null {
  assertIsoDate(sourceYearEndsOn, "El fin del año de contrato");
  if (policy.mode === "never") return null;
  invariant(
    Number.isInteger(policy.months) && policy.months >= 1,
    "INVALID_VACATION_CARRYOVER_EXPIRY",
    "El margen de los días arrastrados debe ser un número entero de meses mayor que cero.",
  );
  return addMonths(sourceYearEndsOn, policy.months);
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
