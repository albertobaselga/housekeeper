<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import type { FinanceTxDto } from '@housekeeper/server';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import ActionStatus from '$lib/components/ActionStatus.svelte';
  import FinanceDetailPanel from '$lib/components/finance/FinanceDetailPanel.svelte';
  import FinanceFilterBar from '$lib/components/finance/FinanceFilterBar.svelte';
  import FinanceNav from '$lib/components/finance/FinanceNav.svelte';
  import LedgerTable from '$lib/components/finance/LedgerTable.svelte';
  import ManualForm from '$lib/components/finance/ManualForm.svelte';
  import type { FinanceDetailMode } from '$lib/finance/api';
  import { categoryPath } from '$lib/finance/breakdown';
  import { financeCommand } from '$lib/finance/commands';
  import { mergeParams, rangeLabel } from '$lib/finance/filters';
  import { formatCents } from '$lib/finance/format';
  import { canLinkSelection } from '$lib/finance/link-transfers';
  import { useAppContext } from '$lib/auth/context';
  import { OptimisticActions } from '$lib/offline/optimistic';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const movimientos = $derived(data.movimientos);
  const eventNameById = $derived(Object.fromEntries(movimientos.events.map((event) => [event.id, event.name])));

  let panelMode = $state<FinanceDetailMode | null>(null);
  let searchText = $state(page.url.searchParams.get('q') ?? '');
  const currentCategory = $derived(page.url.searchParams.get('cat') ?? '');
  const currentRecurrence = $derived(page.url.searchParams.get('rec') ?? '');
  const offset = $derived(movimientos.page.offset);

  const context = useAppContext();
  const optimistic = new OptimisticActions({ householdId: context.household.id, invalidateToken: 'cc:finance' });
  const actionStatus = optimistic.status;
  $effect(() => optimistic.start());

  let selected = $state<string[]>([]);
  let manualOpen = $state(false);

  const selectedSet = $derived(new Set(selected));
  const linkCheck = $derived(
    canLinkSelection(
      movimientos.page.rows.map((row) => ({
        id: row.id,
        amountCents: row.amountCents,
        transferGroupId: row.transferGroupId
      })),
      selectedSet
    )
  );

  function toggleSelected(rowId: string, on: boolean): void {
    selected = on ? [...selected, rowId] : selected.filter((id) => id !== rowId);
  }

  function setCategory(rowId: string, categoryId: string): void {
    void optimistic.run(
      financeCommand(context.household.id, { kind: 'finance.transaction.update', transactionId: rowId, categoryId })
    );
  }

  // `null` es un valor legítimo («—» del RecurrenceChip): devuelve el movimiento
  // a sin clasificar. El esquema y el handler lo aceptan; no hay guarda que valga.
  function setRecurrence(rowId: string, recurrence: 'recurrente' | 'extraordinario' | null): void {
    void optimistic.run(
      financeCommand(context.household.id, { kind: 'finance.transaction.update', transactionId: rowId, recurrence })
    );
  }

  function toggleEvent(row: FinanceTxDto, eventId: string, add: boolean): void {
    const eventIds = add ? [...row.eventIds, eventId] : row.eventIds.filter((id) => id !== eventId);
    void optimistic.run(
      financeCommand(context.household.id, { kind: 'finance.transaction.update', transactionId: row.id, eventIds })
    );
  }

  // Crear un evento desde el selector de una fila: se crea y basta. El
  // invalidate de `cc:finance` lo trae a la lista; asignarlo es la segunda
  // pulsación del usuario (no encadenamos comandos con el id aún sin viajar).
  function createEvent(name: string): void {
    void optimistic.run(financeCommand(context.household.id, { kind: 'finance.event.create', name }));
  }

  function assignEventToSelection(eventId: string): void {
    void optimistic.run(
      financeCommand(context.household.id, {
        kind: 'finance.event.assignTransactions',
        eventId,
        transactionIds: selected,
        action: 'add'
      }),
      { settle: () => (selected = []) }
    );
  }

  function linkSelection(): void {
    if (!linkCheck.enabled) return;
    void optimistic.run(
      financeCommand(context.household.id, { kind: 'finance.transfers.link', transactionIds: selected }),
      { settle: () => (selected = []) }
    );
  }

  function unlinkGroup(transferGroupId: string): void {
    if (!window.confirm('¿Desvincular esta transferencia? Las patas volverán a pendiente.')) return;
    void optimistic.run(
      financeCommand(context.household.id, { kind: 'finance.transfers.unlink', transferGroupId })
    );
  }

  function deleteManual(rowId: string): void {
    if (!window.confirm('¿Borrar este movimiento manual?')) return;
    void optimistic.run(
      financeCommand(context.household.id, { kind: 'finance.transaction.manual.delete', transactionId: rowId })
    );
  }

  function createManual(input: {
    accountId: string; opDate: string; concept: string; provider: string;
    amountCents: string; categoryId: string | null; recurrence: 'recurrente' | 'extraordinario' | null;
  }): void {
    void optimistic.run(
      financeCommand(context.household.id, {
        kind: 'finance.transaction.manual.create',
        accountId: input.accountId,
        opDate: input.opDate,
        concept: input.concept,
        provider: input.provider,
        amountCents: input.amountCents,
        categoryId: input.categoryId,
        recurrence: input.recurrence
      }),
      { settle: () => (manualOpen = false) }
    );
  }

  // Cambiar un filtro local vuelve a la primera página (offset fuera);
  // paginar conserva los filtros. Siempre merge no destructivo.
  //
  // [FASE 5, T9 · corrección Minor 4] `goto` a la misma ruta no remonta el
  // componente: `selected` sobreviviría al cambio de filtro/página apuntando a
  // filas que `linkCheck` ya no ve (calculado solo sobre
  // `movimientos.page.rows` actuales), dejando la barra de selección con un
  // recuento que no corresponde a ninguna fila visible. Se vacía en el mismo
  // gesto que dispara la navegación.
  function applyLocal(patch: Record<string, string | null>): void {
    selected = [];
    void goto(`?${mergeParams(page.url.searchParams, { ...patch, offset: null })}`, { noScroll: true, keepFocus: true });
  }
  function goPage(nextOffset: number): void {
    selected = [];
    void goto(`?${mergeParams(page.url.searchParams, { offset: nextOffset > 0 ? String(nextOffset) : null })}`, { noScroll: true });
  }
