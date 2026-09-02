<script lang="ts">
  import PageHeader from '$lib/components/PageHeader.svelte';
  import EmploymentPersonBar from '$lib/components/employment/EmploymentPersonBar.svelte';
  import EmploymentTabs from '$lib/components/employment/EmploymentTabs.svelte';
  import OutboxTriageCard from '$lib/components/employment/OutboxTriageCard.svelte';
  import { can } from '$lib/auth/capabilities';
  import { useAppContext } from '$lib/auth/context';
  import { employmentTabHref, lastMeaningfulSettlement, parseCents } from '$lib/employment/model';
  import { closedWithNothingToPay } from '$lib/employment/pagos';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const context = useAppContext();

  // El Resumen ya no escribe nada por sí mismo: registrar y decidir viven en
  // Conceptos y abrir la cuenta en Pagos, así que aquí no hay acciones
  // optimistas que orquestar. El triaje del outbox se gobierna solo.
  const portada = $derived(data.portada);
  const overview = $derived(data.overview);

  // Las acciones de escritura solo existen sobre datos reales de Postgres; en
  // modo fixture (demo sin base de datos) la página es de solo lectura.
  const agreement = $derived(overview?.hasEmploymentData ? overview.agreement : null);
  const selectedOption = $derived(
    overview?.agreements.find((option) => option.id === agreement?.id) ?? null
  );
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

  // Los destinos los escribe el constructor único de `model.ts`: la persona
  // elegida viaja siempre, y siempre escapada igual. Escribir la cadena a mano
  // en cada sitio era la vía por la que un enlace acababa en el expediente de
  // otra persona.
  const conceptosHref = $derived(
    overview ? employmentTabHref(overview.householdId, 'conceptos', agreement?.id) : ''
  );

  // La regla vive en el modelo, donde se puede probar: la que había aquí no
  // saltaba las cuentas mudas, paraba en ellas, y abrir la cuenta del mes
  // apagaba el aviso de una deuda vencida.
  const lastSettlement = $derived(lastMeaningfulSettlement(overview?.settlements ?? []));
</script>

