<script lang="ts">
  import { untrack } from 'svelte';
  import { createOutboxRecord } from '$lib/offline/schema';
  import { queueOutbox, saveOfflineBlob } from '$lib/offline/idb';
  import { refreshSyncStatus } from '$lib/offline/sync';

  let {
    householdId,
    pageId,
    initialValue,
    onSaved
  }: {
    householdId: string;
    pageId: string;
    initialValue: string;
    onSaved: () => void;
  } = $props();

  let value = $state(untrack(() => initialValue));
  let attachment = $state<File | null>(null);
  let saving = $state(false);

  async function save(): Promise<void> {
    saving = true;
    const operationId = crypto.randomUUID();
    let blobId: string | null = null;

    if (attachment) {
      blobId = crypto.randomUUID();
      await saveOfflineBlob({
        id: blobId,
        householdId,
        contentType: attachment.type || 'application/octet-stream',
        size: attachment.size,
        createdAt: new Date().toISOString(),
        blob: attachment
      });
    }

    await queueOutbox(createOutboxRecord({
      id: operationId,
      idempotencyKey: operationId,
      householdId,
      operation: 'content.write',
      payload: { pageId, body: value, blobId }
    }));
    await refreshSyncStatus();
    saving = false;
    onSaved();
  }
</script>

<div class="editor-panel">
  <label for="wiki-body">Contenido</label>
  <textarea id="wiki-body" rows="10" bind:value></textarea>
  <label class="file-field" for="wiki-attachment">
    <span>Adjunto opcional</span>
    <input id="wiki-attachment" type="file" onchange={(event) => attachment = event.currentTarget.files?.[0] ?? null} />
    <small>Se conserva en el almacén local de blobs hasta que el servidor confirme el cambio.</small>
  </label>
  <button class="button primary" type="button" disabled={saving || !value.trim()} onclick={() => void save()}>{saving ? 'Guardando…' : 'Guardar en este dispositivo'}</button>
</div>
