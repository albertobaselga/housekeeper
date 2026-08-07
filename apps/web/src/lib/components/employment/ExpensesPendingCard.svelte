<script lang="ts">
  import ActionStatus from '$lib/components/ActionStatus.svelte';
  import { OptimisticActions } from '$lib/offline/optimistic';
  import { uploadAttachment, UploadAttachmentError } from '$lib/attachments/upload';
  import { parseEuroInput, resolveExpense, submitExpense } from '$lib/employment/commands';
  import { dateLabel, formatCents, type PendingExpenseView } from '$lib/employment/model';
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

  // Patrón wiki (P2-1): decisiones y altas se pintan al instante, con
  // `invalidate('cc:employment')` selectivo tras el ACK y reversión honesta.
  // svelte-ignore state_referenced_locally -- el hogar no cambia dentro de la página
  const optimistic = new OptimisticActions({ householdId, invalidateToken: 'cc:employment' });
  const actionStatus = optimistic.status;
  $effect(() => optimistic.start());

  // Entidades ya actuadas: el chip sustituye a los botones al instante y solo
  // vuelve atrás si el servidor rechaza la decisión.
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
  let uploadBusy = $state(false);

  // Alta optimista: la fila nueva aparece YA como «pendiente de aprobación» y
  // se dedupe por descripción cuando los datos frescos la traen del servidor.
  type OptimisticExpense = { operationId: string; description: string; amountLabel: string; incurredOnLabel: string };
  let optimisticExpenses = $state<OptimisticExpense[]>([]);
  const pendingOptimistic = $derived(
    optimisticExpenses.filter((draft) => !expenses.some((expense) => expense.description === draft.description))
  );

  // Justificante (AC-11): la subida de la foto es exclusivamente ONLINE; sin
  // conexión el input se deshabilita y se explica con honestidad. El enlace
  // offline foto→gasto (saveOfflineBlob + flushBlobs) es el siguiente paso.
  const online = $derived($syncStatus.phase !== 'offline');
  let receiptInput = $state<HTMLInputElement | null>(null);
  let receiptNotice = $state<string | null>(null);
  let receiptAttached = $state(false);

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
      uploadBusy = true;
      try {
        receiptStorageObjectId = await uploadAttachment(householdId, receiptFile);
      } catch (cause) {
        receiptNotice =
          cause instanceof UploadAttachmentError
            ? `${cause.message} El gasto se registra sin justificante.`
            : 'No se pudo subir la foto. El gasto se registra sin justificante.';
      } finally {
        uploadBusy = false;
      }
    }

    const description = expenseDescription.trim();
    const envelope = submitExpense({
      householdId,
      agreementId,
      incurredOn: expenseDate,
      description,
      amountCents,
      ...(receiptStorageObjectId ? { receiptStorageObjectId } : {})
    });
    const removeDraft = () => {
      optimisticExpenses = optimisticExpenses.filter((draft) => draft.operationId !== envelope.operationId);
    };
    receiptAttached = Boolean(receiptStorageObjectId);
    await optimistic.run(envelope, {
      apply: () => {
        optimisticExpenses = [
          ...optimisticExpenses,
          {
            operationId: envelope.operationId,
            description,
            amountLabel: formatCents(amountCents),
            incurredOnLabel: dateLabel(expenseDate)
          }
        ];
        expenseDescription = '';
        expenseAmount = '';
        if (receiptInput) receiptInput.value = '';
        expenseSent = true;
      },
      revert: () => {
        removeDraft();
        expenseSent = false;
      },
      settle: removeDraft
    });
  }

  function decide(expenseId: string, resolution: 'approved' | 'rejected'): void {
    if (!resolveReason.trim()) return;
    const envelope = resolveExpense({ householdId, expenseId, resolution, reason: resolveReason });
    void optimistic.run(envelope, {
      apply: () => {
        acted = [...acted, expenseId];
        resolveOpenId = null;
        resolveReason = '';
      },
      revert: () => {
        acted = acted.filter((candidate) => candidate !== expenseId);
      }
    });
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
    decide(expenseId, 'rejected');
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
        <form class="action-form" onsubmit={(event) => { event.preventDefault(); decide(expense.id, 'approved'); }}>
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
            <button class="button primary small-button" type="submit" disabled={!resolveReason.trim()}>Aprobar</button>
            <button
              class="button secondary small-button"
              type="button"
              disabled={!resolveReason.trim()}
              onclick={() => reject(expense.id)}
            >Rechazar</button>
          </div>
        </form>
      {/if}
    {:else}
      {#if pendingOptimistic.length === 0}
        <div><span><strong>Sin gastos pendientes</strong><small>No hay justificantes esperando revisión.</small></span></div>
      {/if}
    {/each}
    {#each pendingOptimistic as draft (draft.operationId)}
      <div>
        <span>
          <strong>{draft.description}</strong>
          <small>{draft.incurredOnLabel} · pendiente de aprobación</small>
        </span>
        <span class="inline-actions">
          <strong>{draft.amountLabel}</strong>
        </span>
      </div>
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
          disabled={uploadBusy || !online}
        />
      </label>
      {#if !online}
        <p class="queued-note" role="status">La foto necesita conexión; el gasto puedes guardarlo ya y adjuntar el ticket cuando vuelva la red.</p>
      {/if}
      {#if receiptNotice}<p class="queued-note" role="status">{receiptNotice}</p>{/if}
      {#if expenseError}<p class="queued-note" role="alert">{expenseError}</p>{/if}
      <div class="action-row">
        <button class="button primary small-button" type="submit" disabled={uploadBusy}>Añadir gasto</button>
        {#if expenseSent}
          <span class="status-chip success">{receiptAttached ? 'Enviado · Justificante adjunto ✓' : 'Enviado'}</span>
        {/if}
      </div>
    </form>
  {/if}

  <ActionStatus status={actionStatus} />
</article>
