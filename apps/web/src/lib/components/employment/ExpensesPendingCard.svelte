<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import { uploadAttachment, UploadAttachmentError } from '$lib/attachments/upload';
  import {
    parseEuroInput,
    queueEmploymentCommand,
    resolveExpense,
    submitExpense
  } from '$lib/employment/commands';
  import type { PendingExpenseView } from '$lib/employment/model';
  import { syncStatus } from '$lib/offline/sync';

  let {
    householdId,
    agreementId,
    expenses,
    canSubmit,
    canResolve
  }: {
    householdId: string;
    agreementId: string;
    expenses: PendingExpenseView[];
    canSubmit: boolean;
    canResolve: boolean;
  } = $props();

  let busy = $state(false);
  let queued = $state(false);
  let acted = $state<string[]>([]);

  // El contrato exige un motivo también al aprobar; para no obligar a
  // redactarlo en el caso habitual, llega PRE-RELLENADO y editable.
  const DEFAULT_APPROVE_REASON = 'Aprobado';
  const DEFAULT_REJECT_REASON = 'Rechazado';

  let resolveOpenId = $state<string | null>(null);
  let resolveReason = $state('');
  let reasonField = $state<HTMLInputElement | null>(null);

  let expenseDate = $state(new Date().toISOString().slice(0, 10));
  let expenseDescription = $state('');
  let expenseAmount = $state('');
  let expenseError = $state<string | null>(null);
  let expenseSent = $state(false);

  // Justificante (AC-11): la subida de la foto es exclusivamente ONLINE; sin
  // conexión el input se deshabilita y se explica con honestidad. El enlace
  // offline foto→gasto (saveOfflineBlob + flushBlobs) es el siguiente paso.
  const online = $derived($syncStatus.phase !== 'offline');
  let receiptInput = $state<HTMLInputElement | null>(null);
  let receiptNotice = $state<string | null>(null);
  let receiptAttached = $state(false);

  async function run(envelope: Parameters<typeof queueEmploymentCommand>[0], entityId?: string): Promise<void> {
    busy = true;
    try {
      const outcome = await queueEmploymentCommand(envelope);
      queued = outcome === 'queued';
      if (outcome === 'synced') {
        // El servidor ya lo aplicó: el overview fresco decide qué acciones quedan.
        await invalidateAll();
      } else if (entityId) {
        acted = [...acted, entityId];
      }
    } finally {
      busy = false;
    }
  }

  async function submitNewExpense(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    // El importe en euros se convierte a céntimos sin pasar por floats.
    const amountCents = parseEuroInput(expenseAmount);
    if (!amountCents) {
      expenseError = 'Importe inválido: usa un número positivo, p. ej. 12,50';
      return;
    }
    if (!expenseDate || !expenseDescription.trim()) return;
    expenseError = null;
    receiptNotice = null;
    receiptAttached = false;

    // La foto viaja PRIMERO: el comando del gasto referencia el objeto ya
    // confirmado. Si la subida falla (tamaño, tipo, cuarentena o un 503 sin
    // S3/ClamAV configurados) el alta del gasto NO se bloquea: se registra sin
    // justificante y el mensaje explica qué pasó con la foto.
    let receiptStorageObjectId: string | undefined;
    const receiptFile = receiptInput?.files?.[0];
    if (receiptFile && online) {
      busy = true;
      try {
        receiptStorageObjectId = await uploadAttachment(householdId, receiptFile);
      } catch (cause) {
        receiptNotice =
          cause instanceof UploadAttachmentError
            ? `${cause.message} El gasto se registra sin justificante.`
            : 'No se pudo subir la foto. El gasto se registra sin justificante.';
      } finally {
        busy = false;
      }
    }

    await run(
      submitExpense({
        householdId,
        agreementId,
        incurredOn: expenseDate,
        description: expenseDescription,
        amountCents,
        ...(receiptStorageObjectId ? { receiptStorageObjectId } : {})
      })
    );
    expenseDescription = '';
    expenseAmount = '';
    if (receiptInput) receiptInput.value = '';
    receiptAttached = Boolean(receiptStorageObjectId);
    expenseSent = true;
  }

  async function decide(expenseId: string, resolution: 'approved' | 'rejected'): Promise<void> {
    if (!resolveReason.trim()) return;
    await run(
      resolveExpense({ householdId, expenseId, resolution, reason: resolveReason }),
      expenseId
    );
    resolveOpenId = null;
    resolveReason = '';
  }

  function reject(expenseId: string): void {
    const trimmed = resolveReason.trim();
    // Primer click sobre «Rechazar» con el motivo de aprobación intacto: se
    // prellena «Rechazado» y el campo queda editable y con foco para poder
    // matizarlo; el siguiente click confirma con el motivo que haya.
    if (!trimmed || trimmed === DEFAULT_APPROVE_REASON) {
      resolveReason = DEFAULT_REJECT_REASON;
      reasonField?.focus();
      reasonField?.select();
      return;
    }
    void decide(expenseId, 'rejected');
  }
