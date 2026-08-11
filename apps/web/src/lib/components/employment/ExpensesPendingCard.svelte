<script lang="ts">
  import ActionStatus from '$lib/components/ActionStatus.svelte';
  import { OptimisticActions } from '$lib/offline/optimistic';
  import { saveOfflineBlob } from '$lib/offline/idb';
  import type { OutboxPendingBlob } from '$lib/offline/schema';
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

  // Justificante (AC-11): con conexión la foto viaja antes que el gasto. SIN
  // conexión la foto se guarda en este dispositivo y el gasto ESPERA a que
  // vuelva la red: entonces la foto se sube y su identificador entra en el
  // mismo comando, así que el gasto nace ya con su justificante enlazado.
  const online = $derived($syncStatus.phase !== 'offline');
  /** Elegir un fichero y hacer una foto son DOS campos distintos: con el
   * atributo `capture` puesto, el móvil abre la cámara y ya no ofrece la
   * galería ni los ficheros, así que con un solo campo siempre falta una de
   * las dos formas. */
  let receiptPickInput = $state<HTMLInputElement | null>(null);
  let receiptCameraInput = $state<HTMLInputElement | null>(null);
  /** Fichero elegido, YA preparado para subir (reducido si hacía falta). */
  let receiptFile = $state<File | null>(null);
  let receiptNotice = $state<string | null>(null);
  let receiptAttached = $state(false);
  let receiptBusy = $state(false);
  /** La foto está guardada aquí y el gasto espera a la red para enlazarla. */
  let receiptWaiting = $state(false);

  /** Tipos que acepta la tubería de adjuntos del servidor. */
  const RECEIPT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
  /** Sin tipo declarado (cámaras de Android) decide el servidor por la firma. */
  const RECEIPT_GENERIC_TYPES = ['', 'application/octet-stream'];
  const RECEIPT_MAX_BYTES = 10 * 1024 * 1024;

  function clearReceipt(): void {
    receiptFile = null;
    if (receiptPickInput) receiptPickInput.value = '';
    if (receiptCameraInput) receiptCameraInput.value = '';
  }

  /**
   * Al elegir foto o fichero se prepara YA, no al enviar: así el aviso de «se
   * ha reducido» aparece mientras aún se puede cambiar de idea. El módulo que
   * reduce se carga bajo demanda: quien no adjunta nada no lo descarga.
   */
  async function chooseReceipt(input: HTMLInputElement | null): Promise<void> {
    const chosen = input?.files?.[0];
    if (!chosen) return;
    // Los dos campos comparten una sola selección: el último gana.
    if (input === receiptPickInput && receiptCameraInput) receiptCameraInput.value = '';
    if (input === receiptCameraInput && receiptPickInput) receiptPickInput.value = '';
    receiptBusy = true;
    receiptNotice = null;
    try {
      const prepared = await (await import('$lib/attachments/prepare')).prepareAttachment(chosen);
      receiptFile = prepared.file;
      receiptNotice = prepared.notice;
    } catch {
      receiptFile = chosen;
      receiptNotice = 'No se ha podido comprobar el peso de la foto; se intentará subir tal cual.';
    } finally {
      receiptBusy = false;
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

    // Con red la foto viaja PRIMERO: el comando del gasto referencia el objeto
    // ya confirmado. Si la subida falla (tamaño, tipo, o un 503 sin almacén de
    // documentos configurado) el alta del gasto NO se bloquea: se registra sin
    // justificante y el mensaje explica qué pasó con la foto.
    let receiptStorageObjectId: string | undefined;
    let pendingBlob: OutboxPendingBlob | undefined;
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
    } else if (receiptFile) {
      // Sin conexión: la foto se queda en este dispositivo con su propio
      // identificador y el gasto la espera. Nada de subidas a medias.
      const contentType = receiptFile.type || 'application/octet-stream';
      if (!RECEIPT_TYPES.includes(contentType) && !RECEIPT_GENERIC_TYPES.includes(receiptFile.type)) {
        receiptNotice = 'Ese tipo de fichero no está permitido: usa una foto (JPG, PNG, WebP) o un PDF. El gasto se registra sin justificante.';
      } else if (receiptFile.size > RECEIPT_MAX_BYTES) {
        receiptNotice = 'La foto supera el tamaño máximo (10 MB). El gasto se registra sin justificante.';
      } else {
        const blobId = crypto.randomUUID();
        try {
          await saveOfflineBlob({
            id: blobId,
            householdId,
            contentType,
            size: receiptFile.size,
            createdAt: new Date().toISOString(),
            blob: receiptFile
          });
          pendingBlob = { id: blobId, payloadField: 'receiptStorageObjectId' };
        } catch {
          receiptNotice = 'No se pudo guardar la foto en este dispositivo. El gasto se registra sin justificante.';
        }
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
    receiptWaiting = Boolean(pendingBlob);
    await optimistic.run(
      envelope,
      {
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
          clearReceipt();
          expenseSent = true;
        },
        revert: () => {
          removeDraft();
          expenseSent = false;
          receiptWaiting = false;
        },
        settle: () => {
          removeDraft();
          // El comando salió con la foto ya enlazada: deja de estar esperando.
          receiptWaiting = false;
          if (pendingBlob) receiptAttached = true;
        }
      },
      pendingBlob ? { pendingBlob } : {}
    );
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
            {expense.incurredOnLabel} · pendiente de aprobación{#if expense.hasReceipt}&nbsp;· Justificante adjunto ✓ ·
              <!-- Se puede MIRAR antes de decidir: quien aprueba no tiene que
                   fiarse de que la foto exista, y quien la subió comprueba que
                   salió legible. La ruta valida sesión y pertenencia. -->
              <a
                href={`/api/v1/households/${householdId}/receipts/${expense.id}`}
                target="_blank"
                rel="noopener"
              >Ver el justificante</a>{/if}
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
      <fieldset class="receipt-field">
        <legend>Justificante (opcional)</legend>
        <label>Elegir un fichero o una foto guardada
          <input
            type="file"
            accept="image/*,application/pdf"
            bind:this={receiptPickInput}
            disabled={uploadBusy || receiptBusy}
            onchange={(event) => void chooseReceipt(event.currentTarget)}
          />
        </label>
        <label>Hacer la foto ahora
          <input
            type="file"
            accept="image/*"
            capture="environment"
            bind:this={receiptCameraInput}
            disabled={uploadBusy || receiptBusy}
            onchange={(event) => void chooseReceipt(event.currentTarget)}
          />
        </label>
        <p class="field-hint">
          Si la foto pesa mucho se reduce en este móvil antes de enviarla, para que no se quede a medias
          con datos móviles. El texto del ticket se sigue leyendo.
        </p>
        {#if receiptBusy}<p class="queued-note" role="status">Preparando la foto…</p>{/if}
        {#if receiptFile}
          <p class="queued-note" role="status">
            Adjunto: {receiptFile.name}
            <button class="button secondary small-button" type="button" onclick={clearReceipt}>Quitar</button>
          </p>
        {/if}
      </fieldset>
      {#if !online}
        <p class="queued-note" role="status">Sin conexión: haz la foto igualmente. Se guarda en este dispositivo y se une al gasto en cuanto vuelva la red.</p>
      {/if}
      {#if receiptNotice}<p class="queued-note" role="status">{receiptNotice}</p>{/if}
      {#if expenseError}<p class="queued-note" role="alert">{expenseError}</p>{/if}
      <div class="action-row">
        <!-- También mientras se prepara la foto: si no, el gasto podría salir
             sin el justificante que se está reduciendo en ese momento. -->
        <button class="button primary small-button" type="submit" disabled={uploadBusy || receiptBusy}>Añadir gasto</button>
        {#if expenseSent}
          <span class="status-chip {receiptWaiting ? 'warning' : 'success'}">
            {receiptWaiting
              ? 'Guardado aquí · La foto se unirá al gasto con conexión'
              : receiptAttached
                ? 'Enviado · Justificante adjunto ✓'
                : 'Enviado'}
          </span>
        {/if}
      </div>
    </form>
  {/if}

  <ActionStatus status={actionStatus} />
</article>
