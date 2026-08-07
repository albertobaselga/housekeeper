<script module lang="ts">
  type PaymentMethod = 'bank_transfer' | 'cash' | 'bizum' | 'mixed' | 'other';

  // Último método usado en esta sesión (estado local básico compartido entre
  // liquidaciones): el siguiente pago lo propone como default.
  let lastPaymentMethod: PaymentMethod = 'bank_transfer';
</script>

<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import {
    closeSettlement,
    confirmReceipt,
    parseEuroInput,
    queueEmploymentCommand,
    recordPayment
  } from '$lib/employment/commands';
  import { centsToEuroInput, type SettlementView } from '$lib/employment/model';

  let {
    householdId,
    settlement,
    canClose,
    canRecordPayment,
    canConfirmReceipt
  }: {
    householdId: string;
    settlement: SettlementView;
    canClose: boolean;
    canRecordPayment: boolean;
    canConfirmReceipt: boolean;
  } = $props();

  let busy = $state(false);
  let queued = $state(false);
  let sent = $state<string | null>(null);

  // Defaults que la app ya conoce: importe prellenado con el pendiente (el
  // caso dominante es «pagar todo»), fecha valor hoy y el último método usado.
  let paymentAmount = $state('');
  let paymentMethod = $state<PaymentMethod>(lastPaymentMethod);
  let paymentDate = $state(new Date().toISOString().slice(0, 10));
  let paymentError = $state<string | null>(null);

  // Prellena el importe con el pendiente y, tras un pago parcial, vuelve a
  // proponer el nuevo resto sin machacar lo que el usuario teclee entre medias.
  let knownPendingCents: string | null = null;
  $effect(() => {
    if (settlement.pendingCents !== knownPendingCents) {
      knownPendingCents = settlement.pendingCents;
      paymentAmount = centsToEuroInput(settlement.pendingCents);
    }
  });

  let receiptNote = $state('');

  const showClose = $derived(canClose && settlement.status === 'open');
  const showPayment = $derived(
    canRecordPayment && settlement.status === 'closed' && BigInt(settlement.pendingCents) > 0n
  );
  const showConfirmReceipt = $derived(
    canConfirmReceipt &&
      settlement.status === 'closed' &&
      settlement.fullyPaid &&
      !settlement.receiptConfirmed
  );

  async function run(envelope: Parameters<typeof queueEmploymentCommand>[0], action: string): Promise<void> {
    busy = true;
    try {
      const outcome = await queueEmploymentCommand(envelope);
      queued = outcome === 'queued';
      if (outcome === 'synced') {
        // El servidor ya lo aplicó: la vista fresca de la liquidación manda.
        await invalidateAll();
        sent = null;
      } else {
        sent = action;
      }
    } finally {
      busy = false;
    }
  }

  async function submitPayment(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const amountCents = parseEuroInput(paymentAmount);
    if (!amountCents || !paymentDate) {
      paymentError = 'Importe inválido: usa un número positivo, p. ej. 725,00';
      return;
    }
    paymentError = null;
    lastPaymentMethod = paymentMethod;
    await run(
      recordPayment({
        householdId,
        settlementId: settlement.id,
        amountCents,
        method: paymentMethod,
        valueOn: paymentDate
      }),
      'payment'
    );
  }

  function fillFullPending(): void {
    paymentAmount = centsToEuroInput(settlement.pendingCents);
    paymentError = null;
  }
</script>

{#if showClose || showPayment || showConfirmReceipt}
  <div class="action-form">
    {#if showClose}
      {#if sent === 'close'}
        <div class="action-row"><span class="status-chip success">Cierre enviado</span></div>
      {:else}
        <div class="action-row">
          <button
            class="button primary small-button"
            type="button"
            disabled={busy}
            onclick={() => void run(closeSettlement({ householdId, settlementId: settlement.id }), 'close')}
          >Cerrar liquidación</button>
          <small>El servidor materializa las líneas desde los hechos y congela los totales.</small>
        </div>
      {/if}
    {/if}

    {#if showPayment}
      {#if sent === 'payment'}
        <div class="action-row"><span class="status-chip success">Pago enviado</span></div>
      {:else}
        <form onsubmit={(event) => void submitPayment(event)}>
          <h3>Registrar pago</h3>
          <div class="form-grid">
            <label>Importe (€)
              <input type="text" inputmode="decimal" bind:value={paymentAmount} required />
            </label>
            <label>Método
              <select bind:value={paymentMethod}>
                <option value="bank_transfer">Transferencia</option>
                <option value="cash">Efectivo</option>
                <option value="bizum">Bizum</option>
                <option value="mixed">Mixto</option>
                <option value="other">Otro</option>
              </select>
            </label>
            <label>Fecha valor
              <input type="date" bind:value={paymentDate} required />
            </label>
          </div>
          {#if paymentError}<p class="queued-note" role="alert">{paymentError}</p>{/if}
          <div class="action-row">
            <button class="button primary small-button" type="submit" disabled={busy}>Registrar pago</button>
            <button class="button secondary small-button" type="button" disabled={busy} onclick={fillFullPending}>
              Pagar todo ({settlement.pendingLabel})
            </button>
            <small>Pendiente actual: {settlement.pendingLabel}</small>
          </div>
        </form>
      {/if}
    {/if}

    {#if showConfirmReceipt}
      {#if sent === 'receipt'}
        <div class="action-row"><span class="status-chip success">Confirmación enviada</span></div>
      {:else}
        <form
          onsubmit={(event) => {
            event.preventDefault();
            void run(
              confirmReceipt({ householdId, settlementId: settlement.id, note: receiptNote }),
              'receipt'
            );
          }}
        >
          <h3>Confirmar cobro</h3>
          <label>Nota (opcional)
            <input type="text" bind:value={receiptNote} maxlength="500" placeholder="Recibido completo" />
          </label>
          <div class="action-row">
            <button class="button primary small-button" type="submit" disabled={busy}>Confirmar cobro</button>
            <small>Tu confirmación queda registrada aparte del pago de la familia.</small>
          </div>
        </form>
      {/if}
    {/if}

    {#if queued}
      <p class="queued-note" role="status">Guardado en este dispositivo; se sincronizará al recuperar la conexión.</p>
    {/if}
  </div>
{/if}
