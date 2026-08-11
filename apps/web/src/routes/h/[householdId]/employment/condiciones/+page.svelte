<script lang="ts">
  import PageHeader from '$lib/components/PageHeader.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const terms = $derived(data.terms);
</script>

<!-- Era la ÚNICA de las trece rutas del hogar cuyo h1 empezaba en x=0 en vez
     de x=18, y al no tener relleno inferior su última línea —«45,00 € al mes»,
     el seguro médico de la interna— quedaba 38 px por debajo de la barra
     inferior, sin scroll que la sacara, a 390 y a 320 px. Dos líneas. -->
<div class="page-wrap">
  <PageHeader
    eyebrow="Contrato"
    title="Mis condiciones"
    description="Lo que está pactado ahora mismo, tal y como se aplica a tu pago."
  />

  {#if !terms}
    <article class="card">
      <p>
        Todavía no hay condiciones que enseñarte aquí. Aparecerán en cuanto la familia
        dé de alta el contrato.
      </p>
    </article>
  {:else}
    <article class="card">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Vigente desde el {terms.effectiveFromLabel}</p>
          <h2>Lo básico</h2>
        </div>
        <span class="status-chip success">Versión {terms.versionNumber}</span>
      </div>
      <div class="ledger-list">
        <div>
          <span><strong>Salario al mes</strong><small>Lo que se transfiere cada mes por tu jornada pactada.</small></span>
          <span><strong>{terms.salaryLabel}</strong></span>
        </div>
        <div>
          <span><strong>Jornada</strong></span>
          <span><strong>{terms.weeklyHoursLabel}</strong></span>
        </div>
        <div>
          <span>
            <strong>Vacaciones</strong>
            <!-- Lo pactado es un número; los días que de verdad ha disfrutado son
                 otra pantalla, y desde aquí es donde se buscan. -->
            <small><a href={`/h/${data.householdId}/employment/vacaciones`}>Ver mis vacaciones</a></small>
          </span>
          <span><strong>{terms.vacationDaysLabel}</strong></span>
        </div>
      </div>
    </article>

    <!--
      «Si aplica», literal: sin horario pactado no hay fila en Postgres, `terms.schedule`
      llega como null y aquí no se pinta ni una sección vacía ni un hueco con guiones.
      La sección sencillamente no está.
    -->
    {#if terms.schedule}
      <article class="card" data-testid="mi-horario">
        <div class="section-heading">
          <div><p class="eyebrow">Horario</p><h2>Tu jornada</h2></div>
          <span class="status-chip success">{terms.schedule.weeklyLabel}</span>
        </div>
        <!-- Lo primero y en grande: la frase. El resto es el detalle para quien
             quiera comprobarlo día a día. -->
        <p class="schedule-sentence">{terms.schedule.sentence}</p>
        {#if terms.schedule.note}
          <p>{terms.schedule.note}</p>
        {/if}
        <div class="ledger-list">
          {#each terms.schedule.days as day (day.weekday)}
            <div>
              <span>
                <strong>{day.weekdayLabel}</strong>
                <small>{day.detailLabel}</small>
              </span>
              <span><strong>{day.effectiveLabel}</strong></span>
            </div>
          {/each}
        </div>
        <!--
          Si el horario y la jornada contratada del mismo contrato se contradicen,
          se le dice a ella también. Es su tiempo: enterarse por la aplicación es
          mejor que no enterarse.
        -->
        {#if terms.schedule.mismatchLabel}
          <p class="audit-note" role="status">
            ⚠ {terms.schedule.mismatchLabel} Coméntalo con quien administra el hogar: una de
            las dos condiciones tiene que cambiar, y cambiarla crea una versión nueva.
          </p>
        {:else}
          <p class="audit-note">
            Las horas de este horario cuadran con la jornada de {terms.weeklyHoursLabel} que
            dice tu contrato.
          </p>
        {/if}
      </article>
    {/if}

    <article class="card">
      <div class="section-heading">
        <div><p class="eyebrow">Trabajo extra</p><h2>Qué puedes hacer y a cuánto se paga</h2></div>
      </div>
      <!--
        La lista viene de la RLS, no de un filtro de plantilla: lo que no te
        aplica no llegó hasta aquí. Si está vacía es que ahora mismo el contrato no
        contempla trabajo extra, y decirlo así es más honesto que no decir nada.
      -->
      {#if terms.extraWorkTypes.length === 0}
        <p>Tu contrato no contempla trabajo extra por ahora.</p>
      {:else}
        <div class="ledger-list">
          {#each terms.extraWorkTypes as type (type.id)}
            <div>
              <span>
                <strong>{type.name}</strong>
                <small>
                  Se paga {type.unitLabel}{type.referenceLabel ? ` · ${type.referenceLabel}` : ''}
                </small>
              </span>
              <span><strong>{type.rateLabel}</strong></span>
            </div>
          {/each}
        </div>
      {/if}
    </article>

    {#if terms.paidSupplements.length > 0 || terms.householdPaidSupplements.length > 0}
      <article class="card">
        <div class="section-heading">
          <div><p class="eyebrow">Complementos</p><h2>Lo que se suma y lo que paga la casa</h2></div>
        </div>
        <div class="ledger-list">
          {#each terms.paidSupplements as supplement (supplement.id)}
            <div>
              <span>
                <strong>{supplement.name}</strong>
                <small>Se suma a tu transferencia{supplement.validityLabel ? ` · ${supplement.validityLabel}` : ''}</small>
              </span>
              <span><strong>{supplement.amountLabel}</strong></span>
            </div>
          {/each}
          {#each terms.householdPaidSupplements as supplement (supplement.id)}
            <div>
              <span>
                <strong>{supplement.name}</strong>
                <small>
                  Lo paga la casa por su cuenta: consta como condición tuya, pero no
                  viaja en la transferencia{supplement.validityLabel ? ` · ${supplement.validityLabel}` : ''}.
                </small>
              </span>
              <span><strong>{supplement.amountLabel}</strong></span>
            </div>
          {/each}
        </div>
      </article>
    {/if}
  {/if}
</div>

<style>
  /* La frase del horario es lo primero que se lee y lo único imprescindible:
     el detalle día a día va debajo, en el cuerpo de siempre. */
  .schedule-sentence {
    font-size: var(--text-strong);
    font-weight: 500;
    line-height: var(--lh-base);
  }
</style>