</script>

<div class="page-wrap">
  <PageHeader eyebrow="Cuentas de la casa" title="Movimientos" support={rangeLabel(movimientos.filters)} />
  <FinanceNav pendingReviewCount={data.pendingReviewCount} />

  <ActionStatus status={actionStatus} />

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
    <button class="button secondary" type="button" onclick={() => (manualOpen = !manualOpen)}>+ Añadir manual</button>
  </form>

  {#if manualOpen}
    <ManualForm accounts={movimientos.accounts} categories={movimientos.categories} onsubmit={createManual} oncancel={() => (manualOpen = false)} />
  {/if}

  <article class="card">
    {#if selected.length > 0}
      <div class="seleccion-bar">
        <span>{selected.length} seleccionado{selected.length === 1 ? '' : 's'}</span>
        <button class="button secondary small-button" type="button" disabled={!linkCheck.enabled}
          title={linkCheck.reason ?? 'Vincular como transferencia'} onclick={linkSelection}>⇄ Vincular transferencia</button>
        {#each movimientos.events as entry (entry.id)}
          <button class="button secondary small-button" type="button" onclick={() => assignEventToSelection(entry.id)}>◈ {entry.name}</button>
        {/each}
        <button class="button secondary small-button" type="button" onclick={() => (selected = [])}>Quitar selección</button>
      </div>
    {/if}
    <LedgerTable
      rows={movimientos.page.rows}
      {eventNameById}
      onOpen={(tx) => (panelMode = { kind: 'movimiento', tx })}
      selectedIds={selectedSet}
      onToggleSelect={toggleSelected}
      categories={movimientos.categories}
      events={movimientos.events}
      onSetCategory={setCategory}
      onToggleEvent={toggleEvent}
      onCreateEvent={createEvent}
      onSetRecurrence={setRecurrence}
      onDeleteManual={deleteManual}
      onUnlink={unlinkGroup}
    />
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
  .seleccion-bar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); padding: var(--space-2); }
</style>
