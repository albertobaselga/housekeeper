<script lang="ts">
  import PageHeader from '$lib/components/PageHeader.svelte';
  import FinanceNav from '$lib/components/finance/FinanceNav.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<div class="page-wrap">
  <PageHeader eyebrow="Finanzas" title="Ajustes de Finanzas" />
  <FinanceNav pendingReviewCount={data.pendingReviewCount} />
  <section class="empty-state">
    <span aria-hidden="true">€</span>
    {#if data.status.transactionCount === 0}
      <h2>Aún no hay datos de finanzas</h2>
      <p>Aquí se administrarán las cuentas, las categorías, las reglas y los alias de proveedores.</p>
    {:else}
      <h2>Esta pantalla está en construcción</h2>
      <p>
        Hay {data.status.transactionCount} movimientos guardados en
        {data.status.accountCount} cuentas. Los ajustes del módulo llegan en una fase posterior. La concesión por cuenta vive en los Ajustes del hogar.
      </p>
    {/if}
  </section>
</div>
