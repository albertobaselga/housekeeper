<script lang="ts">
  import PageHeader from '$lib/components/PageHeader.svelte';
  import ActionStatus from '$lib/components/ActionStatus.svelte';
  import EmploymentPersonBar from '$lib/components/employment/EmploymentPersonBar.svelte';
  import EmploymentTabs from '$lib/components/employment/EmploymentTabs.svelte';
  import OutboxTriageCard from '$lib/components/employment/OutboxTriageCard.svelte';
  import SettlementActions from '$lib/components/employment/SettlementActions.svelte';
  import { can } from '$lib/auth/capabilities';
  import { useAppContext } from '$lib/auth/context';
  import { OptimisticActions } from '$lib/offline/optimistic';
  import { openSettlement } from '$lib/employment/commands';
  import {
    anclaDeMesEnFragmento,
    aperturaExplicacion,
    buildPagoMesRows
  } from '$lib/employment/pagos';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const context = useAppContext();

  const optimistic = new OptimisticActions({ householdId: context.household.id, invalidateToken: 'cc:employment' });
  const actionStatus = optimistic.status;
  $effect(() => optimistic.start());

  const overview = $derived(data.overview);
  const agreement = $derived(overview?.hasEmploymentData ? overview.agreement : null);
  const selectedOption = $derived(
    overview?.agreements.find((option) => option.id === agreement?.id) ?? null
  );
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

  // Una fila por mes, plegada. Las frases y la forma de la fila viven en
  // `pagos.ts`; aquí solo se pintan.
  const mesRows = $derived(
    overview
      ? buildPagoMesRows({ householdId: overview.householdId, settlements: overview.settlements })
      : []
  );

  // El Resumen enlaza el origen de un importe ya aplicado a `#cuenta-<id>`, y
  // ese ancla cae dentro de un `<details>` plegado: el navegador salta a la
  // fila y lo que se venía a ver sigue escondido. `:target` no despliega un
  // `<details>`, así que se despliega aquí, una vez, al llegar.
  $effect(() => {
    const anchor = anclaDeMesEnFragmento(window.location.hash);
    if (!anchor) return;
    const summary = document.getElementById(anchor);
    if (!summary) return;
    summary.closest('details')?.setAttribute('open', '');
    summary.scrollIntoView({ block: 'start' });
  });

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

  <!-- El mismo predicado que decide la portada, no el recuento de acuerdos: la
       portada ya existe siempre, y contar filas dejaba a la casa de una sola
       empleada con estas cuentas y ningún camino de vuelta a ella. -->
  {#if overview && context.role !== 'employee_live_in' && selectedOption}
    <EmploymentPersonBar
      householdId={overview.householdId}
      employeeLabel={selectedOption.employeeLabel}
      active={selectedOption.active}
    />
  {/if}

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
    <!-- De quién es lo dice la barra de arriba; cambiar de persona se hace en
         la portada de Contrato. -->
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
      <!-- Empezar la cuenta es el primer acto del historial: crea el borrador
           del mes y lo pone aquí abajo como una fila más. Va plegado y en peso
           secundario porque la fila que nace no se puede borrar jamás. -->
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
            <p class="field-hint">{aperturaExplicacion(openableAccrual.periodLabel)}</p>
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
        <!-- Aquí había un pie explicando el ciclo de una cuenta —se empieza, se
             cierra, se paga—. Medía 96 px a 320, empujaba la primera fila fuera
             de la primera pantalla y decía tres veces lo que ya dicen, cada una
             en su sitio, la frase de empezar la cuenta, la de cerrar el mes y la
             de registrar el pago. Que la fila se pulsa lo dice su subrayado.

             El plegado es LIBRE, no un acordeón: sin `name` se pueden tener dos
             meses abiertos a la vez, que es lo que se hace al comparar una
             discrepancia entre dos cuentas. -->
        <div class="fila-lista" data-lista="principal">
          {#each mesRows as row (row.id)}
            <div class="mes-fila">
              <details class="mes">
                <summary class="fila-accion" id={row.anchorId}>
                  <strong class="mes-nombre">{row.periodLabel}</strong>
                  <strong class="cifra pequena">{row.amountLabel}</strong>
                  <span class="mes-estado">
                    <span class="status-chip {row.chipTone}">{row.chipLabel}</span>
                    <!-- Un mes que no tiene nada que añadir a su distintivo no
                         deja ni el hueco: el <small> no llega a existir. -->
                    {#if row.supportLine}<small>{row.supportLine}</small>{/if}
                  </span>
                </summary>
                <div class="ledger-list">
                  {#each row.settlement.lines as line (line.lineNumber)}
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
                      <strong class="cifra pequena">{line.amountLabel}</strong>
                    </div>
                  {/each}
                  {#each row.settlement.payments as payment (payment.id)}
                    <div>
                      <span>
                        <strong>Pago · {payment.methodLabel}</strong>
                        <small>{payment.valueOnLabel}{payment.reference ? ` · ${payment.reference}` : ''}</small>
                      </span>
                      <strong class="cifra pequena">{payment.amountLabel}</strong>
                    </div>
                  {/each}
                  <!-- El total ya está en la fila cerrada; aquí solo se reparte
                       entre lo pagado y lo que queda. Una fila cada uno: las
                       dos cifras juntas en la misma no caben a 320 px y
                       aplastaban su propio rótulo. -->
                  <div>
                    <span><strong>Pagado</strong></span>
                    <strong class="cifra pequena">{row.settlement.paidLabel}</strong>
                  </div>
                  <div>
                    <span><strong>Pendiente</strong></span>
                    <strong class="cifra pequena">{row.settlement.pendingLabel}</strong>
                  </div>
                </div>
                {#if row.receiptNote}
                  <p class="audit-note">Al confirmar el cobro, la empleada anotó: {row.receiptNote}</p>
                {/if}
                <SettlementActions
                  householdId={overview.householdId}
                  settlement={row.settlement}
                  canClose={canCloseSettlement}
                  canRecordPayment={canRecordPayment}
                  canConfirmReceipt={canConfirmReceipt}
                />
              </details>
              <!-- El documento de pago se descarga SIN desplegar el mes: por eso
                   el enlace vive fuera del `<summary>`, que si no se disputaría
                   el dedo con el plegado. En la fila solo cabe «PDF»; el nombre
                   entero va en el `aria-label`. El nombre del fichero lo pone el
                   servidor (content-disposition) y el atributo va sin valor para
                   no prometer otro. Quien no debe verlo no ve este enlace, y el
                   servidor responde 404 igualmente. -->
              {#if row.documentHref}
                <a
                  class="button secondary small-button"
                  href={row.documentHref}
                  aria-label={row.documentLabel}
                  download
                >PDF</a>
              {/if}
            </div>
          {:else}
            <p class="audit-note">Todavía no hay cuentas de meses empezadas ni cerradas.</p>
          {/each}
        </div>
      </article>
    {/if}
  {/if}
</div>

<style>
  /* LA FILA DE UN MES.
     El mes ocupa el ancho y el enlace del documento vive FUERA del `<details>`:
     un enlace dentro del `<summary>` se disputa el dedo con el plegado, y la
     descarga tiene que poder hacerse sin desplegar nada. */
  .mes-fila {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: start;
    gap: var(--space-3);
    border-top: 1px solid var(--line);
  }
  .mes-fila:first-child { border-top: 0; }
  .mes-fila > details { min-width: 0; }
  /* El documento se descarga desde la fila cerrada, así que el botón va a la
     altura del mes, no centrado en la fila entera: centrado, al desplegar el
     detalle se quedaba flotando a media lista de líneas. */
  .mes-fila > a { align-self: start; margin-top: var(--space-2); }
  /* La diana de 56 px y la rejilla las pone `.fila-accion`; el borde superior
     lo pone la fila entera, que abarca también el enlace del documento. */
  .mes-fila summary {
    border-top: 0;
    cursor: pointer;
    touch-action: manipulation;
  }
  /* El mes se pulsa, y hay que verlo sin gastar un icono: el mismo subrayado
     punteado que ya distingue el título de una rutina desplegable. */
  .mes-nombre {
    text-decoration-line: underline;
    text-decoration-style: dotted;
    text-underline-offset: .25rem;
  }
  /* El estado se lleva su propia línea. A 320 px un chip de «Pagada · cobro sin
     confirmar» y el importe no caben en la misma sin aplastar el nombre del
     mes, y el importe es el que no se puede mover. */
  .mes-estado {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-1) var(--space-2);
    min-width: 0;
    grid-column: 1 / -1;
  }
  .mes[open] > summary { border-bottom: 1px solid var(--line); }
  /* El tono de «esto ya está y no pide nada», que la casa aún no tenía: el mes
     cerrado en el que no hubo nada que transferir. Mismo apagado que el
     distintivo de los términos de la Guía; ni ámbar, que anunciaría una deuda
     inexistente, ni verde, que celebraría un cobro que nadie hizo. */
  .status-chip.neutral {
    border: 1px solid var(--line);
    background: var(--surface);
    color: var(--ink-soft);
  }
</style>
