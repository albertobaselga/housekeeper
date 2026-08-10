<script lang="ts">
  import PageHeader from '$lib/components/PageHeader.svelte';
  import { markVacationsSeen } from '$lib/vacations/mark-seen';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const overview = $derived(data.overview);
  // Su propio contrato, si lo tiene. Es lo que decide la voz de la pantalla:
  // quien administra lee un historial de otras personas, ella lee el suyo. El
  // orden (la propia primero) ya lo trae el servidor.
  const own = $derived(overview?.people.find((person) => person.own) ?? null);

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

<svelte:head><title>Vacaciones · Casa Clara</title></svelte:head>

<div class="page-wrap">
  <PageHeader
    eyebrow="Contrato"
    title={own ? 'Mis vacaciones' : 'Vacaciones'}
    description={own
      ? 'Los días que has disfrutado, los que están por venir y los que te quedan.'
      : 'El historial de cada persona, año a año, con lo anulado a la vista.'}
  />

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

    {#each overview.people as person (person.agreementId)}
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

        {#each person.years as year (year.year)}
          <section class="vacation-year">
            <h3>{year.year}{year.current ? ' · este año' : ''}</h3>
            <p class="vacation-headline">{year.headline}</p>
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
                    <strong>Sin días apuntados en {year.year}</strong>
                    <small>No consta ningún periodo de vacaciones ese año.</small>
                  </span>
                </div>
              {/each}
            </div>
          </section>
        {/each}

        <p class="card-footnote">
          Aquí consta lo que se ha apuntado en Casa Clara. Los días se cuentan naturales:
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
    margin-bottom: 1rem;
    border-radius: 0.65rem;
    background: var(--success-soft);
    padding: 0.65rem 0.8rem;
    color: var(--success);
    font-size: 0.85rem;
    font-weight: 700;
  }
  .vacation-year {
    margin-top: 1.6rem;
  }
  .vacation-year h3 {
    font-size: 0.9rem;
    letter-spacing: 0.02em;
  }
  .vacation-headline {
    margin: 0.35rem 0 0;
    font-size: 0.95rem;
  }
  /* Lo anulado se lee como anulado: sigue estando, sin fingir que cuenta. */
  .period-voided strong:first-child {
    text-decoration: line-through;
  }
  .period-voided {
    opacity: 0.75;
  }
</style>
