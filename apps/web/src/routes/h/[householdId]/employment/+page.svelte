<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import ExpensesPendingCard from '$lib/components/employment/ExpensesPendingCard.svelte';
  import ExtraWorkPendingCard from '$lib/components/employment/ExtraWorkPendingCard.svelte';
  import OutboxTriageCard from '$lib/components/employment/OutboxTriageCard.svelte';
  import SettlementActions from '$lib/components/employment/SettlementActions.svelte';
  import WeeklyReportCard from '$lib/components/employment/WeeklyReportCard.svelte';
  import { can } from '$lib/auth/capabilities';
  import { useAppContext } from '$lib/auth/context';
  import { openSettlement, queueEmploymentCommand } from '$lib/employment/commands';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const context = useAppContext();

  const overview = $derived(data.overview);

  // Las acciones de escritura solo existen sobre datos reales de Postgres; en
  // modo fixture (demo sin base de datos) la página es de solo lectura.
  const agreement = $derived(overview?.hasEmploymentData ? overview.agreement : null);
  const isOwnAgreement = $derived(
    agreement !== null && agreement.employeeMembershipId === context.user.membershipId
  );

  const canRegisterExtra = $derived(isOwnAgreement && can(context.role, 'work.register.self'));
  // El parte semanal es siempre de la propia empleada: misma capacidad que
  // registrar su trabajo, y solo sobre su propio acuerdo.
  const canSubmitWeek = $derived(canRegisterExtra);
  const canSubmitExpense = $derived(isOwnAgreement && can(context.role, 'expense.create.self'));
  const canConfirmReceipt = $derived(isOwnAgreement && can(context.role, 'payment.confirm.self'));
  const canConfirmWork = $derived(agreement !== null && can(context.role, 'work.confirm'));
  // La exportación del expediente es exclusivamente de la propia empleada y
  // solo existe sobre datos reales de Postgres (mismo gating que las acciones).
  const canDownloadExport = $derived(isOwnAgreement && context.role === 'employee_live_in');
  const canCloseSettlement = $derived(agreement !== null && can(context.role, 'settlement.close'));
  const canRecordPayment = $derived(agreement !== null && can(context.role, 'payment.register'));

  // Jerarquía por rol: quien decide (la familia) ve las tarjetas con
  // decisiones pendientes arriba del expediente; la empleada conserva su orden
  // (parte semanal y proyección primero).
  const pendingFirst = $derived(canConfirmWork || canCloseSettlement);

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

  let openBusy = $state(false);
  let openQueued = $state(false);
  // Vencimiento elegido por la familia: nunca antes del fin del periodo y, por
  // defecto, el propio fin de mes.
  const openPeriodEnd = $derived(openableAccrual ? monthEnd(openableAccrual.period) : '');
  let openDueOn = $state('');
  $effect(() => {
    if (openPeriodEnd && !openDueOn) openDueOn = openPeriodEnd;
  });

  async function openCurrentSettlement(): Promise<void> {
    if (!overview || !agreement || !openableAccrual) return;
    const dueOn = openDueOn && openDueOn >= openPeriodEnd ? openDueOn : openPeriodEnd;
    openBusy = true;
    try {
      const outcome = await queueEmploymentCommand(
        openSettlement({
          householdId: overview.householdId,
          agreementId: agreement.id,
          periodStart: `${openableAccrual.period}-01`,
          periodEnd: openPeriodEnd,
          dueOn
        })
      );
      if (outcome === 'synced') {
        // La liquidación ya existe en el servidor: el overview fresco retira el botón.
        await invalidateAll();
      } else {
        openQueued = true;
      }
    } finally {
      openBusy = false;
    }
  }
</script>

<svelte:head><title>Acuerdos y pagos · Casa Clara</title></svelte:head>

