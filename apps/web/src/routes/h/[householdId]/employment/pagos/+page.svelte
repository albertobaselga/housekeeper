<script lang="ts">
  import PageHeader from '$lib/components/PageHeader.svelte';
  import ActionStatus from '$lib/components/ActionStatus.svelte';
  import EmploymentTabs from '$lib/components/employment/EmploymentTabs.svelte';
  import OutboxTriageCard from '$lib/components/employment/OutboxTriageCard.svelte';
  import SettlementActions from '$lib/components/employment/SettlementActions.svelte';
  import { can } from '$lib/auth/capabilities';
  import { useAppContext } from '$lib/auth/context';
  import { OptimisticActions } from '$lib/offline/optimistic';
  import { openSettlement } from '$lib/employment/commands';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const context = useAppContext();

  const optimistic = new OptimisticActions({ householdId: context.household.id, invalidateToken: 'cc:employment' });
  const actionStatus = optimistic.status;
  $effect(() => optimistic.start());

  const overview = $derived(data.overview);
  const agreement = $derived(overview?.hasEmploymentData ? overview.agreement : null);
  const isOwnAgreement = $derived(
    agreement !== null && agreement.employeeMembershipId === context.membershipId
  );

  const canConfirmReceipt = $derived(isOwnAgreement && can(context.role, 'payment.confirm.self'));
  const canCloseSettlement = $derived(agreement !== null && can(context.role, 'settlement.close'));
  const canRecordPayment = $derived(agreement !== null && can(context.role, 'payment.register'));

  // La misma verdad que en el resumen: las cuentas y sus importes solo los ven
  // quien administra y la propia empleada.
  const seesAmounts = $derived(
    can(context.role, 'settlement.close') || can(context.role, 'payment.confirm.self')
  );

  function monthEnd(period: string): string {
    const [year, month] = period.split('-').map(Number);
    const lastDay = new Date(Date.UTC(year!, month!, 0)).getUTCDate();
    return `${period}-${String(lastDay).padStart(2, '0')}`;
  }

  const openableAccrual = $derived(
    overview?.hasEmploymentData &&
      canCloseSettlement &&
      overview.accrual !== null &&
      !overview.settlements.some(
        (settlement) => settlement.periodStart.slice(0, 7) === overview.accrual!.period
      )
      ? overview.accrual
      : null
  );

  // Chip optimista: la apertura se da por enviada al instante; los datos
  // frescos retiran el formulario y, si el servidor la rechaza, el formulario
  // vuelve con la causa en la nota.
  let openSent = $state(false);
  // Vencimiento elegido por la familia: nunca antes del fin del periodo y, por
  // defecto, el propio fin de mes.
  const openPeriodEnd = $derived(openableAccrual ? monthEnd(openableAccrual.period) : '');
  let openDueOn = $state('');
  $effect(() => {
    if (openPeriodEnd && !openDueOn) openDueOn = openPeriodEnd;
  });

  function openCurrentSettlement(): void {
    if (!overview || !agreement || !openableAccrual || openSent) return;
    const dueOn = openDueOn && openDueOn >= openPeriodEnd ? openDueOn : openPeriodEnd;
    void optimistic.run(
      openSettlement({
        householdId: overview.householdId,
        agreementId: agreement.id,
        periodStart: `${openableAccrual.period}-01`,
        periodEnd: openPeriodEnd,
        dueOn
      }),
      {
        apply: () => {
          openSent = true;
        },
        revert: () => {
          openSent = false;
        },
        settle: () => {
          openSent = false;
        }
      }
    );
  }
</script>