</script>

<article class="card">
  <div class="section-heading">
    <div><p class="eyebrow">Gastos</p><h2>Gastos pendientes</h2></div>
    {#if expenses.length > 0}<span class="status-chip warning">{expenses.length} por revisar</span>{/if}
  </div>

  <div class="ledger-list">
    {#each expenses as expense (expense.id)}
      <div id={`gasto-${expense.id}`}>
        <span>
          <strong>{expense.description}</strong>
          <small>
            {expense.incurredOnLabel} · pendiente de aprobación{#if expense.hasReceipt}&nbsp;· Justificante adjunto ✓{/if}
          </small>
        </span>
        <span class="inline-actions">
          <strong>{expense.amountLabel}</strong>
          {#if acted.includes(expense.id)}
            <span class="status-chip success">Enviado</span>
          {:else if canResolve}
            <button
              class="button secondary small-button"
              type="button"
              disabled={busy}
              aria-expanded={resolveOpenId === expense.id}
              onclick={() => {
                resolveOpenId = resolveOpenId === expense.id ? null : expense.id;
                resolveReason = resolveOpenId ? DEFAULT_APPROVE_REASON : '';
              }}
            >Revisar</button>
          {/if}
        </span>
      </div>
      {#if canResolve && resolveOpenId === expense.id && !acted.includes(expense.id)}
        <form class="action-form" onsubmit={(event) => { event.preventDefault(); void decide(expense.id, 'approved'); }}>
          <label>Motivo de la decisión
            <input
              type="text"
              autocomplete="off"
              enterkeyhint="done"
              bind:value={resolveReason}
              bind:this={reasonField}
              maxlength="500"
              required
              placeholder="Justificante correcto, gasto del hogar…"
            />
          </label>
          <div class="action-row">
            <button class="button primary small-button" type="submit" disabled={busy || !resolveReason.trim()}>Aprobar</button>
            <button
              class="button secondary small-button"
              type="button"
              disabled={busy || !resolveReason.trim()}
              onclick={() => reject(expense.id)}
            >Rechazar</button>
          </div>
        </form>
      {/if}
    {:else}
      <div><span><strong>Sin gastos pendientes</strong><small>No hay justificantes esperando revisión.</small></span></div>
    {/each}
  </div>

  {#if canSubmit}
    <form class="action-form" onsubmit={(event) => void submitNewExpense(event)}>
      <h3>Añadir gasto</h3>
      <div class="form-grid">
        <label>Fecha
          <input type="date" bind:value={expenseDate} required />
        </label>
        <label>Importe (€)
          <input type="text" inputmode="decimal" autocomplete="off" enterkeyhint="next" bind:value={expenseAmount} required placeholder="12,50" />
        </label>
      </div>
      <label>Descripción
        <input type="text" autocomplete="off" enterkeyhint="done" bind:value={expenseDescription} maxlength="500" required placeholder="Farmacia, compra…" />
      </label>
      <label>Foto del justificante (opcional)
        <input
          type="file"
          accept="image/*,application/pdf"
          capture="environment"
          bind:this={receiptInput}
          disabled={busy || !online}
        />
      </label>
      {#if !online}
        <p class="queued-note" role="status">La foto necesita conexión; el gasto puedes guardarlo ya y adjuntar el ticket cuando vuelva la red.</p>
      {/if}
      {#if receiptNotice}<p class="queued-note" role="status">{receiptNotice}</p>{/if}
      {#if expenseError}<p class="queued-note" role="alert">{expenseError}</p>{/if}
      <div class="action-row">
        <button class="button primary small-button" type="submit" disabled={busy}>Añadir gasto</button>
        {#if expenseSent && !queued}
          <span class="status-chip success">{receiptAttached ? 'Enviado · Justificante adjunto ✓' : 'Enviado'}</span>
        {/if}
      </div>
    </form>
  {/if}

  {#if queued}
    <p class="queued-note" role="status">Guardado en este dispositivo; se sincronizará al recuperar la conexión.</p>
  {/if}
</article>
