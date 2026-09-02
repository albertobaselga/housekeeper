/**
 * Borradores por fila de las pantallas de escritura de Finanzas (Ajustes y
 * Movimientos).
 *
 * Los comandos del módulo son REEMPLAZOS completos (`finance.account.update`
 * exige los siete campos; `finance.transaction.update` con `eventIds` borra y
 * reinserta las asignaciones), pero la fila de la que parte cada gesto es la
 * última foto CARGADA DEL SERVIDOR. Con la cola offline, el primer envío queda
 * en `queued` —no hay `invalidate`, así que esa foto no se refresca— y el
 * segundo gesto sobre la MISMA fila partía de datos ya viejos: el primer
 * cambio se perdía en silencio al vaciarse la cola (marcar el evento A y luego
 * el B mandaba `[B]` a secas). Un borrador por fila, acumulado aparte de la
 * foto, cierra el hueco sin tocar el patrón optimista.
 *
 * [FASE 5 · despacho de cierre, F5-I5 + T13-R1..R4] Antes esto era un único
 * `mergeAccountDraft` en `account-drafts.ts` y el resto del ciclo de vida
 * (anotar, revertir, soltar) vivía suelto en el componente, donde no había
 * forma de probarlo: la revisión de T13 pedía revertir en el rechazo (R1),
 * soltar SOLO las claves confirmadas (R2), comparar contra el borrador y no
 * contra la foto vieja (R3) y probar el ciclo de vida en vez de un `spread`
 * (R4). Las cuatro funciones de aquí son puras y no mutan nada de lo que
 * reciben: quien las usa reasigna su `$state`.
 */

/** Parches pendientes por id de fila. */
export type RowDrafts<T> = Record<string, Partial<T>>;

/**
 * La fila tal y como la ve quien edita: foto del servidor, encima el borrador
 * acumulado y encima el parche del gesto en curso. Ese orden es el contrato
 * (R3): el borrador gana a la foto, y el gesto gana al borrador.
 */
export function draftedRow<T extends object>(row: T, draft: Partial<T> | undefined, patch: Partial<T> = {}): T {
  return { ...row, ...draft, ...patch };
}

/** Anota el parche en el borrador de la fila. */
export function withDraft<T extends object>(drafts: RowDrafts<T>, id: string, patch: Partial<T>): RowDrafts<T> {
  return { ...drafts, [id]: { ...drafts[id], ...patch } };
}

/**
 * Suelta del borrador SOLO las claves que llevaba el comando ya confirmado
 * (T13-R2). Borrar la entrada entera se llevaba por delante el parche de un
 * segundo comando aún en vuelo, y la siguiente edición partía de una foto que
 * todavía no lo incluía. Si no queda nada pendiente, la entrada desaparece.
 */
export function releaseDraft<T extends object>(drafts: RowDrafts<T>, id: string, applied: Partial<T>): RowDrafts<T> {
  const current = drafts[id];
  if (!current) return drafts;
  const rest: Partial<T> = {};
  // Recorrido por entradas y copia con `Object.assign`: sin `as` ni `!` (R7),
  // que es lo que exigiría indexar un `Partial<T>` genérico con una clave
  // `string` bajo `noUncheckedIndexedAccess`.
  for (const [key, value] of Object.entries(current)) {
    if (key in applied) continue;
    Object.assign(rest, { [key]: value });
  }
  const next = { ...drafts };
  if (Object.keys(rest).length === 0) delete next[id];
  else next[id] = rest;
  return next;
}

/**
 * Devuelve el borrador de la fila al estado que tenía antes del comando que
 * el servidor acaba de rechazar (T13-R1). Sin esto, el parche rechazado se
 * quedaba en el borrador para siempre: cada edición posterior de esa fila
 * volvía a enviar el valor que el servidor ya había rechazado, y la fila
 * quedaba inservible hasta recargar.
 */
export function restoreDraft<T extends object>(
  drafts: RowDrafts<T>,
  id: string,
  previous: Partial<T> | undefined
): RowDrafts<T> {
  const next = { ...drafts };
  if (previous === undefined) delete next[id];
  else next[id] = previous;
  return next;
}
