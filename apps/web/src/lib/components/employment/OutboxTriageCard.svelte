<script lang="ts">
  import { browser } from '$app/environment';
  import { invalidateAll } from '$app/navigation';
  import {
    describeEmploymentCommand,
    describeErrorCode,
    retryEnvelope,
    triageableEmploymentRecords
  } from '$lib/employment/outbox';
  import { queueEmploymentCommand } from '$lib/employment/commands';
  import { discardOutboxRecord, listOutbox } from '$lib/offline/idb';
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
      // Copia con operationId NUEVO: el original ya fue consumido por el
      // servidor. Se borra el registro viejo antes de encolar la copia.
      await discardOutboxRecord(record.id);
      await queueEmploymentCommand(retryEnvelope(record.envelope));
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
      <div><p class="eyebrow">Cambios sin sincronizar</p><h2>Pendientes de tu decisión</h2></div>
      <span class="status-chip warning">{records.length} sin resolver</span>
    </div>
    <p class="audit-note">
      Un conflicto suele significar que el servidor ya tiene otro estado más reciente:
      revisa el expediente antes de reintentar. Descartar elimina el cambio solo de este dispositivo.
    </p>
    <div class="ledger-list">
      {#each records as record (record.id)}
        <div>
          <span>
            <strong>{describeEmploymentCommand(record.envelope)}</strong>
            <small>
              {record.status === 'conflict' ? 'Conflicto con el servidor' : 'Rechazado por el servidor'}
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
