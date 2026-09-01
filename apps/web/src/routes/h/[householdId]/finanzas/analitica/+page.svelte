<script lang="ts">
  import PageHeader from '$lib/components/PageHeader.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<div class="page-wrap">
  <PageHeader eyebrow="Finanzas" title="Analítica" />
  <section class="empty-state">
    <span aria-hidden="true">€</span>
    {#if data.status.transactionCount === 0}
      <h2>Aún no hay datos de finanzas</h2>
      <p>Cuando haya movimientos importados, aquí vivirán los indicadores ampliados, el resumen mensual y el pivot completo.</p>
    {:else}
      <h2>Esta pantalla está en construcción</h2>
      <p>
        Hay {data.status.transactionCount} movimientos guardados en
        {data.status.accountCount} cuentas. El pivot y las gráficas de esta pantalla llegan en una fase posterior del módulo.
      </p>
    {/if}
  </section>
</div>
