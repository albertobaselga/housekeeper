import {
  supplementsInForce,
  type RecurringSupplement,
} from "./agreement-terms.js";
import { agreementVersionForDate, type AgreementVersion } from "./agreements.js";

export interface SettledExtraWork {
  id: string;
  workedOn: string;
  label: string;
  resolution: "money" | "time_off";
  quantityLabel: string;
  frozenUnitRateCents: bigint;
  frozenAmountCents: bigint;
  permanentCreditMinutes: number;
}

export interface MonetaryInput {
  id: string;
  label: string;
  amountCents: bigint;
}

export interface SettlementInput {
  period: string;
  agreementVersions: readonly AgreementVersion[];
  extraWork: readonly SettledExtraWork[];
  extraPay: readonly MonetaryInput[];
  advanceDeductions: readonly MonetaryInput[];
  unpaidAbsences: readonly MonetaryInput[];
  adjustments: readonly (MonetaryInput & { reason: string })[];
  expenses: readonly MonetaryInput[];
  /**
   * Complementos recurrentes de la versión vigente. Opcional para no romper a
   * quien todavía no los lee; sin ellos el cálculo es el de antes.
   */
  supplements?: readonly RecurringSupplement[];
}

export type SettlementLineKind =
  | "base_salary"
  | "extra_work"
  | "supplement"
  | "extra_pay"
  | "advance_deduction"
  | "unpaid_absence"
  | "adjustment"
  | "expense_reimbursement";

export interface SettlementLine {
  id: string;
  kind: SettlementLineKind;
  label: string;
  quantity: string;
  unitCents: bigint | null;
  amountCents: bigint;
  sourceType: string;
  sourceId: string;
  sourceHref: string;
}

/**
 * Un complemento que la casa paga por su cuenta: consta como condición pactada
 * y NO entra en ningún total. Viaja aparte de `lines` justamente para que sea
 * imposible sumarlo por descuido.
 */
export interface HouseholdPaidSupplement {
  id: string;
  label: string;
  amountCents: bigint;
}

export interface SettlementProjection {
  period: string;
  agreementVersionId: string;
  lines: readonly SettlementLine[];
  salaryCents: bigint;
  reimbursementCents: bigint;
  transferTotalCents: bigint;
  permanentCreditMinutes: number;
  /**
   * Lo que el hogar abona por ella fuera de la transferencia (seguro médico y
   * parecidos). Se enseña en el recibo como información; ningún total lo
   * incluye.
   */
  householdPaidSupplements: readonly HouseholdPaidSupplement[];
}

function periodBounds(period: string): { first: string; last: string } {
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  if (!match) throw new TypeError("El periodo debe usar el formato YYYY-MM");
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) throw new RangeError("El mes no es válido");
  const first = `${period}-01`;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { first, last: `${period}-${String(lastDay).padStart(2, "0")}` };
}

function sum(lines: readonly SettlementLine[]): bigint {
  return lines.reduce((total, line) => total + line.amountCents, 0n);
}

function moneyLine(
  input: MonetaryInput,
  kind: SettlementLineKind,
  sign: 1n | -1n,
  sourceType: string,
): SettlementLine {
  const magnitude = input.amountCents < 0n ? -input.amountCents : input.amountCents;
  return {
    id: `${kind}:${input.id}`,
    kind,
    label: input.label,
    quantity: "1",
    unitCents: magnitude * sign,
    amountCents: magnitude * sign,
    sourceType,
    sourceId: input.id,
    sourceHref: `/laboral/${sourceType}/${encodeURIComponent(input.id)}`,
  };
}

