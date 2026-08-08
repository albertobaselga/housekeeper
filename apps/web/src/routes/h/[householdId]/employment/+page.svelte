<script lang="ts">
  import PageHeader from '$lib/components/PageHeader.svelte';
  import ActionStatus from '$lib/components/ActionStatus.svelte';
  import ExpensesPendingCard from '$lib/components/employment/ExpensesPendingCard.svelte';
  import ExtraWorkPendingCard from '$lib/components/employment/ExtraWorkPendingCard.svelte';
  import OutboxTriageCard from '$lib/components/employment/OutboxTriageCard.svelte';
  import SettlementActions from '$lib/components/employment/SettlementActions.svelte';
  import VacationsCard from '$lib/components/employment/VacationsCard.svelte';
  import WeeklyReportCard from '$lib/components/employment/WeeklyReportCard.svelte';
  import { can } from '$lib/auth/capabilities';
  import { useAppContext } from '$lib/auth/context';
  import { OptimisticActions } from '$lib/offline/optimistic';
  import { openSettlement } from '$lib/employment/commands';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const context = useAppContext();

  // Patrón wiki (P2-1): apertura de liquidación optimista con invalidate
  // selectivo ('cc:employment'); las tarjetas hijas llevan su propia instancia.
  const optimistic = new OptimisticActions({ householdId: context.household.id, invalidateToken: 'cc:employment' });
  const actionStatus = optimistic.status;
  $effect(() => optimistic.start());

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
  // Los días los apunta la familia administradora (no hay flujo de solicitud);
  // la empleada ve su saldo y sus periodos sin poder escribir, respaldado por
  // la política `vacation_periods_admin_write`.
  const canRecordVacation = $derived(agreement !== null && can(context.role, 'leave.approve'));

  // P1-6 (revisión UX v3): RLS solo enseña importes (versiones del acuerdo,
  // devengo, liquidaciones, saldos) a quien administra y a la propia empleada.
  // Para el resto (p. ej. un miembro de la familia) esas consultas devuelven
  // cero filas: no es «no hay datos», es «no puedes verlos», y la página debe
  // decir esa verdad en vez de pintar vacíos falsos.
  const seesAmounts = $derived(
    can(context.role, 'settlement.close') || can(context.role, 'payment.confirm.self')
  );

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

  // Chip optimista: la apertura se da por enviada al instante; los datos
  // frescos retiran el formulario (openableAccrual pasa a null) y, si el
  // servidor la rechaza, el formulario vuelve con la causa en la nota.
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

<svelte:head><title>Pagos · Casa Clara</title></svelte:head>

