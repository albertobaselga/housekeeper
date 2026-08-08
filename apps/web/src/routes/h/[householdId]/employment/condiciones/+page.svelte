<script lang="ts">
  import PageHeader from '$lib/components/PageHeader.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const terms = $derived(data.terms);
</script>

<svelte:head><title>Mis condiciones · Casa Clara</title></svelte:head>

<PageHeader
  eyebrow="Acuerdo"
  title="Mis condiciones"
  description="Lo que está pactado ahora mismo, tal y como se aplica a tu pago."
/>

{#if !terms}
  <article class="card">
    <p>
      Todavía no hay condiciones que enseñarte aquí. Aparecerán en cuanto la familia
      dé de alta el acuerdo.
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
        <span><strong>Vacaciones</strong></span>
        <span><strong>{terms.vacationDaysLabel}</strong></span>
      </div>
    </div>
  </article>

  <article class="card">
    <div class="section-heading">
      <div><p class="eyebrow">Trabajo extra</p><h2>Qué puedes hacer y a cuánto se paga</h2></div>
    </div>
    <!--
      La lista viene de la RLS, no de un filtro de plantilla: lo que no te
      aplica no llegó hasta aquí. Si está vacía es que ahora mismo el acuerdo no
      contempla trabajo extra, y decirlo así es más honesto que no decir nada.
    -->
    {#if terms.extraWorkTypes.length === 0}
      <p>Tu acuerdo no contempla trabajo extra por ahora.</p>
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
