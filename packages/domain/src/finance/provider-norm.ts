import { normText } from "./text.js";
import type { FinanceBank } from "./types.js";

/** Regex portadas 1:1 de provider_norm.py (no cambiar sin cambiar el origen). */
export const CARD_PREFIX_RX = /Fecha de operaci[oó]n:\s*\d{2}-\d{2}-\d{4}\s*/;
const SEPA_PREFIX_RX = /^(CORE|B2B)/;
const SEPA_CREDITOR_RX = /^ES\d{2}\w+$/;
const TRANSFER_REF_RX = /^2860 56 \d{7}/;
const MYBOX_RX = /^CUOTA AGRUPADA MYBOX \d{2}-\d{2}-\d{4}$/;
const COMPANY_RX = /\b(S\.?L\.?U?|S\.?A\.?U?|S\.?C\.?P?|SLNE)\b\.?$/i;
const DB_LOAN_RX = /^PRESTAMO\s+\d+-(\d+)$/;
const PAYPAL_RX = /^PAYPAL \*(.+)$/;
const DIGITS6_RX = /\d{6,}/;

function clean(provider: string): string {
  return provider.replace(/\s+/g, " ").trim().slice(0, 200);
}

/** Port fiel de provider_norm.py::normalize_provider. Trabaja sobre las "parts"
 * del concept (celdas unidas con " | ") buscando PATRONES, nunca índices. */
export function normalizeBankProvider(input: {
  provider: string;
  concept: string;
  codeCommon: string | null;
  codeOwn: string | null;
  bank: FinanceBank;
}): string {
  const { concept, codeCommon, codeOwn, bank } = input;
  let provider = input.provider;
  const parts = concept
    .split(" | ")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (bank === "caixabank") {
    const cardPart = parts.find((p) => CARD_PREFIX_RX.test(p));
    if (cardPart !== undefined) {
      // (1) tarjeta: el comercio es lo que sigue al prefijo EN ESA celda.
      const m = CARD_PREFIX_RX.exec(cardPart) as RegExpExecArray;
      provider = cardPart.slice(m.index + m[0].length);
    } else {
      // (2) recibos SEPA: quitar CORE/B2B solo si hay celda hermana con acreedor SEPA.
      if (
        SEPA_PREFIX_RX.test(provider) &&
        parts.some((p) => p.split(/\s{2,}/).some((piece) => SEPA_CREDITOR_RX.test(piece)))
      ) {
        provider = provider.replace(SEPA_PREFIX_RX, "");
      }
      // (3) transferencia emitida 04/073: beneficiario truncado → nombre completo.
      if (codeCommon === "04" && codeOwn === "073") {
        const refIdx = parts.findIndex((p) => TRANSFER_REF_RX.test(p));
        if (refIdx !== -1) {
          const pieces = (parts[refIdx] as string).split(/\s{2,}/);
          const truncated = pieces[1];
          if (pieces.length > 1 && truncated) {
            const full = parts.find((p, i) => i !== refIdx && p.startsWith(truncated));
            provider = full ?? truncated;
          }
        }
      }
      // (4) Bizum: la persona viene como "NOMBRE;APELLIDO;APELLIDO" en una celda.
      if (codeOwn === "002") {
        const person = parts.find((p) => p.includes(";"));
        if (person !== undefined) provider = person.replace(/;/g, " ");
      }
      // (5) transferencia a una EMPRESA: se prefiere el destinatario con forma societaria.
      if ((codeCommon === "04" || codeCommon === "99") && !provider.includes(";")) {
        const company = parts.find(
          (p) => COMPANY_RX.test(p) && !p.includes("2860 56") && !SEPA_PREFIX_RX.test(p),
        );
        if (company !== undefined) provider = company;
      }
    }
    // (6) MyBox: la fecha de la cuota mensual fuera del provider.
    if (MYBOX_RX.test(clean(provider))) provider = "CUOTA AGRUPADA MYBOX";
  } else if (bank === "deutsche_bank") {
    const m = DB_LOAN_RX.exec(clean(provider));
    if (m !== null) provider = `PRESTAMO ${m[1] as string}`;
  }
  return clean(provider);
}

/** Entrada genérica canónica: deriva provider/provider_norm de un concepto
 * cualquiera (movimientos manuales, renormalización). Los parsers usan
 * normalizeBankProvider, el port fiel con banco y códigos Norma 43. */
export function normalizeProvider(concept: string): {
  provider: string | null;
  providerNorm: string | null;
} {
  const first =
    concept
      .split(" | ")
      .map((p) => p.trim())
      .find((p) => p.length > 0) ?? "";
  const provider = clean(first);
  if (provider === "") return { provider: null, providerNorm: null };
  return { provider, providerNorm: normText(provider) };
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\p{L}+/gu, (w) => w.charAt(0).toUpperCase() + w.slice(1));
}

/** Port de provider_norm.py::paypal_vendor. */
export function paypalVendor(provider: string): string | null {
  const m = PAYPAL_RX.exec(clean(provider));
  if (m === null) return null;
  const words: string[] = [];
  for (const token of (m[1] as string).split(/\s+/).filter((t) => t.length > 0)) {
    if (DIGITS6_RX.test(token)) break; // teléfono/referencia: corta el vendor
    words.push(token);
  }
  const vendor = words.join(" ");
  return vendor === "" ? null : titleCase(vendor);
}
