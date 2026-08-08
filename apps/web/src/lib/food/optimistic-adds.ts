/**
 * Dedupe visual de los añadidos optimistas de la compra.
 *
 * Un añadido se pinta antes de que el comando viaje. Si alguien apunta dos
 * veces lo mismo casi a la vez, la lista provisional debe enseñar UNA línea
 * («Servilletas ×2»), no dos filas idénticas que parecen un error de la
 * aplicación. Y en cuanto los datos frescos del servidor ya listan ese nombre,
 * la fila provisional desaparece sin solaparse con la real ni parpadear.
 *
 * Es una función pura para poder probarla sin montar el componente.
 */

export interface OptimisticAddition {
  /** Identidad del comando: también la clave de lista de Svelte. */
  operationId: string;
  name: string;
  quantity: string;
  unit: string;
  listKind: 'casa' | 'personal';
}

export interface CollapsedAddition extends OptimisticAddition {
  /** Cuántos añadidos idénticos representa esta línea provisional. */
  times: number;
}

/** Misma normalización que usa el servidor para fusionar: minúsculas y sin bordes. */
export function normalizeAdditionName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * @param additions añadidos aún sin confirmar, en orden de llegada.
 * @param serverNames nombres ya presentes en los datos frescos, normalizados.
 */
export function collapseOptimisticAdds(
  additions: readonly OptimisticAddition[],
  serverNames: ReadonlySet<string>
): CollapsedAddition[] {
  const grouped = new Map<string, CollapsedAddition>();
  for (const addition of additions) {
    const normalized = normalizeAdditionName(addition.name);
    if (serverNames.has(normalized)) continue;
    const key = `${addition.listKind}|${normalized}|${addition.quantity}|${addition.unit}`;
    const existing = grouped.get(key);
    if (existing) existing.times += 1;
    else grouped.set(key, { ...addition, times: 1 });
  }
  return [...grouped.values()];
}
