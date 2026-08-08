import { browser } from '$app/environment';
import type { CommandEnvelopeV1 } from '@casa-clara/contracts';

import { listOutbox, queueOutbox } from './idb';
import { createOutboxRecord, type OutboxPendingBlob } from './schema';
import { describeErrorCodeLazy } from './error-codes-lazy';
import {
  flushOutbox,
  performSyncFlush,
  refreshSyncStatus,
  type SyncCommandAck
} from './sync';

/**
 * Encolado UNIFICADO de comandos (sustituye a las 4 copias que vivían en
 * employment/wiki/food/access). Offline-first: persiste SIEMPRE primero en el
 * outbox, intenta un flush inmediato y devuelve un resultado veraz leyendo el
 * ACK real del servidor:
 *
 * - `synced`   → el servidor lo aplicó (accepted/duplicate). Verde.
 * - `queued`   → sin red o servidor caído: quedó pendiente y se reenviará
 *                solo. Ámbar. Es el ÚNICO estado que puede anunciarse como
 *                «se sincronizará».
 * - `rejected` → el servidor lo rechazó: NO se reenviará jamás; `message`
 *                lleva la causa traducida (diccionario compartido). Rojo.
 * - `conflict` → choca con otro cambio: necesita decisión humana (triaje).
 *
 * Los wrappers queue*Command de cada módulo delegan aquí conservando su firma
 * (devuelven solo `outcome`); las páginas que quieran el mensaje completo
 * llaman a `queueCommand` directamente.
 */

export type QueueOutcome = 'synced' | 'queued' | 'rejected' | 'conflict';

/** Reintentos del flush para taps encadenados (otro flush en vuelo). */
const CHAINED_FLUSH_ATTEMPTS = 5;
const CHAINED_FLUSH_DELAY_MS = 150;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface QueueCommandResult {
  outcome: QueueOutcome;
  /** Código crudo del ACK (p. ej. `wiki_revision_conflict`), si lo hubo. */
  errorCode?: string;
  /** Copy listo para mostrar, coherente en toda la app. */
  message: string;
}

// P2-9 (revisión UX v3): «sincronizado» es de informático; la nota dice
// «guardado», que es lo que la persona quería conseguir.
const MESSAGES: Record<Exclude<QueueOutcome, 'rejected' | 'conflict'>, string> = {
  synced: 'Guardado ✓',
  queued: 'Guardado en este dispositivo; se enviará al recuperar la conexión.'
};

async function resultFor(outcome: QueueOutcome, errorCode?: string): Promise<QueueCommandResult> {
  if (outcome === 'rejected') {
    const cause = await describeErrorCodeLazy(errorCode);
    return {
      outcome,
      ...(errorCode ? { errorCode } : {}),
      message: cause ? `No se pudo guardar: ${cause}.` : 'No se pudo guardar el cambio.'
    };
  }
  if (outcome === 'conflict') {
    const cause = await describeErrorCodeLazy(errorCode);
    return {
      outcome,
      ...(errorCode ? { errorCode } : {}),
      message: cause
        ? `Conflicto con otro cambio: ${cause}. Necesita tu decisión.`
        : 'Conflicto con otro cambio: necesita tu decisión.'
    };
  }
  return { outcome, message: MESSAGES[outcome] };
}

function outcomeFromAck(ack: SyncCommandAck): Promise<QueueCommandResult> {
  switch (ack.status) {
    case 'accepted':
    case 'duplicate':
      return resultFor('synced');
    case 'conflict':
      return resultFor('conflict', ack.errorCode);
    case 'rejected':
      return resultFor('rejected', ack.errorCode);
    case 'retryable':
      // El servidor pide reintentar más tarde: sigue pendiente, no miente.
      return resultFor('queued');
  }
}

export interface QueueCommandOptions {
  /**
   * Dependencias explícitas (tests y herramientas): con `fetchFn` el flush se
   * ejecuta directamente contra esa red y esa base, sin pasar por el monitor
   * del navegador (que exige `browser === true` y un hogar activo).
   */
  fetchFn?: typeof fetch;
  databaseName?: string;
  /**
   * Foto capturada sin conexión que este comando debe llevar enlazada: el
   * comando espera en el outbox hasta que la foto se sube y su identificador
   * real entra en el payload (ver `linkPendingBlobs` en sync.ts).
   */
  pendingBlob?: OutboxPendingBlob;
}

export async function queueCommand(
  envelope: CommandEnvelopeV1,
  options: QueueCommandOptions = {}
): Promise<QueueCommandResult> {
  const { fetchFn, databaseName, pendingBlob } = options;

  // 1) Persistencia local SIEMPRE primero: pase lo que pase con la red, el
  //    cambio no se pierde.
  await queueOutbox(createOutboxRecord(envelope, pendingBlob ? { pendingBlob } : {}), databaseName);
  await refreshSyncStatus();

  // 2) Intento de envío inmediato, capturando el mapa de acks del flush.
  const captured: { acks: ReadonlyMap<string, SyncCommandAck> | null } = { acks: null };
  if (fetchFn) {
    await performSyncFlush(envelope.householdId, fetchFn, databaseName, {
      onAcks: (map) => {
        captured.acks = map;
      }
    });
  } else {
    captured.acks = await flushOutbox();
    // Taps ENCADENADOS: si otro flush estaba en vuelo cuando se encoló este
    // comando, flushOutbox devuelve sin su ACK y nadie lo reenviaría hasta el
    // próximo evento (otra acción o la reconexión). Mientras haya red se
    // reintenta el flush unas pocas veces hasta leer el ACK real de ESTA
    // operación; si aun así sigue pendiente, el resultado honesto es 'queued'
    // y la reconciliación diferida (lastFlushAt) hará el resto.
    if (browser && !captured.acks?.get(envelope.operationId)) {
      for (let attempt = 0; attempt < CHAINED_FLUSH_ATTEMPTS; attempt += 1) {
        if (!navigator.onLine) break;
        const record = (await listOutbox(envelope.householdId, databaseName)).find(
          (candidate) => candidate.id === envelope.operationId
        );
        if (!record || record.status !== 'pending') break;
        await delay(CHAINED_FLUSH_DELAY_MS);
        const acks = await flushOutbox();
        if (acks?.get(envelope.operationId)) {
          captured.acks = acks;
          break;
        }
      }
    }
  }

  // 3) Resultado veraz: primero el ACK real de ESTA operación…
  const ack = captured.acks?.get(envelope.operationId);
  if (ack) {
    await refreshSyncStatus();
    return outcomeFromAck(ack);
  }

  // …y si el flush no llegó a producirse (offline, otro flush en vuelo, fallo
  // de red) el outbox es la fuente de verdad: ausente = un flush concurrente
  // ya lo confirmó; pending = quedó en cola; rejected/conflict = un ACK
  // anterior ya lo marcó y NO va a reenviarse.
  const record = (await listOutbox(envelope.householdId, databaseName)).find(
    (candidate) => candidate.id === envelope.operationId
  );
  await refreshSyncStatus();
  if (!record) return resultFor('synced');
  if (record.status === 'rejected') return resultFor('rejected', record.lastErrorCode);
  if (record.status === 'conflict') return resultFor('conflict', record.lastErrorCode);
  return resultFor('queued');
}
