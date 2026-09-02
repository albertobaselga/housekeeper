<script lang="ts">
  import PageHeader from '$lib/components/PageHeader.svelte';
  import EmploymentPersonBar from '$lib/components/employment/EmploymentPersonBar.svelte';
  import EmploymentTabs from '$lib/components/employment/EmploymentTabs.svelte';
  import VacationCarryoverCard from '$lib/components/employment/VacationCarryoverCard.svelte';
  import VacationsCard from '$lib/components/employment/VacationsCard.svelte';
  import { can } from '$lib/auth/capabilities';
  import { useAppContext } from '$lib/auth/context';
  import { markVacationsSeen } from '$lib/vacations/mark-seen';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const context = useAppContext();

  const overview = $derived(data.overview);
  // Su propio contrato, si lo tiene. Es lo que decide la voz de la pantalla:
  // quien administra lee un historial de otras personas, ella lee el suyo. El
  // orden (la propia primero) ya lo trae el servidor.
  const own = $derived(overview?.people.find((person) => person.own) ?? null);

  // Los días los apunta la familia administradora (política
  // `vacation_periods_admin_write`); con la tarjeta aquí, el saldo, el
  // formulario y el historial comparten pantalla.
  const employmentAgreement = $derived(
    data.employment?.hasEmploymentData ? data.employment.agreement : null
  );
  const canRecordVacation = $derived(
    employmentAgreement !== null && can(context.role, 'leave.approve')
  );
  const canDecideCarryover = $derived(can(context.role, 'leave.approve'));

  // La pestaña es el expediente de UNA persona: con `?empleada=` sólo se pinta
  // la suya (historial y días de años cerrados), porque la barra de arriba dice
  // «Expediente de X» y enseñar debajo a las demás desmentía esa frase. Sin
  // `?empleada=` —la empleada mirando lo suyo, o un enlace viejo— se ve lo que
  // el servidor deja ver, la propia primero.
  const scoped = $derived(
    Boolean(data.empleada) && (overview?.people.some((p) => p.agreementId === data.empleada) ?? false)
  );
  const people = $derived(
    overview
      ? scoped
        ? overview.people.filter((p) => p.agreementId === data.empleada)
        : [...overview.people].sort(
            (a, b) =>
              Number(b.agreementId === data.empleada) - Number(a.agreementId === data.empleada)
          )
      : []
  );
  const carryoverProposals = $derived(
    overview ? (scoped ? overview.carryoverProposals.filter((p) => p.agreementId === data.empleada) : overview.carryoverProposals) : []
  );
  const carryoverDecisions = $derived(
    overview ? (scoped ? overview.carryoverDecisions.filter((d) => d.agreementId === data.empleada) : overview.carryoverDecisions) : []
  );

  /**
   * Dar por vistas las novedades es efecto de MIRAR, no de pulsar nada.
   *
   * Ni un botón «Entendido» ni una X: un aviso que hay que descartar a mano
   * acaba descartándose sin leer, y encima aparece en todas partes. Se marca al
   * llegar aquí, con el instante que esta misma pantalla acaba de enseñar —no
   * con `now()`—, para que unas vacaciones apuntadas mientras la página estaba
   * abierta sigan siendo novedad la próxima vez.
   *
   * Si falla (sin red, servidor caído) no pasa nada visible: el aviso seguirá
   * en Hoy, que es el comportamiento correcto cuando no consta que lo haya
   * visto.
   */
  $effect(() => {
    const current = overview;
    if (!current || current.news === null) return;
    void markVacationsSeen(current.householdId, current.news.seenThrough);
  });
</script>

<!-- Sin <svelte:head><title>: el único <title> de la aplicación lo pinta el
     +layout.svelte de la raíz, y la etiqueta de esta ruta está declarada en
     `$lib/app-title` («employment/vacaciones»). Dos <title> darían dos
     elementos, y el que había aquí anunciaba además el nombre del PROYECTO en
     vez del de la casa que se está mirando. -->