<div class="page-wrap">
  <PageHeader
    eyebrow="Contrato"
    title="Pagos"
    description="Las cuentas de cada mes: qué se pagó, qué falta y su documento."
  />

  <EmploymentTabs
    householdId={context.household.id}
    current="pagos"
    empleada={agreement?.id ?? null}
  />

  <ActionStatus status={actionStatus} />

  {#if !overview}
    <article class="card">
      <p>
        Los pagos se leen del contrato real del hogar. Si administras y ves esto,
        es que este entorno no tiene base de datos conectada.
      </p>
    </article>
  {:else if !overview.hasEmploymentData}
    <article class="card quiet-card">
      <span class="card-icon" aria-hidden="true">·</span>
      <h2>Sin contrato de trabajo registrado</h2>
      <p>Cuando el hogar registre un contrato con la empleada, aquí se verán sus pagos.</p>
    </article>
  {:else}
    {#if overview.agreements.length > 1}
      <nav class="chip-strip scroller" aria-label="Elegir de quién es el expediente">
        {#each overview.agreements as option (option.id)}
          <a
            class="chip {option.id === agreement?.id ? 'active' : ''}"
            href={`?empleada=${option.id}`}
            aria-current={option.id === agreement?.id ? 'page' : undefined}
            data-sveltekit-noscroll
          >{option.employeeLabel}{option.active ? '' : ' (acuerdo terminado)'}</a>
        {/each}
      </nav>
    {/if}

    <OutboxTriageCard householdId={overview.householdId} />

    {#if !seesAmounts}
      <article class="card quiet-card">
        <span class="card-icon" aria-hidden="true">·</span>
        <h2>Importes reservados</h2>
        <p>
          Las cuentas de cada mes y sus pagos solo los ven quien administra el hogar y la
          empleada.
        </p>
      </article>
    {:else}
      <!-- Empezar la cuenta es el primer acto del historial: en cuanto se abre,
           el mes deja de sumar solo y aparece aquí abajo como una cuenta más. -->
      {#if openableAccrual && !openSent}
        <details class="card open-settlement">
          <summary>Empezar la cuenta de {openableAccrual.periodLabel.toLocaleLowerCase('es')}</summary>
          <form
            class="open-settlement-form"
            onsubmit={(event) => {
              event.preventDefault();
              openCurrentSettlement();
            }}
          >
            <label>¿Cuándo vence el pago?
              <input type="date" bind:value={openDueOn} min={openPeriodEnd} required />
            </label>
            <p class="field-hint">
              Al empezar la cuenta, {openableAccrual.periodLabel.toLocaleLowerCase('es')} se cierra a
              revisión y deja de sumar solo.
            </p>
            <div class="action-row">
              <button class="button secondary" type="submit">
                Empezar la cuenta de {openableAccrual.periodLabel.toLocaleLowerCase('es')}
              </button>
            </div>
          </form>
        </details>
      {:else if openSent}
        <p class="note success" role="status">Apertura enviada</p>
      {/if}

      <article class="card">
        <div class="section-heading">
          <div><p class="eyebrow">Cuentas de cada mes</p><h2>Historial con pagos y confirmación</h2></div>
        </div>
        {#each overview.settlements as settlement (settlement.id)}
          <div class="section-heading">
            <div><h3>{settlement.periodLabel}</h3></div>
            <span class="status-chip {settlement.fullyPaid && settlement.receiptConfirmed ? 'success' : 'warning'}">{settlement.paymentStateLabel}</span>
          </div>
          <div class="ledger-list" data-lista={settlement.id === overview.settlements[0]?.id ? 'principal' : undefined}>
            {#each settlement.lines as line (line.lineNumber)}
              <div>
                <span>
                  <strong>{line.concept}</strong>
                  <small>
                    {#if line.href}<a href={line.href}>{line.occurredOnLabel}</a>{:else}{line.occurredOnLabel}{/if}
                    {#if line.receiptExpenseId}
                      ·
                      <a
                        href={`/api/v1/households/${context.household.id}/receipts/${line.receiptExpenseId}`}
                        target="_blank"
                        rel="noopener"
                      >Ver el justificante</a>
                    {/if}
                  </small>
                </span>
                <strong>{line.amountLabel}</strong>
              </div>
            {/each}
            {#each settlement.payments as payment (payment.id)}
              <div>
                <span>
                  <strong>Pago · {payment.methodLabel}</strong>
                  <small>{payment.valueOnLabel}{payment.reference ? ` · ${payment.reference}` : ''}</small>
                </span>
                <strong>{payment.amountLabel}</strong>
              </div>
            {/each}
            <div>
              <span><strong>Pagado / pendiente</strong><small>{settlement.statusLabel} · vence el {settlement.dueOnLabel}</small></span>
              <strong>{settlement.paidLabel} / {settlement.pendingLabel}</strong>
            </div>
          </div>
          <div class="ledger-total"><span>Total a pagar</span><strong>{settlement.transferTotalLabel}</strong></div>
          <p class="audit-note">
            {#if settlement.receiptConfirmed}
              Cobro confirmado por la empleada{settlement.receiptNote ? `: ${settlement.receiptNote}` : '.'}
            {:else}
              La empleada aún no ha confirmado el cobro.
            {/if}
          </p>
          <!-- El documento de pago con todos los conceptos, generado al momento
               con los mismos datos que esta tarjeta. Solo para cuentas ya
               cerradas: la abierta aún no tiene líneas congeladas y su
               documento no diría ningún importe. El nombre del fichero lo pone
               el servidor (content-disposition); el atributo va sin valor para
               no prometer otro. Quien no debe verlo no ve este enlace, y el
               servidor responde 404 igualmente. -->
          {#if settlement.status !== 'open'}
            <div class="action-row">
              <a
                class="button secondary small-button"
                href={`/api/v1/households/${overview.householdId}/settlements/${settlement.id}/documento`}
                download
              >Descargar el documento de pago (PDF)</a>
            </div>
          {/if}
          <SettlementActions
            householdId={overview.householdId}
            {settlement}
            canClose={canCloseSettlement}
            canRecordPayment={canRecordPayment}
            canConfirmReceipt={canConfirmReceipt}
          />
        {:else}
          <p class="audit-note">Todavía no hay cuentas de meses empezadas ni cerradas.</p>
        {/each}
      </article>
    {/if}
  {/if}
</div>
