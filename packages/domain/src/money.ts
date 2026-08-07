import { invariant } from "./errors.js";

declare const moneyCentsBrand: unique symbol;

/** Importe exacto en céntimos (unidad menor). Los flotantes nunca entran al dominio. */
export type MoneyCents = bigint & { readonly [moneyCentsBrand]: "MoneyCents" };

export function moneyCents(value: bigint): MoneyCents {
  return value as MoneyCents;
}

/** Interpreta un importe en euros sin agrupar, como `1453.30` o `47,30`. */
export function parseEuroCents(value: string): MoneyCents {
  const match = /^([+-]?)(\d+)(?:[.,](\d{1,2}))?$/.exec(value.trim());
  invariant(
    match,
    "INVALID_MONEY_DECIMAL",
    "El importe debe ser un decimal sin separador de miles y con dos decimales como máximo.",
  );

  const sign = match[1] === "-" ? -1n : 1n;
  const euros = BigInt(match[2] as string);
  const fraction = (match[3] ?? "").padEnd(2, "0");
  return moneyCents(sign * (euros * 100n + BigInt(fraction || "0")));
}

/** Representación decimal canónica para JSON, CSV y hashes. */
export function euroCentsToDecimal(value: MoneyCents): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const euros = absolute / 100n;
  const fraction = String(absolute % 100n).padStart(2, "0");
  return `${negative ? "-" : ""}${euros}.${fraction}`;
}

/** Formato es-ES determinista sin pasar por Number. */
export function formatEuroCents(value: MoneyCents): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const groupedEuros = String(absolute / 100n).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const fraction = String(absolute % 100n).padStart(2, "0");
  return `${negative ? "−" : ""}${groupedEuros},${fraction}\u00a0€`;
}

export function sumMoney(values: Iterable<MoneyCents>): MoneyCents {
  let total = 0n;
  for (const value of values) total += value;
  return moneyCents(total);
}

/** Redondeo al entero más próximo, con los medios alejándose de cero. */
export function divideRoundHalfAwayFromZero(
  numerator: bigint,
  denominator: bigint,
): bigint {
  invariant(denominator > 0n, "INVALID_DENOMINATOR", "El denominador debe ser positivo.");
  const sign = numerator < 0n ? -1n : 1n;
  const absolute = numerator < 0n ? -numerator : numerator;
  const quotient = absolute / denominator;
  const remainder = absolute % denominator;
  return sign * (quotient + (remainder * 2n >= denominator ? 1n : 0n));
}

/** Prorratea una tarifa unitaria (p. ej. €/hora por minutos trabajados) sin perder céntimos. */
export function prorateMoney(
  unitAmount: MoneyCents,
  units: bigint,
  unitsPerUnit: bigint,
): MoneyCents {
  return moneyCents(divideRoundHalfAwayFromZero(unitAmount * units, unitsPerUnit));
}
