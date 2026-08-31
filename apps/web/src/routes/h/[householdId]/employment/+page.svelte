<script lang="ts">
  import PageHeader from '$lib/components/PageHeader.svelte';
  import EmploymentTabs from '$lib/components/employment/EmploymentTabs.svelte';
  import OutboxTriageCard from '$lib/components/employment/OutboxTriageCard.svelte';
  import { can } from '$lib/auth/capabilities';
  import { useAppContext } from '$lib/auth/context';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const context = useAppContext();

  // El Resumen ya no escribe nada por sí mismo: registrar y decidir viven en
  // Conceptos y abrir la cuenta en Pagos, así que aquí no hay acciones
  // optimistas que orquestar. El triaje del outbox se gobierna solo.
  const overview = $derived(data.overview);

  // Las acciones de escritura solo existen sobre datos reales de Postgres; en
  // modo fixture (demo sin base de datos) la página es de solo lectura.
  const agreement = $derived(overview?.hasEmploymentData ? overview.agreement : null);
  const isOwnAgreement = $derived(
    agreement !== null && agreement.employeeMembershipId === context.membershipId
  );

  // La exportación del expediente es exclusivamente de la propia empleada y
  // solo existe sobre datos reales de Postgres (mismo gating que las acciones).
  const canDownloadExport = $derived(isOwnAgreement && context.role === 'employee_live_in');

  // P1-6 (revisión UX v3): RLS solo enseña importes (versiones del acuerdo,
  // devengo, liquidaciones, saldos) a quien administra y a la propia empleada.
  // Para el resto (p. ej. un miembro de la familia) esas consultas devuelven
  // cero filas: no es «no hay datos», es «no puedes verlos», y la página debe
  // decir esa verdad en vez de pintar vacíos falsos.
  const seesAmounts = $derived(
    can(context.role, 'settlement.close') || can(context.role, 'payment.confirm.self')
  );

  // El enlace a Conceptos conserva a la persona elegida, como las pestañas, y
  // con el MISMO escapado: tres productores de la misma URL no pueden
  // discrepar en cómo la escriben.
  const conceptosHref = $derived(
    overview
      ? `/h/${overview.householdId}/employment/conceptos${agreement ? `?empleada=${encodeURIComponent(agreement.id)}` : ''}`
      : ''
  );
  const lastSettlement = $derived(overview?.settlements[0] ?? null);
</script>

