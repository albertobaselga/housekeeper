<script lang="ts">
  import { browser } from '$app/environment';
  import { invalidateAll } from '$app/navigation';
  import { describeCommand, describeError, retryableEnvelope, triageableRecords } from '$lib/components/outbox-triage';
  import { queueFoodCommand } from '$lib/food/commands';
  import { discardOutboxRecord, listOutbox } from '$lib/offline/idb';
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
      await queueFoodCommand(retryableEnvelope(record.envelope));
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
      <div><p class="eyebrow">Cambios sin sincronizar</p><h2>Revisión necesaria</h2></div>
      <span class="status-chip warning">{records.length} sin resolver</span>
    </div>
    <p class="audit-note">
      Estos cambios no llegaron al servidor. Un conflicto suele significar que ya existe un estado
      más reciente: revisa la pantalla correspondiente antes de reintentar. Descartar elimina el
      cambio solo de este dispositivo.
    </p>
    <div class="ledger-list">
      {#each records as record (record.id)}
        <div>
          <span>
            <strong>{describeCommand(record.envelope)}</strong>
            <small>
              {record.status === 'conflict' ? 'Conflicto con el servidor' : 'Rechazado por el servidor'}
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
