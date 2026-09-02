export interface LinkCheck {
  enabled: boolean;
  reason: string | null;
}

/**
 * Réplica cliente de las validaciones de `finance.transfers.link`, para
 * deshabilitar el botón con el motivo exacto en vez de esperar al rechazo.
 */
export function canLinkSelection(
  rows: ReadonlyArray<{ id: string; amountCents: string; transferGroupId: string | null }>,
  selected: ReadonlySet<string>
): LinkCheck {
  const chosen = rows.filter((row) => selected.has(row.id));
  if (chosen.length < 2) return { enabled: false, reason: 'se necesitan al menos 2 movimientos' };
  if (chosen.some((row) => row.transferGroupId !== null)) {
    return { enabled: false, reason: 'algún movimiento ya pertenece a un grupo' };
  }
  if (chosen.reduce((sum, row) => sum + BigInt(row.amountCents), 0n) !== 0n) {
    return { enabled: false, reason: 'la selección no suma cero' };
  }
  return { enabled: true, reason: null };
}