<div class="page-wrap">
  <!-- Un solo nombre para la sección, ahora «Contrato» por decisión del
       propietario. Sigue valiendo la regla de P2-3 (revisión UX v3): un nombre,
       el mismo en la barra lateral, en la hoja «Más» y aquí. El h1 dice además
       de qué mes se está hablando, que es lo que se ha venido a mirar. -->
  <PageHeader
    eyebrow="Condiciones, nómina y gastos"
    title={overview?.accrual ? `Contrato · ${overview.accrual.periodLabel.toLocaleLowerCase('es')}` : 'Contrato'}
    description="Importes claros, confirmaciones separadas y un historial que se entiende."
  />

  <EmploymentTabs
    householdId={context.household.id}
    current="resumen"
    empleada={agreement?.id ?? null}
  />

  {#if overview}
    {#if !overview.hasEmploymentData}
      <article class="card quiet-card">
        <span class="card-icon" aria-hidden="true">·</span>
        <h2>Sin contrato de trabajo registrado</h2>
        <p>Cuando el hogar registre un contrato con la empleada, aquí se verán sus condiciones y sus pagos.</p>
      </article>
    {:else}
      {#if seesAmounts}
        <!-- Antes esta tira entregaba CUATRO números, tres de ellos el mismo:
             cuando no hay reembolsos, «total salarial» y «total previsto» son
             literalmente la misma cifra, y «1.430,00 €» aparecía tres veces en
             la pantalla. Se borra lo repetido ANTES de maquetarlo: apilar mejor
             un dato que sobra no arregla nada. Lo que queda es una cifra grande
             con su desglose debajo, y la tira baja de 315 px a ~110. -->
        {@const withReimbursements = (overview.accrual?.reimbursementCents ?? '0') !== '0'}
        <!-- La lista principal de esta pantalla son las cifras del mes: el hallazgo
             de la auditoría fue que a 320 px la primera pantalla no contenía
             NINGUNA cifra —título, subtítulo, un campo de fecha y un botón—.
             Ahora son lo primero que hay debajo del titular. -->
        <section class="summary-strip" class:dos={!withReimbursements} data-lista="principal" aria-label="Resumen de lo que va sumando este mes">
          <div><span>Mes en curso</span><strong>{overview.accrual?.periodLabel ?? '—'}</strong></div>
          {#if withReimbursements}
            <div><span>Salario</span><strong>{overview.accrual?.salaryLabel ?? '—'}</strong></div>
            <div><span>Reembolsos</span><strong>{overview.accrual?.reimbursementLabel ?? '—'}</strong></div>
          {/if}
          <div class="total"><span>Total previsto</span><strong>{overview.accrual?.transferTotalLabel ?? '—'}</strong></div>
        </section>
      {/if}

      <!-- Un hogar puede emplear a varias personas a la vez. Cuando así es,
           quien administra elige de quién es el expediente que mira; la
           elección viaja en la URL para poder volver a ella. A la empleada la
           RLS solo le devuelve su acuerdo, así que no ve ningún selector. -->
      {#if overview.agreements.length > 1}
        <!-- Un nombre completo por chip no cabe dos veces en 320 px: la tira va en
             scroller con máscara y un chip siempre cortado a la mitad, que dice
             que hay más sin gastar una segunda línea de marco. -->
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

      <!-- Lo que espera una decisión vive en Conceptos; el Resumen solo lo
           cuenta. Así el mes y sus cifras no comparten pantalla con
           formularios, y quien decide llega en un toque. -->
      {#if overview.pendingExtras.length > 0 || overview.pendingExpenses.length > 0}
        <article class="card">
          <div class="section-heading">
            <div><p class="eyebrow">Por decidir</p><h2>Lo que espera en Conceptos</h2></div>
          </div>
          <div class="ledger-list">
            {#if overview.pendingExtras.length > 0}
              <div>
                <span>
                  <strong>{overview.pendingExtras.length === 1 ? 'Una jornada extra' : `${overview.pendingExtras.length} jornadas extra`}</strong>
                  <small>Registradas y sin resolver del todo.</small>
                </span>
                <a class="button secondary small-button" href={conceptosHref}>Ir a Conceptos</a>
              </div>
            {/if}
            {#if overview.pendingExpenses.length > 0}
              <div>
                <span>
                  <strong>{overview.pendingExpenses.length === 1 ? 'Un gasto' : `${overview.pendingExpenses.length} gastos`}</strong>
                  <small>Presentados y sin decidir.</small>
                </span>
                <a class="button secondary small-button" href={conceptosHref}>Ir a Conceptos</a>
              </div>
            {/if}
          </div>
        </article>
      {/if}

      <div class="content-grid employment-grid">
        <div class="stack">
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
                          <!-- Una jornada que apuntó la familia lo dice también
                               aquí, ya valorada con la tarifa congelada. -->
                          {#if line.originLabel}&nbsp;· {line.originLabel}{/if}
                        </small>
                      </span>
                      <strong class="cifra pequena">{line.amountLabel}</strong>
                    </div>
                  {/each}
                </div>
                <div class="ledger-total"><span>Total previsto del mes</span><strong>{overview.accrual.transferTotalLabel}</strong></div>
                <!-- Debajo del total, nunca dentro: lo que la casa paga por su
                     cuenta consta como condición y no se transfiere. Meterlo
                     entre las líneas haría que la cuenta mintiera. -->
                {#if overview.accrual.householdPaidSupplements.length > 0}
                  <p class="audit-note">
                    Además, la casa paga aparte:
                    {#each overview.accrual.householdPaidSupplements as supplement, index (supplement.id)}{index > 0 ? ', ' : ''}{supplement.label} ({supplement.amountLabel}){/each}. No entra en la transferencia.
                  </p>
                {/if}
                <!-- Mismo criterio: conceptos apuntados a mano que constan sin
                     mover la transferencia. Debajo del total y nunca dentro,
                     porque sumarlos haría que la cuenta mintiera. -->
                {#if overview.accrual.notedAdjustments.length > 0}
                  <p class="audit-note">
                    También consta, sin cambiar la transferencia:
                    {#each overview.accrual.notedAdjustments as noted, index (noted.id)}{index > 0 ? ', ' : ''}{noted.label} ({noted.amountLabel}, {noted.reason}){/each}.
                  </p>
                {/if}
              {:else}
                <p class="audit-note">El contrato todavía no está en vigor este mes.</p>
              {/if}
              <p class="audit-note">Cada importe dice de dónde sale y se calcula con la tarifa acordada en la fecha en que se trabajó.</p>
            </article>

            <!-- La última cuenta, en una línea: el historial entero, con sus
                 pagos y su documento, vive en la pestaña Pagos. -->
            {#if lastSettlement}
              <article class="card">
                <div class="section-heading">
                  <div><p class="eyebrow">Última cuenta</p><h2>{lastSettlement.periodLabel}</h2></div>
                  <span class="status-chip {lastSettlement.fullyPaid && lastSettlement.receiptConfirmed ? 'success' : 'warning'}">{lastSettlement.paymentStateLabel}</span>
                </div>
                <div class="action-row">
                  <a class="button secondary small-button" href={`/h/${overview.householdId}/employment/pagos${agreement ? `?empleada=${encodeURIComponent(agreement.id)}` : ''}`}>Ver los pagos</a>
                </div>
              </article>
            {/if}
          {/if}

          {#if !seesAmounts}
            <!-- Ausencia por permiso, no por falta de datos: nada de «Todavía
                 no hay liquidaciones» cuando RLS simplemente no las enseña. -->
            <article class="card quiet-card">
              <span class="card-icon" aria-hidden="true">·</span>
              <h2>Importes reservados</h2>
              <p>
                Los importes y las cuentas de cada mes solo los ven quien administra el hogar y la
                empleada. Tú puedes revisar las jornadas y los gastos pendientes en
                <a href={conceptosHref}>Conceptos</a>.
              </p>
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