<div class="page-wrap">
  <PageHeader
    eyebrow="Contrato"
    title={own ? 'Mis vacaciones' : 'Vacaciones'}
    description={own
      ? 'Los días que has disfrutado, los que están por venir y los que te quedan.'
      : 'El historial de cada persona, año a año, con lo anulado a la vista.'}
  />

  <!-- La barra de persona aparece SIEMPRE que haya un contrato en pantalla, no
       sólo con dos o más: la portada de Contrato existe también en la casa de
       una sola empleada, y sin esta barra no había vuelta a ella. -->
  {#if data.employment && employmentAgreement}
    <EmploymentPersonBar
      householdId={data.householdId}
      employeeLabel={data.employment.agreements.find((option) => option.id === employmentAgreement?.id)?.employeeLabel ?? 'la empleada'}
      active={data.employment.agreements.find((option) => option.id === employmentAgreement?.id)?.active ?? true}
    />
  {/if}

  <EmploymentTabs householdId={data.householdId} current="vacaciones" empleada={data.empleada} />

  {#if !overview}
    <article class="card">
      <p>
        Las vacaciones se leen del contrato real del hogar. Si administras y ves esto,
        es que este entorno no tiene base de datos conectada.
      </p>
    </article>
  {:else if overview.people.length === 0}
    <article class="card quiet-card">
      <span class="card-icon" aria-hidden="true">·</span>
      <h2>Sin contrato registrado</h2>
      <p>Cuando el hogar registre un contrato, aquí se verán los días de vacaciones.</p>
    </article>
  {:else}
    {#if overview.news}
      <!-- El aviso también aquí, y no solo en Hoy: quien llega por el enlace
           tiene que ver qué es lo nuevo, no buscarlo entre lo de siempre.
           Desaparece solo la próxima vez, sin nada que descartar. -->
      <p class="vacation-news" role="status">
        {overview.news.headline}{overview.news.detail ? ` ${overview.news.detail}` : ''}
      </p>
    {/if}

    <!-- La tarjeta de abajo ESCRIBE sobre la persona que dice la barra fija de
         arriba: apuntar días nunca cae en silencio sobre otra. Cambiar de
         persona se hace en la portada de Contrato. -->
    <!-- El año en curso, encima del historial: el saldo para cualquiera que
         pueda leerlo y el formulario de apuntar/anular solo para quien
         administra (la empleada lo ve en solo lectura, como siempre). La
         persona es la elegida arriba y el saldo se refresca solo al apuntar. -->
    {#if employmentAgreement && data.employment?.vacations}
      <VacationsCard
        householdId={data.householdId}
        agreementId={employmentAgreement.id}
        vacations={data.employment.vacations}
        canRecord={canRecordVacation}
        allYearsLink={false}
      />
    {/if}

    <!-- Los años ya cerrados con días sin disfrutar: lo que todavía hay que
         decidir, arriba del historial de lo que ya pasó. -->
    <VacationCarryoverCard
      householdId={data.householdId}
      today={overview.today}
      proposals={carryoverProposals}
      decisions={carryoverDecisions}
      canDecide={canDecideCarryover}
      showPerson={!scoped && overview.people.length > 1}
    />

    {#each people as person (person.agreementId)}
      <article class="card">
        <div class="section-heading">
          <div>
            <p class="eyebrow">{person.own ? 'Tu contrato' : person.employeeLabel}</p>
            <h2>{person.own ? 'Año a año' : `Vacaciones de ${person.employeeLabel}`}</h2>
          </div>
          <span class="status-chip success">{person.agreementRangeLabel}</span>
        </div>

        <!-- Ausencia por permiso, no por falta de datos: a la familia no
             administradora la RLS le enseña los días apuntados pero no los
             términos, y decirlo es más honesto que pintar un derecho de cero. -->
        {#if person.entitlementNote}
          <p class="audit-note">{person.entitlementNote}</p>
        {/if}

        {#each person.years as year (year.index)}
          <section class="vacation-year">
            <h3>{year.label}{year.current ? ' · en curso' : ''}</h3>
            <p class="vacation-headline">{year.headline}</p>
            <!-- «Cuántos le tocan este año» y «cuántos lleva ganados a día de
                 hoy» son dos cifras distintas y las dos son ciertas. La segunda
                 es la que se pregunta quien está a mitad de año decidiendo si
                 puede dar unos días, y lleva SIEMPRE la fecha: sin ella el
                 número no significa nada. -->
            {#if year.accruedNote}
              <p class="audit-note">{year.accruedNote}</p>
            {/if}
            <!-- Disfrutar días por adelantado es normal y legítimo —se dan en
                 agosto aunque el año de contrato acabe en marzo—, así que se
                 dice como lo que es y sólo cuando ocurre. No es una alarma. -->
            {#if year.advanceNote}
              <p class="audit-note">{year.advanceNote}</p>
            {/if}
            {#if year.excessNote}
              <p class="audit-note" role="status">{year.excessNote}</p>
            {/if}
            {#if year.prorationNote}
              <p class="audit-note">{year.prorationNote}</p>
            {/if}
            <div class="ledger-list">
              {#each year.periods as period (period.id)}
                <div id={`vacaciones-${period.id}`} class:period-voided={period.state === 'voided'}>
                  <span>
                    <strong>{period.rangeLabel}</strong>
                    <small>
                      {period.detail}{period.splitLabel ? ` · ${period.splitLabel}` : ''}
                    </small>
                  </span>
                  <span class="inline-actions">
                    <span class="status-chip {period.state === 'voided' ? 'warning' : 'success'}">
                      {period.stateLabel}
                    </span>
                    <strong>{period.daysLabel}</strong>
                  </span>
                </div>
              {:else}
                <div>
                  <span>
                    <strong>Sin días apuntados</strong>
                    <small>No consta ningún periodo de vacaciones en este año de contrato.</small>
                  </span>
                </div>
              {/each}
            </div>
          </section>
        {/each}

        <p class="card-footnote">
          Aquí consta lo que se ha apuntado en la aplicación. Los días se cuentan naturales:
          festivos y fines de semana incluidos, del 1 al 15 son 15 días.
        </p>
      </article>
    {/each}

    {#if own}
      <article class="card quiet-card">
        <span class="card-icon" aria-hidden="true">·</span>
        <h2>Quién apunta estos días</h2>
        <p>
          Los apunta la familia después de hablarlo contigo; aquí no hay ninguna solicitud
          que mandar ni ninguna respuesta que esperar. Si algo no cuadra, díselo: un periodo
          mal apuntado no se borra, se anula con su motivo y se apunta el bueno, y las dos
          cosas se quedan a la vista en esta página.
        </p>
      </article>
    {/if}
  {/if}
</div>

<style>
  .vacation-news {
    margin-bottom: var(--space-4);
    border-radius: var(--r-md);
    background: var(--success-soft);
    padding: var(--space-3) var(--space-3);
    color: var(--success);
    font-size: var(--text-meta);
    font-weight: 700;
  }
  .vacation-year {
    margin-top: var(--space-5);
  }
  .vacation-year h3 {
    font-size: var(--text-body);
    letter-spacing: 0.02em;
  }
  .vacation-headline {
    margin: var(--space-1) 0 0;
    font-size: var(--text-body);
  }
  /* Lo anulado se lee como anulado: sigue estando, sin fingir que cuenta. */
  .period-voided strong:first-child {
    text-decoration: line-through;
  }
  .period-voided {
    opacity: 0.75;
  }
</style>
