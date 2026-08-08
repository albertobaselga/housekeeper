<script lang="ts">
  import { browser } from '$app/environment';
  import { invalidateAll } from '$app/navigation';
  import {
    describeCommand,
    describeError,
    isBlockedByAttachment,
    retryableEnvelope,
    triageableRecords
  } from '$lib/components/outbox-triage';
  import { queueFoodCommand } from '$lib/food/commands';
  import { deleteOfflineBlob, discardOutboxRecord, listOutbox, queueOutbox } from '$lib/offline/idb';
  import type { OutboxRecord } from '$lib/offline/schema';
  import { refreshSyncStatus } from '$lib/offline/sync';

  // Triaje genérico del outbox: lista los conflict/rejected de CUALQUIER
  // agregado del hogar y ofrece Reintentar (operationId nuevo) o Descartar.
  // Se oculta solo cuando no hay nada que decidir. El de employment
  // (OutboxTriageCard) sigue existiendo con su filtro laboral.
  let { householdId }: { householdId: string } = $props();

  let records = $state<OutboxRecord[]>([]);
  let busy = $state(false);

  async function refresh(): Promise<void> {
    if (!browser) return;
    try {
      records = triageableRecords(await listOutbox(householdId));
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
      // La foto que este cambio esperaba se va con él: si el cambio no se
      // guarda, nadie va a subir ya su justificante y dejarla ocuparía sitio
      // en el dispositivo para siempre.
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
        // Aquí el servidor NUNCA vio el comando: lo que falló fue la subida de
        // la foto. El operationId sigue siendo válido, así que basta con
        // devolverlo a la cola y poner el contador a cero para que el próximo
        // flush reintente la subida con la foto que sigue en el dispositivo.
        const revived = { ...record, status: 'pending' as const, blobAttempts: 0 };
        delete revived.lastErrorCode;
        await queueOutbox(revived);
      } else {
        // Copia con operationId NUEVO: el original ya fue consumido por el
        // servidor. Se borra el registro viejo antes de encolar la copia.
        await discardOutboxRecord(record.id);
        await queueFoodCommand(retryableEnvelope(record.envelope));
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
  <article class="card outbox-triage">
    <div class="section-heading">
      <div><p class="eyebrow">Cambios sin guardar</p><h2>Revisión necesaria</h2></div>
      <span class="status-chip warning">{records.length} sin resolver</span>
    </div>
    <p class="audit-note">
      Estos cambios no llegaron a guardarse: suele haber un dato más reciente, o una foto que no
      pudo subir. Revisa la pantalla antes de reintentar. Descartar elimina el cambio —y su foto—
      solo de este dispositivo.
    </p>
    <div class="ledger-list">
      {#each records as record (record.id)}
        <div>
          <span>
            <strong>{describeCommand(record.envelope)}</strong>
            <small>
              {isBlockedByAttachment(record)
                ? 'La foto no llegó a la casa y el cambio sigue esperando aquí'
                : record.status === 'conflict'
                  ? 'Hay una versión más reciente guardada'
                  : 'El cambio no se pudo aplicar'}
              {#if describeError(record.lastErrorCode)}
                · {describeError(record.lastErrorCode)}
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