<div class="page-wrap">
  {#snippet actions()}
    {#if openableAccrual && !openSent}
      <form
        class="open-settlement-form"
        onsubmit={(event) => {
          event.preventDefault();
          openCurrentSettlement();
        }}
      >
        <label>Vencimiento
          <input type="date" bind:value={openDueOn} min={openPeriodEnd} required />
        </label>
        <button class="button primary" type="submit">
          Empezar la cuenta de {openableAccrual.periodLabel.toLocaleLowerCase('es')}
        </button>
      </form>
    {:else if openSent}
      <span class="status-chip success">Apertura enviada</span>
    {/if}
  {/snippet}
  <!-- P2-3 (revisión UX v3): un solo nombre para la sección — «Pagos» — con el
       subtítulo «Acuerdo, nómina y gastos» en vez de «Expediente laboral». -->
  <PageHeader eyebrow="Acuerdo, nómina y gastos" title="Pagos" description="Importes claros, confirmaciones separadas y un historial que se entiende." {actions} />

  <ActionStatus status={actionStatus} />

  {#if overview}
    {#if !overview.hasEmploymentData}
      <article class="card quiet-card">
        <span class="card-icon" aria-hidden="true">·</span>
        <h2>Sin acuerdo de trabajo registrado</h2>
        <p>Cuando el hogar registre un acuerdo con la empleada, aquí se verán sus pagos.</p>
      </article>
    {:else}
      {#if seesAmounts}
        <section class="summary-strip" aria-label="Resumen de lo que va sumando este mes">
          <div><span>Mes en curso</span><strong>{overview.accrual?.periodLabel ?? '—'}</strong></div>
          <div><span>Total salarial</span><strong>{overview.accrual?.salaryLabel ?? '—'}</strong></div>
          <div><span>Reembolsos</span><strong>{overview.accrual?.reimbursementLabel ?? '—'}</strong></div>
          <div class="total"><span>Total previsto</span><strong>{overview.accrual?.transferTotalLabel ?? '—'}</strong></div>
        </section>
      {/if}

      <OutboxTriageCard householdId={overview.householdId} />

      {#snippet pendingDecisionCards()}
        {#if agreement && (overview.pendingExtras.length > 0 || canRegisterExtra)}
          <ExtraWorkPendingCard
            householdId={overview.householdId}
            agreementId={agreement.id}
            extras={overview.pendingExtras}
            types={overview.registrableTypes}
            ownMembershipId={context.user.membershipId}
            canRegister={canRegisterExtra}
            canConfirm={canConfirmWork}
          />
        {/if}

        <!-- P3-6: la tarjeta de gastos no desaparece para quien decide cuando
             no hay pendientes; conserva su estado vacío como las demás. -->
        {#if agreement && (overview.pendingExpenses.length > 0 || canSubmitExpense || canCloseSettlement)}
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

          {#if seesAmounts}
            <article class="card ledger-card">
              <div class="section-heading">
                <div><p class="eyebrow">Este mes</p><h2>Lo que va sumando {overview.accrual?.periodLabel.toLocaleLowerCase('es') ?? 'este mes'}</h2></div>
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
                <div class="ledger-total"><span>Total previsto del mes</span><strong>{overview.accrual.transferTotalLabel}</strong></div>
              {:else}
                <p class="audit-note">El acuerdo todavía no está en vigor este mes.</p>
              {/if}
              <p class="audit-note">Cada importe dice de dónde sale y se calcula con la tarifa acordada en la fecha en que se trabajó.</p>
            </article>
          {/if}

          <!-- Vacaciones del año en curso: saldo, lo apuntado y el formulario
               de la familia. Va con el resto del expediente porque quien mira
               «cuántos días quedan» está mirando lo pactado, no la nómina. -->
          {#if agreement && overview.vacations}
            <VacationsCard
              householdId={overview.householdId}
              agreementId={agreement.id}
              vacations={overview.vacations}
              canRecord={canRecordVacation}
            />
          {/if}

          {#if !pendingFirst}{@render pendingDecisionCards()}{/if}

          {#if !seesAmounts}
            <!-- Ausencia por permiso, no por falta de datos: nada de «Todavía
                 no hay liquidaciones» cuando RLS simplemente no las enseña. -->
            <article class="card quiet-card">
              <span class="card-icon" aria-hidden="true">·</span>
              <h2>Importes reservados</h2>
              <p>
                Los importes y las cuentas de cada mes solo los ven quien administra el hogar y la
                empleada. Tú puedes revisar las jornadas y los gastos pendientes de esta página.
              </p>
            </article>
          {/if}

          {#if seesAmounts}
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
                    <!--
                      Los conceptos vienen del catálogo YA filtrado por la RLS:
                      lo que no aplica a quien mira no llegó hasta aquí, así que
                      no hay nada que esconder en la plantilla.
                    -->
                    <small>{version.reason} · {version.vacationDaysLabel} de vacaciones{#each version.concepts as concept (concept.id)}{#if concept.rateLabel} · {concept.name} {concept.rateLabel}{/if}{/each}{#each version.supplements as supplement (supplement.id)}{#if supplement.amountLabel} · {supplement.name} {supplement.amountLabel}{supplement.addsToPay ? '' : ' (lo paga la casa)'}{/if}{/each}</small>
                  </span>
                  <span>
                    <strong>{version.salaryLabel}</strong>
                    <small>
                      {#if version.state === 'vigente'}Vigente{:else if version.state === 'futura'}Entra en vigor{:else}Histórica{/if}
                      {#if version.salaryDiffLabel}&nbsp;· {version.salaryDiffLabel}{/if}
                      {#if version.vacationDiffLabel}&nbsp;· {version.vacationDiffLabel} de vacaciones{/if}
                    </small>
                  </span>
                </div>
              {:else}
                <div><span><strong>Sin versiones visibles</strong><small>Los términos salariales solo los ven quien administra y la empleada.</small></span></div>
              {/each}
            </div>
          </article>

          <article class="card">
            <div class="section-heading">
              <div><p class="eyebrow">Cuentas de cada mes</p><h2>Historial con pagos y confirmación</h2></div>
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
              <!-- P1-8: la fila suma el total adeudado del mes, no lo enviado;
                   «Total transferido» mentía cuando aún no había ningún pago. -->
              <div class="ledger-total"><span>Total a pagar</span><strong>{settlement.transferTotalLabel}</strong></div>
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
              <p class="audit-note">Todavía no hay cuentas de meses empezadas ni cerradas.</p>
            {/each}
          </article>
          {/if}
        </div>

        <aside class="stack">
          {#if seesAmounts}
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
          {/if}
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
          {#if seesAmounts}
            <article class="card quiet-card">
              <span class="card-icon" aria-hidden="true">✓</span>
              <h2>Confirmación independiente</h2>
              <p>Registrar una transferencia no confirma por sí solo que la otra parte la haya recibido.</p>
            </article>
          {/if}
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
        <div class="section-heading"><div><p class="eyebrow">Cuenta del mes</p><h2>Detalle de {data.employment.period.toLocaleLowerCase('es')}</h2></div><span class="status-chip warning">{data.employment.status}</span></div>
        <div class="ledger-list">
          {#each data.employment.lines as line}
            <div><span><strong>{line.concept}</strong><small>{line.detail}</small></span><strong>{line.amount}</strong></div>
          {/each}
        </div>
        <div class="ledger-total"><span>Total a pagar</span><strong>{data.employment.transferTotal}</strong></div>
        <p class="audit-note">Cada importe dice de dónde sale y se calcula con la tarifa acordada en la fecha en que se trabajó.</p>
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
