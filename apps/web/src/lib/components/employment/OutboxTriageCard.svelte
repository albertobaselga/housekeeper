<script lang="ts">
  import { browser } from '$app/environment';
  import { invalidateAll } from '$app/navigation';
  import {
    describeEmploymentCommand,
    describeErrorCode,
    retryEnvelope,
    triageableEmploymentRecords
  } from '$lib/employment/outbox';
  import { isBlockedByAttachment } from '$lib/components/outbox-triage';
  import { queueEmploymentCommand } from '$lib/employment/commands';
  import { deleteOfflineBlob, discardOutboxRecord, listOutbox, queueOutbox } from '$lib/offline/idb';
  import type { OutboxRecord } from '$lib/offline/schema';
  import { refreshSyncStatus } from '$lib/offline/sync';

  let { householdId }: { householdId: string } = $props();

  let records = $state<OutboxRecord[]>([]);
  let busy = $state(false);

  async function refresh(): Promise<void> {
    if (!browser) return;
    try {
      records = triageableEmploymentRecords(await listOutbox(householdId));
    } catch {
      // Sin IndexedDB (o averiado) no hay triaje posible; la sección se oculta.
      records = [];
    }
  }

  $effect(() => {
    void refresh();
  });

  async function discard(record: OutboxRecord): Promise<void> {
    busy = true;
    try {
      await discardOutboxRecord(record.id);
      // La foto que este gasto esperaba se va con él: nadie va a subir ya un
      // justificante de un cambio descartado.
      if (record.pendingBlob) await deleteOfflineBlob(record.pendingBlob.id);
      await refreshSyncStatus();
      await refresh();
      await invalidateAll();
    } finally {
      busy = false;
    }
  }

  async function retry(record: OutboxRecord): Promise<void> {
    busy = true;
    try {
      if (isBlockedByAttachment(record)) {
        // El servidor NUNCA vio este comando: lo que falló fue la subida de la
        // foto. El operationId sigue libre, así que vuelve a la cola con el
        // contador a cero y el próximo flush reintenta la subida.
        const revived = { ...record, status: 'pending' as const, blobAttempts: 0 };
        delete revived.lastErrorCode;
        await queueOutbox(revived);
      } else {
        // Copia con operationId NUEVO: el original ya fue consumido por el
        // servidor. Se borra el registro viejo antes de encolar la copia.
        await discardOutboxRecord(record.id);
        await queueEmploymentCommand(retryEnvelope(record.envelope));
      }
      await refreshSyncStatus();
      await refresh();
      await invalidateAll();
    } finally {
      busy = false;
    }
  }
</script>

{#if records.length > 0}
  <article class="card">
    <div class="section-heading">
      <div><p class="eyebrow">Cambios sin guardar</p><h2>Pendientes de tu decisión</h2></div>
      <span class="status-chip warning">{records.length} sin resolver</span>
    </div>
    <p class="audit-note">
      Suele significar que ya hay un dato más reciente guardado, y a veces que la foto que
      acompañaba al cambio no se pudo subir: revisa la página antes de reintentar. Descartar elimina
      el cambio —y la foto que esperaba— solo de este dispositivo.
    </p>
    <div class="ledger-list">
      {#each records as record (record.id)}
        <div>
          <span>
            <strong>{describeEmploymentCommand(record.envelope)}</strong>
            <small>
              {isBlockedByAttachment(record)
                ? 'La foto no llegó a la casa, así que el gasto sigue esperando en este dispositivo'
                : record.status === 'conflict'
                  ? 'Hay una versión más reciente guardada'
                  : 'El cambio no se pudo aplicar'}
              {#if describeErrorCode(record.lastErrorCode)}
                · {describeErrorCode(record.lastErrorCode)}
              {/if}
            </small>
          </span>
          <span class="inline-actions">
            <button
              class="button secondary small-button"
              type="button"
              disabled={busy}
              onclick={() => void retry(record)}
            >Reintentar</button>
            <button
              class="button secondary small-button"
              type="button"
              disabled={busy}
              onclick={() => void discard(record)}
            >Descartar</button>
          </span>
        </div>
      {/each}
    </div>
  </article>
{/if}