<div class="page-wrap">
  {#snippet actions()}
    {#if openableAccrual && !openQueued}
      <form
        class="open-settlement-form"
        onsubmit={(event) => {
          event.preventDefault();
          void openCurrentSettlement();
        }}
      >
        <label>Vencimiento
          <input type="date" bind:value={openDueOn} min={openPeriodEnd} required />
        </label>
        <button class="button primary" type="submit" disabled={openBusy}>
          Abrir liquidación de {openableAccrual.periodLabel.toLocaleLowerCase('es')}
        </button>
      </form>
    {:else if openQueued}
      <span class="status-chip warning">Apertura pendiente de sincronizar</span>
    {/if}
  {/snippet}
  <PageHeader eyebrow="Expediente laboral" title="Acuerdos y pagos" description="Importes trazables, confirmaciones separadas y un historial claro." {actions} />

  {#if overview}
    {#if !overview.hasEmploymentData}
      <article class="card quiet-card">
        <span class="card-icon" aria-hidden="true">·</span>
        <h2>Sin datos laborales visibles</h2>
        <p>Tu rol no tiene acceso al expediente laboral de este hogar, o todavía no hay un acuerdo registrado.</p>
      </article>
    {:else}
      <section class="summary-strip" aria-label="Resumen del devengo en curso">
        <div><span>Periodo en curso</span><strong>{overview.accrual?.periodLabel ?? '—'}</strong></div>
        <div><span>Total salarial</span><strong>{overview.accrual?.salaryLabel ?? '—'}</strong></div>
        <div><span>Reembolsos</span><strong>{overview.accrual?.reimbursementLabel ?? '—'}</strong></div>
        <div class="total"><span>Transferencia proyectada</span><strong>{overview.accrual?.transferTotalLabel ?? '—'}</strong></div>
      </section>

      <OutboxTriageCard householdId={overview.householdId} />

      {#snippet pendingDecisionCards()}
        {#if agreement && (overview.pendingExtras.length > 0 || canRegisterExtra)}
          <ExtraWorkPendingCard
            householdId={overview.householdId}
            agreementId={agreement.id}
            extras={overview.pendingExtras}
            ownMembershipId={context.user.membershipId}
            canRegister={canRegisterExtra}
            canConfirm={canConfirmWork}
          />
        {/if}

        {#if agreement && (overview.pendingExpenses.length > 0 || canSubmitExpense)}
          <ExpensesPendingCard
            householdId={overview.householdId}
            agreementId={agreement.id}
            expenses={overview.pendingExpenses}
            canSubmit={canSubmitExpense}
            canResolve={canCloseSettlement}
          />
        {/if}
      {/snippet}

      <div class="content-grid employment-grid">
        <div class="stack">
          {#if pendingFirst}{@render pendingDecisionCards()}{/if}

          {#if agreement && canSubmitWeek}
            <WeeklyReportCard
              householdId={overview.householdId}
              agreementId={agreement.id}
              recentReports={overview.recentReports}
              canSubmit={canSubmitWeek}
            />
          {/if}

          <article class="card ledger-card">
            <div class="section-heading">
              <div><p class="eyebrow">Devengo en curso</p><h2>Proyección de {overview.accrual?.periodLabel.toLocaleLowerCase('es') ?? 'este periodo'}</h2></div>
              <span class="status-chip warning">Sin cerrar</span>
            </div>
            {#if overview.accrual}
              <div class="ledger-list">
                {#each overview.accrual.lines as line (line.id)}
                  <div id={line.anchorId ?? undefined}>
                    <span>
                      <strong>{line.concept}</strong>
                      <small>
                        {#if line.href}<a href={line.href}>{line.detail || 'Ver origen'}</a>{:else}{line.detail}{/if}
                      </small>
                    </span>
                    <strong>{line.amountLabel}</strong>
                  </div>
                {/each}
              </div>
              <div class="ledger-total"><span>Total proyectado</span><strong>{overview.accrual.transferTotalLabel}</strong></div>
            {:else}
              <p class="audit-note">No hay una versión del acuerdo vigente en este periodo.</p>
            {/if}
            <p class="audit-note">Cada línea conserva su origen y la regla vigente al cerrar el periodo.</p>
          </article>

          {#if !pendingFirst}{@render pendingDecisionCards()}{/if}

          <article class="card">
            <div class="section-heading">
              <div><p class="eyebrow">Acuerdo</p><h2>Versiones y cambios de salario</h2></div>
              {#if overview.agreement}
                <span class="status-chip {overview.agreement.status === 'active' ? 'success' : 'warning'}">{overview.agreement.status === 'active' ? 'Activo' : 'Finalizado'}</span>
              {/if}
            </div>
            <div class="ledger-list">
              {#each overview.versions as version (version.id)}
                <div id={`version-${version.id}`}>
                  <span>
                    <strong>v{version.versionNumber} · desde el {version.effectiveFromLabel}</strong>
                    <small>{version.reason} · {version.overtimeRateLabel} extra · {version.workedRestDayRateLabel} descanso trabajado</small>
                  </span>
                  <span>
                    <strong>{version.salaryLabel}</strong>
                    <small>
                      {#if version.state === 'vigente'}Vigente{:else if version.state === 'futura'}Entra en vigor{:else}Histórica{/if}
                      {#if version.salaryDiffLabel}&nbsp;· {version.salaryDiffLabel}{/if}
                    </small>
                  </span>
                </div>
              {:else}
                <div><span><strong>Sin versiones visibles</strong><small>Tu rol no puede ver los términos salariales.</small></span></div>
              {/each}
            </div>
          </article>

          <article class="card">
            <div class="section-heading">
              <div><p class="eyebrow">Liquidaciones</p><h2>Historial con pagos y confirmación</h2></div>
            </div>
            {#each overview.settlements as settlement (settlement.id)}
              <div class="section-heading">
                <div><h3>{settlement.periodLabel}</h3></div>
                <span class="status-chip {settlement.fullyPaid && settlement.receiptConfirmed ? 'success' : 'warning'}">{settlement.paymentStateLabel}</span>
              </div>
              <div class="ledger-list">
                {#each settlement.lines as line (line.lineNumber)}
                  <div>
                    <span>
                      <strong>{line.concept}</strong>
                      <small>
                        {#if line.href}<a href={line.href}>{line.occurredOnLabel}</a>{:else}{line.occurredOnLabel}{/if}
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
                  <span><strong>Pagado / pendiente</strong><small>{settlement.statusLabel} · vence el {settlement.dueOn}</small></span>
                  <strong>{settlement.paidLabel} / {settlement.pendingLabel}</strong>
                </div>
              </div>
              <div class="ledger-total"><span>Total transferido</span><strong>{settlement.transferTotalLabel}</strong></div>
              <p class="audit-note">
                {#if settlement.receiptConfirmed}
                  Cobro confirmado por la empleada{settlement.receiptNote ? `: ${settlement.receiptNote}` : '.'}
                {:else}
                  La empleada aún no ha confirmado el cobro.
                {/if}
              </p>
              <SettlementActions
                householdId={overview.householdId}
                {settlement}
                canClose={canCloseSettlement}
                canRecordPayment={canRecordPayment}
                canConfirmReceipt={canConfirmReceipt}
              />
            {:else}
              <p class="audit-note">Todavía no hay liquidaciones cerradas ni abiertas.</p>
            {/each}
          </article>
        </div>

        <aside class="stack">
          <article class="card">
            <p class="eyebrow">Saldos</p><h2>Tiempo y compensación</h2>
            <div class="balance-list">
              {#each overview.balances.compensation as balance (balance.accountId)}
                <div>
                  <span><strong>{balance.typeLabel}</strong><small>{balance.detail}</small></span>
                  <strong>{balance.minutesLabel}</strong>
                </div>
              {/each}
              {#each overview.balances.advances as advance (advance.advanceId)}
                <div id={`anticipo-${advance.advanceId}`}>
                  <span><strong>Anticipo pendiente</strong><small>{advance.detail}</small></span>
                  <strong>{advance.outstandingLabel} de {advance.principalLabel}</strong>
                </div>
              {:else}
                {#if overview.balances.compensation.length === 0}
                  <div><span><strong>Sin saldos</strong><small>No hay créditos ni anticipos visibles.</small></span></div>
                {/if}
              {/each}
            </div>
          </article>
          {#if canDownloadExport}
            <article class="card">
              <p class="eyebrow">Mi expediente</p>
              <h2>Copia completa de tu historial</h2>
              <p>
                Liquidaciones, pagos, jornadas extra, partes semanales, gastos y saldos en CSV, con un
                resumen en PDF. Documento doméstico no oficial.
              </p>
              <a
                class="button secondary"
                href={`/api/v1/households/${overview.householdId}/employment-export`}
                download="mi-expediente.zip"
              >
                Descargar mi expediente (PDF + CSV)
              </a>
            </article>
          {/if}
          <article class="card quiet-card">
            <span class="card-icon" aria-hidden="true">✓</span>
            <h2>Confirmación independiente</h2>
            <p>Registrar una transferencia no confirma por sí solo que la otra parte la haya recibido.</p>
          </article>
        </aside>
      </div>
    {/if}
  {:else if data.employment}
    <section class="summary-strip" aria-label="Resumen de liquidación">
      <div><span>Periodo</span><strong>{data.employment.period}</strong></div>
      <div><span>Total salarial</span><strong>{data.employment.salaryTotal}</strong></div>
      <div><span>Reembolsos</span><strong>{data.employment.reimbursementTotal}</strong></div>
      <div class="total"><span>Total transferencia</span><strong>{data.employment.transferTotal}</strong></div>
    </section>

    <div class="content-grid employment-grid">
      <article class="card ledger-card">
        <div class="section-heading"><div><p class="eyebrow">Liquidación</p><h2>Detalle de {data.employment.period.toLocaleLowerCase('es')}</h2></div><span class="status-chip warning">{data.employment.status}</span></div>
        <div class="ledger-list">
          {#each data.employment.lines as line}
            <div><span><strong>{line.concept}</strong><small>{line.detail}</small></span><strong>{line.amount}</strong></div>
          {/each}
        </div>
        <div class="ledger-total"><span>Total a transferir</span><strong>{data.employment.transferTotal}</strong></div>
        <p class="audit-note">Cada línea conserva su origen y la regla vigente al cerrar el periodo.</p>
      </article>

      <aside class="stack">
        <article class="card">
          <p class="eyebrow">Saldos</p><h2>Tiempo y compensación</h2>
          <div class="balance-list">
            {#each data.employment.balance as item}
              <div><span><strong>{item.label}</strong><small>{item.detail}</small></span><strong>{item.value}</strong></div>
            {/each}
          </div>
        </article>
        <article class="card quiet-card">
          <span class="card-icon" aria-hidden="true">✓</span>
          <h2>Confirmación independiente</h2>
          <p>Registrar una transferencia no confirma por sí solo que la otra parte la haya recibido.</p>
        </article>
      </aside>
    </div>
  {/if}
</div>
