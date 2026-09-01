<script lang="ts">
  import PageHeader from '$lib/components/PageHeader.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<div class="page-wrap">
  <PageHeader eyebrow="Finanzas" title="Importar extractos" />
  <section class="empty-state">
    <span aria-hidden="true">€</span>
    {#if data.status.transactionCount === 0}
      <h2>Aún no hay datos de finanzas</h2>
      <p>Aquí se subirán los extractos del banco, con previsualización antes de confirmar.</p>
    {:else}
      <h2>Esta pantalla está en construcción</h2>
      <p>
        Hay {data.status.transactionCount} movimientos guardados en
        {data.status.accountCount} cuentas. La importación de extractos llega en una fase posterior del módulo.
      </p>
    {/if}
  </section>
</div>
