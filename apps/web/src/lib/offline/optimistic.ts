import { invalidate } from '$app/navigation';
import { writable, type Writable } from 'svelte/store';
import type { CommandEnvelopeV1 } from '@casa-clara/contracts';

import { describeErrorCode } from './error-codes';
import { listOutbox } from './idb';
import { queueCommand, type QueueCommandResult, type QueueOutcome } from './queue-command';
import { lastFlushAt } from './sync';

/**
 * Orquestador del patrón de referencia de la wiki (`wiki/[slug]/+page.svelte`)
 * para que cualquier página lo replique sin copiarse la maquinaria:
 *
 * 1. La página pinta su estado optimista en `apply()` ANTES de que el comando
 *    viaje: la UI responde al gesto sin esperar a la red.
 * 2. `queueCommand` devuelve el resultado veraz por ACK y aquí se reconcilia:
 *      - synced   → nota verde con el mensaje real e `invalidate(token)`
 *                   SELECTIVO (un solo load re-ejecutado, sin re-firmar el
 *                   snapshot del layout); después `settle()` retira el estado
 *                   optimista sin parpadeo.
 *      - queued   → nota ámbar honesta; la operación queda vigilada y
 *                   `lastFlushAt` (sync.ts) dispara la reconciliación cuando
 *                   un flush posterior la confirma… o la rechaza.
 *      - rejected/conflict → `revert()` INMEDIATO del estado optimista y nota
 *                   roja con la causa traducida. Jamás «se sincronizará».
 *
 * El estado (`status`) es un store para que el módulo siga siendo TypeScript
 * puro (unit-testeable sin compilar componentes).
 */

export interface ActionFeedback {
  tone: 'success' | 'pending' | 'error';
  text: string;
}

export interface OptimisticHooks {
  /** Pintado local inmediato, antes del envío. */
  apply?: () => void;
  /** Reversión ante rejected/conflict. */
  revert?: () => void;
  /** Datos frescos confirmados (corre tras el invalidate selectivo). */
  settle?: () => void;
}

interface TrackedOperation {
  operationId: string;
  hooks: OptimisticHooks;
}

export interface OptimisticActionsOptions {
  householdId: string;
  /** Token declarado con `depends()` en el +page.server.ts de la página. */
  invalidateToken: string;
  /** Inyectables para tests (por defecto, los reales). */
  queueCommandFn?: typeof queueCommand;
  invalidateFn?: (token: string) => Promise<void>;
  listOutboxFn?: typeof listOutbox;
}

export class OptimisticActions {
  /** Nota unificada para <ActionStatus>: siempre el mensaje veraz por outcome. */
  readonly status: Writable<ActionFeedback | null> = writable(null);

  private tracked: TrackedOperation[] = [];
  private reconciling = false;
  private readonly options: Required<OptimisticActionsOptions>;

  constructor(options: OptimisticActionsOptions) {
    this.options = {
      queueCommandFn: queueCommand,
      invalidateFn: (token: string) => invalidate(token),
      listOutboxFn: listOutbox,
      ...options
    };
  }

  /**
   * Reconciliación diferida: cuando un flush posterior (reconexión, otra
   * acción) aplica cambios, se comprueba el destino REAL de cada operación
   * que quedó en cola. Llamar dentro de un `$effect` de la página; devuelve
   * el unsubscribe.
   */
  start(): () => void {
    return lastFlushAt.subscribe((value) => {
      if (value === null) return;
      void this.reconcile();
    });
  }

  dismiss(): void {
    this.status.set(null);
  }

  /** Encola el comando con pintado optimista inmediato y resultado veraz. */
  async run(envelope: CommandEnvelopeV1, hooks: OptimisticHooks = {}): Promise<QueueOutcome> {
    hooks.apply?.();
    const result = await this.options.queueCommandFn(envelope);
    await this.applyResult(result, envelope.operationId, hooks);
    return result.outcome;
  }

  private async applyResult(
    result: QueueCommandResult,
    operationId: string,
    hooks: OptimisticHooks
  ): Promise<void> {
    if (result.outcome === 'synced') {
      this.status.set({ tone: 'success', text: result.message });
      await this.options.invalidateFn(this.options.invalidateToken);
      hooks.settle?.();
    } else if (result.outcome === 'queued') {
      this.tracked.push({ operationId, hooks });
      this.status.set({ tone: 'pending', text: result.message });
    } else {
      // rejected/conflict: reversión inmediata + causa veraz.
      hooks.revert?.();
      this.status.set({ tone: 'error', text: result.message });
    }
  }

  private failureFeedback(status: 'rejected' | 'conflict', errorCode: string | undefined): ActionFeedback {
    const cause = describeErrorCode(errorCode);
    if (status === 'conflict') {
      return {
        tone: 'error',
        text: cause
          ? `Conflicto con otro cambio: ${cause}. Necesita tu decisión.`
          : 'Conflicto con otro cambio: necesita tu decisión.'
      };
    }
    return {
      tone: 'error',
      text: cause ? `No se pudo guardar: ${cause}.` : 'No se pudo guardar: el servidor rechazó el cambio.'
    };
  }

  /** Expuesto para tests; en producción lo dispara `start()` vía lastFlushAt. */
  async reconcile(): Promise<void> {
    if (this.reconciling || this.tracked.length === 0) return;
    this.reconciling = true;
    try {
      const records = await this.options.listOutboxFn(this.options.householdId);
      const remaining: TrackedOperation[] = [];
      const settled: OptimisticHooks[] = [];
      let failure: ActionFeedback | null = null;
      for (const operation of this.tracked) {
        const record = records.find((candidate) => candidate.id === operation.operationId);
        if (record && record.status === 'pending') {
          remaining.push(operation);
        } else if (!record) {
          // Ausente del outbox = un flush lo confirmó en el servidor.
          settled.push(operation.hooks);
        } else {
          operation.hooks.revert?.();
          failure = this.failureFeedback(record.status as 'rejected' | 'conflict', record.lastErrorCode);
        }
      }
      this.tracked = remaining;
      if (settled.length > 0) {
        this.status.set({ tone: 'success', text: 'Cambio sincronizado.' });
        await this.options.invalidateFn(this.options.invalidateToken);
        for (const hooks of settled) hooks.settle?.();
      }
      // Un fallo pisa la nota verde: lo que exige decisión va delante.
      if (failure) this.status.set(failure);
    } finally {
      this.reconciling = false;
    }
  }
}