export function calculateSettlement(input: SettlementInput): SettlementProjection {
  const { first, last } = periodBounds(input.period);
  const agreement = agreementVersionForDate(input.agreementVersions, first);
  if (agreement.monthlySalaryCents < 0n) {
    throw new RangeError("El salario mensual no puede ser negativo");
  }

  const lines: SettlementLine[] = [
    {
      id: `base:${agreement.id}:${input.period}`,
      kind: "base_salary",
      label: `Salario acordado ${input.period}`,
      quantity: "1",
      unitCents: agreement.monthlySalaryCents,
      amountCents: agreement.monthlySalaryCents,
      sourceType: "agreement-version",
      sourceId: agreement.id,
      sourceHref: `/laboral/acuerdo/versiones/${encodeURIComponent(agreement.id)}`,
    },
  ];

  let permanentCreditMinutes = 0;
  for (const event of input.extraWork) {
    if (event.workedOn < first || event.workedOn > last) continue;
    if (event.frozenAmountCents < 0n || event.frozenUnitRateCents < 0n) {
      throw new RangeError("Una jornada resuelta contiene una tarifa negativa");
    }
    if (event.resolution === "time_off") {
      if (event.frozenAmountCents !== 0n || event.permanentCreditMinutes <= 0) {
        throw new RangeError("La compensación debe generar crédito permanente y 0 céntimos");
      }
      permanentCreditMinutes += event.permanentCreditMinutes;
    } else if (event.permanentCreditMinutes !== 0) {
      throw new RangeError("Una jornada pagada no puede generar crédito de descanso");
    }
    lines.push({
      id: `extra:${event.id}`,
      kind: "extra_work",
      label: event.label,
      quantity: event.quantityLabel,
      unitCents: event.resolution === "money" ? event.frozenUnitRateCents : null,
      amountCents: event.frozenAmountCents,
      sourceType: "jornadas-extra",
      sourceId: event.id,
      sourceHref: `/laboral/jornadas-extra/${encodeURIComponent(event.id)}`,
    });
  }

  // Complementos recurrentes: los que suman se convierten en línea; los que la
  // casa paga aparte se apartan a `householdPaidSupplements` y no rozan ningún
  // total. Es la distinción que evita que la cuenta del mes mienta.
  const householdPaidSupplements: HouseholdPaidSupplement[] = [];
  for (const supplement of supplementsInForce(input.supplements ?? [], first, last)) {
    const amount = supplement.amountCents as bigint;
    if (amount < 0n) {
      throw new RangeError("Un complemento no puede tener importe negativo");
    }
    if (!supplement.addsToPay) {
      householdPaidSupplements.push({
        id: supplement.id,
        label: supplement.name,
        amountCents: amount,
      });
      continue;
    }
    lines.push({
      id: `supplement:${supplement.id}`,
      kind: "supplement",
      label: supplement.name,
      quantity: "1",
      unitCents: amount,
      amountCents: amount,
      sourceType: "complementos",
      sourceId: supplement.id,
      sourceHref: `/laboral/complementos/${encodeURIComponent(supplement.id)}`,
    });
  }

  lines.push(...input.extraPay.map((item) => moneyLine(item, "extra_pay", 1n, "pagas-extra")));
  lines.push(...input.advanceDeductions.map((item) => moneyLine(item, "advance_deduction", -1n, "anticipos")));
  lines.push(...input.unpaidAbsences.map((item) => moneyLine(item, "unpaid_absence", -1n, "ausencias")));
  for (const adjustment of input.adjustments) {
    if (!adjustment.reason.trim()) throw new TypeError("Cada ajuste manual necesita un motivo");
    lines.push({
      ...moneyLine(adjustment, "adjustment", adjustment.amountCents < 0n ? -1n : 1n, "ajustes"),
      label: `${adjustment.label}: ${adjustment.reason}`,
    });
  }

  const salaryLines = [...lines];
  const reimbursementLines = input.expenses.map((item) =>
    moneyLine(item, "expense_reimbursement", 1n, "gastos"),
  );
  lines.push(...reimbursementLines);

  const salaryCents = sum(salaryLines);
  const reimbursementCents = sum(reimbursementLines);
  return {
    period: input.period,
    agreementVersionId: agreement.id,
    lines,
    salaryCents,
    reimbursementCents,
    transferTotalCents: salaryCents + reimbursementCents,
    permanentCreditMinutes,
    householdPaidSupplements: Object.freeze(householdPaidSupplements),
  };
}

export type SettlementStatus =
  | "open"
  | "in_review"
  | "closed"
  | "paid"
  | "receipt_confirmed";

export interface PaymentFact {
  id: string;
  amountCents: bigint;
  voided: boolean;
  confirmedByEmployeeAt: string | null;
}

export function derivePaymentStatus(
  frozenTotalCents: bigint,
  payments: readonly PaymentFact[],
): SettlementStatus {
  const active = payments.filter((payment) => !payment.voided);
  const paid = active.reduce((total, payment) => total + payment.amountCents, 0n);
  if (paid > frozenTotalCents) {
    throw new RangeError("Los pagos exceden el total congelado de la liquidación");
  }
  if (paid < frozenTotalCents) return "closed";
  return active.length > 0 && active.every((payment) => payment.confirmedByEmployeeAt !== null)
    ? "receipt_confirmed"
    : "paid";
}
