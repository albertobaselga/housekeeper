<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import FinanceDetailPanel from '$lib/components/finance/FinanceDetailPanel.svelte';
  import FinanceFilterBar from '$lib/components/finance/FinanceFilterBar.svelte';
  import LedgerTable from '$lib/components/finance/LedgerTable.svelte';
  import type { FinanceDetailMode } from '$lib/finance/api';
  import { categoryPath } from '$lib/finance/breakdown';
  import { mergeParams, rangeLabel } from '$lib/finance/filters';
  import { formatCents } from '$lib/finance/format';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const movimientos = $derived(data.movimientos);
  const eventNameById = $derived(Object.fromEntries(movimientos.events.map((event) => [event.id, event.name])));

  let panelMode = $state<FinanceDetailMode | null>(null);
  let searchText = $state(page.url.searchParams.get('q') ?? '');
  const currentCategory = $derived(page.url.searchParams.get('cat') ?? '');
  const currentRecurrence = $derived(page.url.searchParams.get('rec') ?? '');
  const offset = $derived(movimientos.page.offset);

  // Cambiar un filtro local vuelve a la primera página (offset fuera);
  // paginar conserva los filtros. Siempre merge no destructivo.
  function applyLocal(patch: Record<string, string | null>): void {
    void goto(`?${mergeParams(page.url.searchParams, { ...patch, offset: null })}`, { noScroll: true, keepFocus: true });
  }
  function goPage(nextOffset: number): void {
    void goto(`?${mergeParams(page.url.searchParams, { offset: nextOffset > 0 ? String(nextOffset) : null })}`, { noScroll: true });
  }
</script>

<div class="page-wrap">
  <PageHeader eyebrow="Cuentas de la casa" title="Movimientos" support={rangeLabel(movimientos.filters)} />

  <FinanceFilterBar filters={movimientos.filters} accounts={movimientos.accounts} />

  <form class="finance-localfilters" onsubmit={(event) => { event.preventDefault(); applyLocal({ q: searchText.trim() || null }); }}>
    <input type="search" bind:value={searchText} placeholder="Buscar concepto o proveedor…" aria-label="Buscar concepto o proveedor" />
    <select aria-label="Filtrar por categoría" value={currentCategory}
      onchange={(event) => applyLocal({ cat: event.currentTarget.value || null })}>
      <option value="">Todas las categorías</option>
      {#each movimientos.categories.filter((category) => category.kind !== 'transferencia') as category (category.id)}
        <option value={category.id}>{categoryPath(movimientos.categories, category.id)}</option>
      {/each}
    </select>
    <select aria-label="Filtrar por naturaleza" value={currentRecurrence}
      onchange={(event) => applyLocal({ rec: event.currentTarget.value || null })}>
      <option value="">Todos</option>
      <option value="recurrente">♻ Recurrentes</option>
      <option value="extraordinario">✦ Extraordinarios</option>
    </select>
    <button type="submit" class="button secondary small-button">Buscar</button>
  </form>

  <article class="card">
    <LedgerTable rows={movimientos.page.rows} {eventNameById} onOpen={(tx) => (panelMode = { kind: 'movimiento', tx })} />
    <div class="ledger-total">
      <span>{movimientos.page.total} movimiento{movimientos.page.total === 1 ? '' : 's'} con estos filtros</span>
      <strong>{formatCents(movimientos.page.sumCents, { signed: true })}</strong>
    </div>
    {#if movimientos.page.total > movimientos.page.limit}
      <nav class="action-row" aria-label="Paginación">
        <button type="button" class="button secondary small-button" disabled={offset === 0}
          onclick={() => goPage(Math.max(0, offset - movimientos.page.limit))}>‹ Anteriores</button>
        <span class="audit-note">{offset + 1}–{Math.min(offset + movimientos.page.rows.length, movimientos.page.total)} de {movimientos.page.total}</span>
        <button type="button" class="button secondary small-button"
          disabled={offset + movimientos.page.limit >= movimientos.page.total}
          onclick={() => goPage(offset + movimientos.page.limit)}>Siguientes ›</button>
      </nav>
    {/if}
  </article>
</div>

<FinanceDetailPanel mode={panelMode} householdId={movimientos.householdId} live={!data.demo} onClose={() => (panelMode = null)} />

<style>
  .finance-localfilters { display: flex; flex-wrap: wrap; gap: var(--space-2); }
  .finance-localfilters input, .finance-localfilters select {
    min-height: 2.75rem; border: 1px solid var(--line-strong); border-radius: var(--r-sm);
    background: var(--surface-strong); padding: var(--space-1) var(--space-2);
  }
  .finance-localfilters input { flex: 1 1 14rem; min-width: 0; }
</style>
