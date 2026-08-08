import { invariant } from "./errors.js";

/**
 * Catálogo de condiciones de una versión del acuerdo: qué trabajo extra existe,
 * a cuánto se paga, y qué complementos periódicos hay.
 *
 * Es el reflejo puro de `app.extra_work_types` y `app.recurring_supplements`
 * (migración 0021). Vive aquí porque tres capas necesitan las mismas dos
 * respuestas —«¿cuánto vale este hecho?» y «¿qué ve la empleada?»— y ninguna de
 * las tres debería contestarlas por su cuenta.
 */

/**
 * Cómo se valora un tipo:
 *
 *   · `per_hour` — la duración del hecho pone el importe. «La hora extra está a
 *     10 €».
 *   · `per_shift` — un hecho es una jornada, valga lo que valga su duración
 *     real; `referenceMinutes` dice de cuántas horas se pactó esa jornada.
 *     «Una cantidad fija por un número de horas concreto».
 *   · `fixed_amount` — un supuesto, un importe. «Quedarse una noche de guardia
 *     serán 50 €».
 */
export type ExtraWorkUnit = "per_hour" | "per_shift" | "fixed_amount";

export interface ExtraWorkType {
  id: string;
  /** Identidad estable del concepto a través de las versiones. */
  code: string;
  name: string;
  unit: ExtraWorkUnit;
  /** null = pactado sin tarifa todavía. Sin tarifa no se valora ni se enseña. */
  rateCents: bigint | null;
  /** Duración pactada de la jornada; obligatoria en `per_shift`. */
  referenceMinutes: number | null;
  /** El permiso: false = a esta empleada no se le permite este trabajo. */
  active: boolean;
}

export type SupplementPeriodicity = "monthly";

export interface RecurringSupplement {
  id: string;
  code: string;
  name: string;
  amountCents: bigint | null;
  periodicity: SupplementPeriodicity;
  /**
   * true: dinero para ella, entra en el total del mes.
   * false: lo paga la casa aparte (seguro médico); consta como condición
   * pactada y NO toca la transferencia. Sin esta distinción el cálculo mentiría.
   */
  addsToPay: boolean;
  startsOn: string | null;
  endsOn: string | null;
  active: boolean;
}

/**
 * Lo que la empleada puede ver de un concepto: activo y con tarifa. Si falta
 * cualquiera de las dos, para ella no existe —ni en sus condiciones ni en el
 * formulario donde registraría ese trabajo—.
 *
 * La RLS de 0021 impone lo mismo en Postgres. Esta función no es la defensa:
 * es la misma regla, escrita una sola vez, para que la interfaz y el servidor
 * no la reinventen cada uno a su manera (y para que las capas sin base de datos
 * —la demo, las pruebas puras— se comporten igual).
 */
export function isVisibleToEmployee(type: Readonly<ExtraWorkType>): boolean {
  return type.active && type.rateCents !== null;
}

export function isSupplementVisibleToEmployee(
  supplement: Readonly<RecurringSupplement>,
): boolean {
  return supplement.active && supplement.amountCents !== null;
}

/** Los conceptos que le aplican, en el orden en que llegan. */
export function employeeVisibleTypes(
  types: readonly ExtraWorkType[],
): readonly ExtraWorkType[] {
  return Object.freeze(types.filter(isVisibleToEmployee));
}

export function employeeVisibleSupplements(
  supplements: readonly RecurringSupplement[],
): readonly RecurringSupplement[] {
  return Object.freeze(supplements.filter(isSupplementVisibleToEmployee));
}

export interface ExtraWorkValuation {
  /** Tarifa del catálogo, tal cual, para congelarla junto al importe. */
  unitRateCents: bigint;
  amountCents: bigint;
  /** Etiqueta de cantidad para la línea de la liquidación. */
  quantityLabel: string;
  /**
   * Minutos que acredita si se compensa con descanso en vez de con dinero: la
   * jornada pactada cuando el concepto tiene una, y si no, lo trabajado.
   */
  creditMinutes: number;
}

function assertPositiveMinutes(durationMinutes: number): void {
  invariant(
    Number.isSafeInteger(durationMinutes) && durationMinutes > 0,
    "INVALID_EXTRA_WORK_DURATION",
    "La duración del trabajo extra debe ser un entero positivo de minutos.",
  );
}

/**
 * Cuánto vale un hecho según SU tipo. Nunca se llama con la tarifa «de hoy»:
 * quien la invoca le pasa el tipo de la versión vigente el día trabajado, que es
 * la que la base de datos exige y congela.
 *
 * Aritmética en bigint de extremo a extremo: la tarifa por hora se prorratea con
 * redondeo half-up entero (`(tarifa * minutos + 30) / 60`), nunca en coma
 * flotante. Un céntimo perdido por redondeo es dinero de alguien.
 */
export function valueExtraWork(
  type: Readonly<ExtraWorkType>,
  durationMinutes: number,
): ExtraWorkValuation {
  assertPositiveMinutes(durationMinutes);
  invariant(
    type.active,
    "EXTRA_WORK_TYPE_INACTIVE",
    `El concepto «${type.name}» no está activo en esta versión del acuerdo.`,
  );
  const rate = type.rateCents;
  invariant(
    rate !== null,
    "EXTRA_WORK_TYPE_WITHOUT_RATE",
    `El concepto «${type.name}» no tiene tarifa pactada.`,
  );
  invariant(rate >= 0n, "INVALID_EXTRA_WORK_RATE", "Una tarifa no puede ser negativa.");

  if (type.unit === "per_hour") {
    const hours = durationMinutes / 60;
    return {
      unitRateCents: rate,
      amountCents: (rate * BigInt(durationMinutes) + 30n) / 60n,
      quantityLabel: `${formatHours(hours)} h`,
      creditMinutes: durationMinutes,
    };
  }

  // `per_shift` y `fixed_amount` valen su tarifa una vez: un hecho es una
  // jornada o un supuesto, no un múltiplo. Dos guardias son dos registros, que
  // es además como se aceptan y se discuten por separado.
  return {
    unitRateCents: rate,
    amountCents: rate,
    quantityLabel: type.unit === "per_shift" ? "1 jornada" : "1 vez",
    creditMinutes: type.referenceMinutes ?? durationMinutes,
  };
}

/** «1,5» sin coma flotante visible: dos decimales como mucho, sin ceros de más. */
function formatHours(hours: number): string {
  const rounded = Math.round(hours * 100) / 100;
  return Number.isInteger(rounded)
    ? String(rounded)
    : String(rounded).replace(".", ",");
}

/**
 * Complementos que rigen un mes concreto: activos, con importe, y con la
 * vigencia tocando el periodo. Un complemento que empieza el 20 de septiembre
 * no debe aparecer en la cuenta de agosto.
 */
export function supplementsInForce(
  supplements: readonly RecurringSupplement[],
  periodFirstDay: string,
  periodLastDay: string,
): readonly RecurringSupplement[] {
  return Object.freeze(
    supplements.filter(
      (supplement) =>
        isSupplementVisibleToEmployee(supplement) &&
        (supplement.startsOn === null || supplement.startsOn <= periodLastDay) &&
        (supplement.endsOn === null || supplement.endsOn >= periodFirstDay),
    ),
  );
}
