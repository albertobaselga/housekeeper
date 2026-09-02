/**
 * Fusión de la cuenta editable de Ajustes (Important 1, revisión ronda 1 de
 * Task 13, cierre de fase 5).
 *
 * `finance.account.update` es un reemplazo completo del registro (exige los
 * siete campos), pero la fila de la que parte cada edición es la última foto
 * CARGADA DEL SERVIDOR. Con la cola offline, el primer `onblur` deja el
 * resultado en `queued` — no hay `invalidate`, así que esa foto no se
 * refresca —, y sin nada más el segundo `onblur` de la MISMA fila construía
 * el comando sobre datos ya viejos: el primer campo editado se perdía en
 * silencio en cuanto la cola se vaciaba (el envío más reciente "ganaba" con
 * el valor antiguo). Un borrador por cuenta, acumulado aparte de la foto del
 * servidor y soltado solo cuando llegan datos frescos (`settle`), cierra el
 * hueco sin tocar el resto del patrón optimista.
 */
export function mergeAccountDraft<T extends object>(
  account: T,
  draft: Partial<T> | undefined,
  patch: Partial<T>
): T {
  return { ...account, ...draft, ...patch };
}
