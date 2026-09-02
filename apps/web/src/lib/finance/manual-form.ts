import { parseEuroInput } from '$lib/employment/commands';

/** Importe firmado en céntimos para el manual: gasto negativo, ingreso positivo. */
export function manualAmountCents(raw: string, kind: 'gasto' | 'ingreso'): string | null {
  const cents = parseEuroInput(raw);
  if (!cents) return null;
  return kind === 'gasto' ? `-${cents}` : cents;
}

/**
 * Único parseo del valor de recurrencia de un `<select>` (Ruling R25, cierre
 * de fase 5): antes `ManualForm.svelte` y `RecurrenceChip.svelte` narrowaban
 * cada uno por su cuenta con `next as 'recurrente' | 'extraordinario'` — dos
 * aserciones idénticas para el mismo valor. La lista NO lleva `as const`
 * (que exigiría luego `as readonly string[]` para poder llamar `.includes`
 * con un `string` suelto): declarada ya como `string[]`, la guarda no
 * necesita ninguna aserción.
 */
const RECURRENCE_VALUES: readonly string[] = ['recurrente', 'extraordinario'];

function isRecurrenceValue(value: string): value is 'recurrente' | 'extraordinario' {
  return RECURRENCE_VALUES.includes(value);
}

/** `''` (la opción «—» del `<select>`) y cualquier valor ajeno vuelven `null`: sin clasificar. */
export function parseRecurrence(value: string): 'recurrente' | 'extraordinario' | null {
  return isRecurrenceValue(value) ? value : null;
}
