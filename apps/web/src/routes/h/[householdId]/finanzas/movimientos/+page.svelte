<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import type { CommandEnvelopeV1, FinanceWritePayloadV1 } from '@housekeeper/contracts';
  import type { FinanceTxDto } from '@housekeeper/server';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import ActionStatus from '$lib/components/ActionStatus.svelte';
  import CategorySelect from '$lib/components/finance/CategorySelect.svelte';
  import FinanceDetailPanel from '$lib/components/finance/FinanceDetailPanel.svelte';
  import FinanceFilterBar from '$lib/components/finance/FinanceFilterBar.svelte';
  import FinanceNav from '$lib/components/finance/FinanceNav.svelte';
  import LedgerTable from '$lib/components/finance/LedgerTable.svelte';
  import ManualForm from '$lib/components/finance/ManualForm.svelte';
  import type { FinanceDetailMode } from '$lib/finance/api';
  import { financeCommand } from '$lib/finance/commands';
  import { mergeParams, rangeLabel } from '$lib/finance/filters';
  import { formatCents } from '$lib/finance/format';
  import { canLinkSelection } from '$lib/finance/link-transfers';
  import { draftedRow, releaseDraft, restoreDraft, withDraft, type RowDrafts } from '$lib/finance/row-drafts';
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

  /*
   * [FASE 5 · despacho de cierre, F5-I5] Borrador por fila, la misma pieza que
   * Ajustes: `finance.transaction.update` con `eventIds` es un REEMPLAZO
   * completo (`replaceTransactionEvents` borra y reinserta), y hasta ahora el
   * payload se construía desde `row.eventIds` —la foto del servidor—, que con
   * `queued` no se refresca porque no hay `invalidate`. Marcar el evento A y
   * luego el B mandaba `eventIds: [B]`, y al vaciarse la cola en orden FIFO A
   * desaparecía sin aviso. El borrador acumula lo pendiente, se revierte si el
   * servidor rechaza y suelta en `settle` solo lo confirmado.
   */
  let drafts = $state<RowDrafts<FinanceTxDto>>({});

  // Las filas que se pintan llevan el borrador aplicado: el selector de
  // eventos y el de categoría enseñan lo que la persona acaba de marcar,
  // aunque el acuse siga en la cola.
  const ledgerRows = $derived(movimientos.page.rows.map((row) => draftedRow(row, drafts[row.id])));

  /**
   * Anota el parche en el borrador de la fila, manda el comando ya construido
   * y administra los tres desenlaces: rechazo → el borrador vuelve donde
   * estaba (T13-R1); acuse → suelta SOLO las claves de este comando (T13-R2);
   * `queued` → el borrador se queda, que es de lo que se trata.
   */
  function saveRow(
    rowId: string,
    patch: Partial<FinanceTxDto>,
    command: CommandEnvelopeV1<FinanceWritePayloadV1>
  ): void {
    const previo = drafts[rowId];
    drafts = withDraft(drafts, rowId, patch);
    void optimistic.run(command, {
      revert: () => (drafts = restoreDraft(drafts, rowId, previo)),
      settle: () => (drafts = releaseDraft(drafts, rowId, patch))
    });
  }

  function setCategory(rowId: string, categoryId: string): void {
    // `categoryName` viaja en el borrador junto a `categoryId` porque la línea
    // de apoyo de la fila (`ledgerRowMeta`) pinta el NOMBRE: sin él, el
    // desplegable enseñaría la categoría nueva y el renglón de debajo seguiría
    // diciendo la vieja hasta que llegara el acuse.
    const categoryName = movimientos.categories.find((category) => category.id === categoryId)?.name ?? null;
    saveRow(
      rowId,
      { categoryId, categoryName },
      financeCommand(context.household.id, { kind: 'finance.transaction.update', transactionId: rowId, categoryId })
    );
  }

  // `null` es un valor legítimo («—» del RecurrenceChip): devuelve el movimiento
  // a sin clasificar. El esquema y el handler lo aceptan; no hay guarda que valga.
  function setRecurrence(rowId: string, recurrence: 'recurrente' | 'extraordinario' | null): void {
    saveRow(
      rowId,
      { recurrence },
      financeCommand(context.household.id, { kind: 'finance.transaction.update', transactionId: rowId, recurrence })
    );
  }

  function toggleEvent(row: FinanceTxDto, eventId: string, add: boolean): void {
    // Del BORRADOR, no de la foto: es el hallazgo F5-I5 entero.
    const actuales = draftedRow(row, drafts[row.id]).eventIds;
    const eventIds = add ? [...actuales, eventId] : actuales.filter((id) => id !== eventId);
    saveRow(
      row.id,
      { eventIds },
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
    <!--
      [FASE 5 · despacho de cierre, F4-I3] Este filtro montaba su propio
      `<select>` plano con `categoryPath`: listaba también las raíces —«Casa»—,
      y como el filtro del cargador compara por IGUALDAD exacta de
      `category_id`, elegir la raíz devolvía «0 movimientos» aunque todas sus
      subcategorías tuvieran datos. `CategorySelect` (el mismo componente que
      ya usan Revisión y cada fila del ledger, así que no entra código nuevo en
      el paquete) agrupa por raíz, rotula la raíz como «Casa / (general)» —que
      es lo que de verdad hace el filtro— y deja fuera las categorías de
      `transferencia` dentro de `categoryOptionGroups`, sin repetir aquí ese
      filtro.
    -->
    <CategorySelect
      categories={movimientos.categories}
      value={currentCategory || null}
      label="Filtrar por categoría"
      onchange={(categoryId) => applyLocal({ cat: categoryId })}
    />
    {#if currentCategory}
      <button class="button secondary small-button" type="button"
        onclick={() => applyLocal({ cat: null })}>Todas las categorías</button>
    {/if}
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
      rows={ledgerRows}
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
