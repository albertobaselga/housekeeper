import { parseEuroInput } from '$lib/employment/commands';

/** Importe firmado en céntimos para el manual: gasto negativo, ingreso positivo. */
export function manualAmountCents(raw: string, kind: 'gasto' | 'ingreso'): string | null {
  const cents = parseEuroInput(raw);
  if (!cents) return null;
  return kind === 'gasto' ? `-${cents}` : cents;
}
