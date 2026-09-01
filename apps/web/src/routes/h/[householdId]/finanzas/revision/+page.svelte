<script lang="ts">
  import PageHeader from '$lib/components/PageHeader.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<div class="page-wrap">
  <PageHeader eyebrow="Finanzas" title="Revisión" />
  <section class="empty-state">
    <span aria-hidden="true">€</span>
    {#if data.status.transactionCount === 0}
      <h2>Aún no hay datos de finanzas</h2>
      <p>Cuando haya movimientos pendientes o sugeridos, aquí se confirmarán uno a uno o en bloque.</p>
    {:else}
      <h2>Esta pantalla está en construcción</h2>
      <p>
        Hay {data.status.transactionCount} movimientos guardados en
        {data.status.accountCount} cuentas. La bandeja de revisión llega en una fase posterior del módulo.
      </p>
    {/if}
  </section>
</div>
