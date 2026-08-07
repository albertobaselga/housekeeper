<script module lang="ts">
  type PaymentMethod = 'bank_transfer' | 'cash' | 'bizum' | 'mixed' | 'other';

  // Último método usado en esta sesión (estado local básico compartido entre
  // liquidaciones): el siguiente pago lo propone como default.
  let lastPaymentMethod: PaymentMethod = 'bank_transfer';
</script>

<script lang="ts">
  import ActionStatus from '$lib/components/ActionStatus.svelte';
  import { OptimisticActions } from '$lib/offline/optimistic';
  import {
    closeSettlement,
    confirmReceipt,
    parseEuroInput,
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

  // Patrón wiki (P2-1): el chip de resultado se pinta ANTES de que el comando
  // viaje; `invalidate('cc:employment')` selectivo tras el ACK refresca la
  // liquidación y retira el estado optimista; rejected/conflict lo revierte y
  // el formulario vuelve con la causa traducida en la nota.
  // svelte-ignore state_referenced_locally -- el hogar no cambia dentro de la página
  const optimistic = new OptimisticActions({ householdId, invalidateToken: 'cc:employment' });
  const actionStatus = optimistic.status;
  $effect(() => optimistic.start());

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

  function run(envelope: Parameters<typeof optimistic.run>[0], action: string): void {
    void optimistic.run(envelope, {
      // El chip sustituye al formulario al instante: sin `busy` de tarjeta.
      apply: () => {
        sent = action;
      },
      revert: () => {
        sent = null;
      },
      settle: () => {
        // La vista fresca de la liquidación decide qué acciones quedan.
        sent = null;
      }
    });
  }

  function submitPayment(event: SubmitEvent): void {
    event.preventDefault();
    const amountCents = parseEuroInput(paymentAmount);
    if (!amountCents || !paymentDate) {
      paymentError = 'Importe inválido: usa un número positivo, p. ej. 725,00';
      return;
    }
    paymentError = null;
    lastPaymentMethod = paymentMethod;
    run(
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
            onclick={() => run(closeSettlement({ householdId, settlementId: settlement.id }), 'close')}
          >Cerrar liquidación</button>
          <small>El servidor materializa las líneas desde los hechos y congela los totales.</small>
        </div>
      {/if}
    {/if}

    {#if showPayment}
      {#if sent === 'payment'}
        <div class="action-row"><span class="status-chip success">Pago enviado</span></div>
      {:else}
        <form onsubmit={submitPayment}>
          <h3>Registrar pago</h3>
          <div class="form-grid">
            <label>Importe (€)
              <input type="text" inputmode="decimal" autocomplete="off" enterkeyhint="next" bind:value={paymentAmount} required />
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
            <button class="button primary small-button" type="submit">Registrar pago</button>
            <button class="button secondary small-button" type="button" onclick={fillFullPending}>
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
            run(confirmReceipt({ householdId, settlementId: settlement.id, note: receiptNote }), 'receipt');
          }}
        >
          <h3>Confirmar cobro</h3>
          <label>Nota (opcional)
            <input type="text" autocomplete="off" enterkeyhint="done" bind:value={receiptNote} maxlength="500" placeholder="Recibido completo" />
          </label>
          <div class="action-row">
            <button class="button primary small-button" type="submit">Confirmar cobro</button>
            <small>Tu confirmación queda registrada aparte del pago de la familia.</small>
          </div>
        </form>
      {/if}
    {/if}

    <ActionStatus status={actionStatus} />
  </div>
{/if}
