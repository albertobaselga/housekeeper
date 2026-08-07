export type SyncPhase = 'saved' | 'offline' | 'pending' | 'syncing' | 'conflict' | 'error';

export interface SyncFacts {
  online: boolean;
  pendingCount: number;
  syncing?: boolean;
  conflict?: boolean;
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
  if (facts.conflict) {
    return {
      phase: 'conflict',
      label: 'Revisión necesaria',
      detail: 'Hay un cambio que no se puede combinar automáticamente.'
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
