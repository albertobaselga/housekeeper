export type SyncPhase = 'saved' | 'offline' | 'pending' | 'syncing' | 'conflict' | 'error';

export interface SyncFacts {
  online: boolean;
  /** Comandos a la espera de red (ámbar): se enviarán solos. */
  pendingCount: number;
  syncing?: boolean;
  /** Hay al menos un rejected/conflict (rojo): necesita decisión humana. */
  conflict?: boolean;
  /** Cuántos rejected/conflict exactamente; afina el copy del estado rojo. */
  attentionCount?: number;
  storageError?: boolean;
}

export interface SyncPresentation {
  phase: SyncPhase;
  label: string;
  detail: string;
}

export function deriveSyncState(facts: SyncFacts): SyncPresentation {
  if (facts.storageError) {
    return {
      phase: 'error',
      label: 'Guardado local no disponible',
      detail: 'Mantén esta pestaña abierta y vuelve a intentarlo.'
    };
  }
  // Semántica en dos niveles: ámbar = «pendiente de red» (se resolverá solo al
  // volver la conexión); rojo = «necesita tu decisión» (el servidor ya dijo
  // rejected/conflict y NO se reenviará automáticamente).
  if (facts.conflict || (facts.attentionCount ?? 0) > 0) {
    const count = facts.attentionCount ?? 0;
    return {
      phase: 'conflict',
      label: count > 0 ? `Necesita tu decisión · ${count}` : 'Necesita tu decisión',
      detail:
        count === 1
          ? 'Hay 1 cambio rechazado o en conflicto que no se aplicará solo.'
          : count > 1
            ? `Hay ${count} cambios rechazados o en conflicto que no se aplicarán solos.`
            : 'Hay un cambio rechazado o en conflicto que no se aplicará solo.'
    };
  }
  if (!facts.online) {
    return {
      phase: 'offline',
      label: facts.pendingCount ? `Sin conexión · ${facts.pendingCount} pendiente${facts.pendingCount === 1 ? '' : 's'}` : 'Sin conexión',
      detail: 'El contenido crítico guardado sigue disponible.'
    };
  }
  if (facts.syncing) {
    return { phase: 'syncing', label: 'Sincronizando…', detail: 'Enviando cambios guardados.' };
  }
  if (facts.pendingCount > 0) {
    return {
      phase: 'pending',
      label: `${facts.pendingCount} cambio${facts.pendingCount === 1 ? '' : 's'} pendiente${facts.pendingCount === 1 ? '' : 's'}`,
      detail: 'Guardado en este dispositivo; falta confirmación del servidor.'
    };
  }
  return { phase: 'saved', label: 'Todo guardado', detail: 'No hay cambios pendientes.' };
}