<div class="page-wrap">
  <!-- Un solo nombre para la sección, ahora «Contrato» por decisión del
       propietario. Sigue valiendo la regla de P2-3 (revisión UX v3): un nombre,
       el mismo en la barra lateral, en la hoja «Más» y aquí. El h1 dice además
       de qué mes se está hablando, que es lo que se ha venido a mirar. -->
  {#if portada}
    <!-- La portada del hogar: primero se elige a la persona. Sin barra de
         pestañas —las pestañas son del expediente de una— y con la cuenta
         total de la casa arriba, que es la pregunta que se viene a mirar. -->
    <PageHeader
      eyebrow="Condiciones, nómina y gastos"
      title={`Contrato · ${portada.periodLabel.toLocaleLowerCase('es')}`}
      description="La cuenta de la casa este mes y el expediente de cada persona empleada."
    />

    {#if portada.seesAmounts}
      <!-- La celda destacada es lo que se DEBE, no lo que va sumando. Son dos
           preguntas distintas y sólo una es una obligación: el devengo del mes
           en curso es una previsión de un mes que aún no ha terminado. Sin
           deuda la celda dice «Al día», nunca «0,00 €»: un cero se lee como una
           cifra y esto es la ausencia de cifra. -->
      <section class="summary-strip dos" aria-label="La cuenta de la casa este mes">
        <div><span>Va sumando este mes</span><strong>{portada.totalLabel}</strong></div>
        <div class="total">
          <span>Pendiente de pago</span>
          <strong>{portada.owedTotalLabel ?? 'Al día'}</strong>
        </div>
      </section>
    {:else}
      <!-- Ausencia por permiso, no por falta de datos: la RLS no enseña
           importes a quien no administra ni es la empleada. -->
      <article class="card quiet-card">
        <span class="card-icon" aria-hidden="true">·</span>
        <h2>Importes reservados</h2>
        <p>
          Los importes de cada contrato solo los ven quien administra el hogar y cada
          empleada. Puedes abrir cada expediente y revisar lo pendiente.
        </p>
      </article>
    {/if}

    <article class="card">
      <div class="section-heading">
        <div><p class="eyebrow">Personas empleadas</p><h2>El expediente de cada una</h2></div>
      </div>
      {#if portada.employees.length === 0}
        <p class="audit-note">
          Todavía no trabaja nadie en esta casa. En cuanto se dé de alta a alguien con su
          contrato, aparecerá aquí con su expediente.
        </p>
      {:else}
        <div class="ledger-list" data-lista="principal">
          {#each portada.employees as employee (employee.agreementId)}
            <div>
              <span>
                <strong>{employee.employeeLabel}{employee.active ? '' : ' (acuerdo terminado)'}</strong>
                {#if portada.seesAmounts}
                  <!-- Primero la deuda, que es la pregunta que trae aquí; el
                       devengo del mes va después y nunca se suma con ella. -->
                  <small>
                    {#if employee.owedLabel}
                      Le debes {employee.owedLabel}{employee.owedDueLabel ? ` · ${employee.owedDueLabel}` : ''}
                    {:else}
                      Al día
                    {/if}
                    &nbsp;·
                    {#if employee.monthTotalLabel}
                      este mes va sumando {employee.monthTotalLabel}
                    {:else}
                      su contrato no está en vigor este mes
                    {/if}
                    &nbsp;· {employee.pendingLabel}
                  </small>
                {:else}
                  <small>Importes reservados&nbsp;· {employee.pendingLabel}</small>
                {/if}
              </span>
              <span class="inline-actions">
                {#if employee.owedLabel}
                  <strong class="cifra pequena">{employee.owedLabel}</strong>
                  <span class="status-chip warning">{employee.overdue ? 'Vencida' : 'Por pagar'}</span>
                {/if}
                <a
                  class="button secondary small-button"
                  href={employmentTabHref(context.household.id, 'resumen', employee.agreementId)}
                >Abrir su expediente</a>
                {#if employee.owedLabel}
                  <a
                    class="button secondary small-button"
                    href={employmentTabHref(context.household.id, 'pagos', employee.agreementId)}
                  >Registrar pago</a>
                {/if}
              </span>
            </div>
          {/each}
        </div>
      {/if}
    </article>

    <!-- Tiene acceso y no tiene contrato en vigor. Pactar el primer contrato de
         alguien que ya está en la casa NO es dar de alta a una persona, y la
         línea dice cuál de las dos historias es: volver a la casa y llegar por
         primera vez no se deciden igual. -->
    {#if portada.candidates.length > 0}
      <article class="card">
        <div class="section-heading">
          <div><p class="eyebrow">Sin contrato</p><h2>Ya están en la casa y falta pactarlo</h2></div>
        </div>
        <div class="ledger-list">
          {#each portada.candidates as candidate (candidate.membershipId)}
            <div>
              <span><strong>{candidate.name}</strong><small>{candidate.detailLabel}</small></span>
              <a
                class="button secondary small-button"
                href={`/h/${context.household.id}/employment/alta?persona=${encodeURIComponent(candidate.membershipId)}`}
              >Pactar su contrato</a>
            </div>
          {/each}
        </div>
      </article>
    {/if}

    <!-- El alta vive aquí y en ningún otro sitio. La raíz de la sección sólo
         exige `settlement.read`, así que la portada también la ven la familia no
         administradora y la empleada: sin esta llave no se ofrece un camino
         imposible. -->
    {#if can(context.role, 'access.manage')}
      <article class="card">
        <div class="section-heading">
          <div><p class="eyebrow">Personal</p><h2>Añadir una persona a la casa</h2></div>
        </div>
        <p>Primero sus datos y su acceso; después, sus condiciones.</p>
        <div class="action-row">
          <a class="button primary" href={`/h/${context.household.id}/employment/alta`}>
            Añadir una persona
          </a>
        </div>
      </article>
    {/if}
  {:else}
  <PageHeader
    eyebrow="Condiciones, nómina y gastos"
    title={overview?.accrual ? `Contrato · ${overview.accrual.periodLabel.toLocaleLowerCase('es')}` : 'Contrato'}
    description="Importes claros, confirmaciones separadas y un historial que se entiende."
  />

  <!-- El mismo predicado que decide la portada, no el recuento de acuerdos: si
       aquí siguiera contando filas, en la casa de una sola persona la portada
       existiría y ninguna pestaña ofrecería el camino de vuelta a ella. -->
  {#if overview && context.role !== 'employee_live_in' && selectedOption}
    <EmploymentPersonBar
      householdId={overview.householdId}
      employeeLabel={selectedOption.employeeLabel}
      active={selectedOption.active}
    />
  {/if}

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

      <!-- De quién es el expediente lo dice la barra de arriba: la elección se
           hace en la portada del hogar, no aquí. -->
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
              <!-- Un mes cerrado sin nada que transferir no es una deuda a cero:
                   es un mes resuelto. El mismo predicado que usa la pestaña
                   Pagos, no otro escrito aquí: con dos, un día dirían cosas
                   distintas del mismo mes. Antes esta tarjeta se contradecía
                   tres veces a la vez —distintivo ámbar «Pendiente de pago»,
                   texto «Pagada» y una cifra de 0,00 €—. -->
              {@const nadaQuePagar = closedWithNothingToPay(lastSettlement)}
              {@const pendiente = !nadaQuePagar && parseCents(lastSettlement.pendingCents) > 0n}
              <article class="card">
                <div class="section-heading">
                  <div><p class="eyebrow">Última cuenta</p><h2>{lastSettlement.periodLabel}</h2></div>
                  {#if nadaQuePagar}
                    <!-- Ni ámbar (aquí no espera nada) ni verde (no hubo cobro
                         que celebrar): el distintivo neutro dice lo que pasó. -->
                    <span class="status-chip">Cerrada · nada que pagar</span>
                  {:else}
                    <span class="status-chip {lastSettlement.fullyPaid && lastSettlement.receiptConfirmed ? 'success' : 'warning'}">{lastSettlement.paymentStateLabel}</span>
                  {/if}
                </div>
                <!-- Con su cifra: quien mira la última cuenta quiere saber
                     cuánto queda por pagar o, si ya se pagó, de quién es la
                     pelota. El estado a secas no contesta ninguna de las dos. -->
                <div class="ledger-list">
                  <div>
                    <span>
                      <strong>{nadaQuePagar ? 'Cerrada' : pendiente ? 'Queda por pagar' : 'Pagada'}</strong>
                      <small>
                        {#if nadaQuePagar}
                          No hubo nada que transferir este mes: todo quedó compensado. La cuenta
                          está cerrada y no espera a nadie.
                        {:else if pendiente}
                          De {lastSettlement.transferTotalLabel} · vence el {lastSettlement.dueOnLabel}
                        {:else if lastSettlement.receiptConfirmed}
                          Cobro confirmado: la cuenta queda cerrada del todo.
                        {:else if isOwnAgreement}
                          Falta que confirmes el cobro. Se hace en Pagos.
                        {:else}
                          Falta que ella confirme el cobro, que lo hace por su cuenta. De tu parte
                          no queda nada.
                        {/if}
                      </small>
                    </span>
                    <!-- Sin cifra cuando no hubo nada que transferir: un
                         «0,00 €» se lee como un importe, y aquí no hubo ninguno. -->
                    {#if !nadaQuePagar}
                      <strong class="cifra pequena">
                        {pendiente ? lastSettlement.pendingLabel : lastSettlement.transferTotalLabel}
                      </strong>
                    {/if}
                  </div>
                </div>
                <div class="action-row">
                  <a
                    class="button secondary small-button"
                    href={employmentTabHref(
                      overview.householdId,
                      'pagos',
                      agreement?.id,
                      `cuenta-${lastSettlement.id}`
                    )}
                  >Ver los pagos</a>
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
          <!-- Aquí vivía «Confirmación independiente»: el rótulo que quedó
               huérfano cuando se borró su botón, enunciando una regla en
               abstracto y ocupando un tercio de la columna. Lo que explicaba se
               dice ahora donde se actúa —junto al formulario de pago, en
               Pagos— y sobre una cuenta concreta, no sobre la idea de una. -->
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
      </aside>
    </div>
  {/if}
  {/if}
</div>
