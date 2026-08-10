import { DomainRuleError, invariant } from "./errors.js";

/**
 * Conceptos apuntados a mano: importes sueltos que no nacen de un hecho del
 * sistema —una gratificación, un descuento acordado, la parte proporcional de
 * algo, un anticipo ya devuelto en mano— y que se imputan a la cuenta de un mes
 * concreto, elegido por quien administra.
 *
 * Reflejo puro de `app.manual_adjustments` (migración 0022). Aquí viven las dos
 * reglas que ninguna capa debería reinventar por su cuenta: a qué mes cae un
 * concepto cuando el pedido ya está cerrado, y cómo se cuenta eso en castellano.
 */

/** Un mes natural, `YYYY-MM`. La unidad de la cuenta. */
export type PeriodMonth = string;

const PERIOD_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

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

export function isPeriodMonth(value: string): value is PeriodMonth {
  return PERIOD_PATTERN.test(value);
}

function assertPeriod(value: string): void {
  invariant(
    isPeriodMonth(value),
    "INVALID_PERIOD_MONTH",
    `«${value}» no es un mes con formato YYYY-MM.`,
  );
}

/** «2026-04» → «abril de 2026». Lenguaje llano, que es como se lee una cuenta. */
export function monthLabel(period: PeriodMonth): string {
  assertPeriod(period);
  const year = period.slice(0, 4);
  const month = Number(period.slice(5, 7));
  return `${MONTH_NAMES[month - 1]} de ${year}`;
}

export function nextMonth(period: PeriodMonth): PeriodMonth {
  assertPeriod(period);
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7));
  return month === 12
    ? `${year + 1}-01`
    : `${year}-${String(month + 1).padStart(2, "0")}`;
}

/** Primer día del mes, en el formato de fecha que habla con Postgres. */
export function monthFirstDay(period: PeriodMonth): string {
  assertPeriod(period);
  return `${period}-01`;
}

/**
 * Cuántos meses adelante se busca un mes abierto antes de rendirse. Dos años es
 * mucho más de lo que cualquier hogar real tendrá cerrado por delante; el tope
 * existe para que un dato imposible falle con una causa legible en vez de
 * girar en un bucle.
 */
export const MAX_DEFERRAL_MONTHS = 24;

export interface Imputation {
  /** El mes al que de verdad se imputa. */
  period: PeriodMonth;
  /** El mes que se pidió; distinto solo cuando hubo aplazamiento. */
  requested: PeriodMonth;
  /** Frase que explica el aplazamiento, o cadena vacía si no lo hubo. */
  note: string;
}

/**
 * A qué mes cae el concepto.
 *
 * La regla, decidida con el propietario y escrita para no volver a discutirla:
 * **una cuenta cerrada no se reescribe**. Si el mes pedido ya está cerrado, el
 * concepto no lo toca; cae al primer mes posterior que siga abierto, y la fila
 * se queda con una nota que lo dice.
 *
 * Por qué esta y no las alternativas:
 *
 *   · *Reabrir el mes cerrado* rompería la promesa del expediente: el recibo ya
 *     se generó, el total ya se congeló con su hash y puede estar pagado y
 *     confirmado. Un número que cambia después de haberse enseñado es
 *     exactamente lo que destruye la confianza en una cuenta.
 *   · *Rechazar el apunte* obliga a quien administra a hacer la cuenta en un
 *     papel aparte, que es de donde venimos.
 *   · *Callar y meterlo en el mes en curso* haría lo correcto por el motivo
 *     equivocado: la cuenta saldría bien y nadie sabría por qué ese importe
 *     aparece en abril cuando la conversación fue sobre marzo.
 *
 * Un mes ABIERTO (liquidación iniciada pero sin cerrar) sí se admite: apuntar
 * sobre el mes en curso es el caso normal, no una excepción.
 */
export function imputationMonth(
  requested: PeriodMonth,
  closedMonths: Iterable<PeriodMonth>,
): Imputation {
  assertPeriod(requested);
  const closed = new Set<string>();
  for (const month of closedMonths) {
    assertPeriod(month);
    closed.add(month);
  }

  let period = requested;
  for (let step = 0; step <= MAX_DEFERRAL_MONTHS; step += 1) {
    if (!closed.has(period)) {
      return {
        period,
        requested,
        note: period === requested ? "" : deferralNote(requested, period),
      };
    }
    period = nextMonth(period);
  }

  throw new DomainRuleError(
    "NO_OPEN_MONTH_FOR_ADJUSTMENT",
    `Desde ${monthLabel(requested)} no hay ningún mes sin cerrar en los próximos ${MAX_DEFERRAL_MONTHS} meses.`,
  );
}

/**
 * La nota se congela en la fila, no se recalcula al leerla. La frase que
 * justificó el aplazamiento el día que se apuntó es la que debe leerse siempre,
 * aunque mañana cambie esta función.
 */
export function deferralNote(requested: PeriodMonth, period: PeriodMonth): string {
  return (
    `Se pidió para ${monthLabel(requested)}, pero esa cuenta ya estaba cerrada: ` +
    `se imputa a ${monthLabel(period)}.`
  );
}
