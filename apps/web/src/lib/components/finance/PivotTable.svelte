<script lang="ts">
  import { invalidate, replaceState } from '$app/navigation';
  import { page } from '$app/state';
  import {
    buildPivotTree,
    INTERNA_DIMS,
    INVERSION_DIMS,
    type PivotDimension,
    type PivotEventGroup
  } from '@housekeeper/domain/finance';
  import type { FinanceWritePayloadV1 } from '@housekeeper/contracts';
  import { monthLabel } from '$lib/finance/chart-data';
  import { categoryPath } from '$lib/finance/breakdown';
  import { formatCents } from '$lib/finance/format';
  import {
    addDim, collectMovIdsByKey, DIM_LABELS, moveDim, parseChips, parseDims, parseIdList, PIVOT_DIMENSIONS,
    rangeBetween, removeDim, resolveSelectionIds, rowMatchesChips, sameSortKey, selectableListAny,
    serializeChips, serializeDims, serializeIdList, sortTree, summarizeCategoryDrop, summarizeEventDrop,
    toAnySelectable, toggleInMap, toMovementSelectable,
    type PivotNodeLike, type PivotSortKey, type SelectableItem, type SortDir
  } from '$lib/finance/pivot-state';
  import {
    acuse, assignConceptRecurrence, assignConceptToCategory, assignConceptToEvent, assignTransactionsToEvent,
    buildTxCategoryIndex, bulkByIds, conceptTargetOf, createEventPayload, investTransaction,
    planCategoryUndo, sendAll, undoEventAssign, updateTransactionRecurrence,
    type CategoryUndo
  } from '$lib/finance/pivot-actions';
  import type { AnaliticaCategory, AnaliticaEventSummary, AnaliticaPivotRow } from '$lib/finance/analitica-data';
  import PivotActionBar from './PivotActionBar.svelte';
  import PivotSearch from './PivotSearch.svelte';

  let {
    rows, months, categories, events, invAccounts, householdId, onOpenIds
  }: {
    rows: AnaliticaPivotRow[];
    months: string[];
    categories: AnaliticaCategory[];
    events: AnaliticaEventSummary[];
    invAccounts: { id: string; name: string }[];
    householdId: string;
    onOpenIds: (ids: string[], label: string, sub: string) => void;
  } = $props();

  // Ruta de categoría: la única del módulo es la de la fase 4 (separador «›»).
  const catPathOf = (id: string) => categoryPath(categories, id);

  // dims y dupev viven en la URL (merge no destructivo) con routing superficial:
  // no cambian los datos del servidor, solo la agrupación cliente.
  const dims = $derived(parseDims(page.url.searchParams.get('dims')));
  const chips = $derived(parseChips(page.url.searchParams.get('q')));
  const dupEventIds = $derived(parseIdList(page.url.searchParams.get('dupev')));

  function setShallowParam(key: string, value: string): void {
    const url = new URL(page.url);
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
    replaceState(url, {});
  }
  // serializeDims (fase 4) devuelve null para el orden por defecto ⇒ URL limpia.
  const setDims = (next: PivotDimension[]) => setShallowParam('dims', serializeDims(next) ?? '');
  const toggleDupEvent = (id: string) => {
    const next = dupEventIds.includes(id) ? dupEventIds.filter((x) => x !== id) : [...dupEventIds, id];
    setShallowParam('dupev', serializeIdList(next));
  };

  let expanded = $state<Set<string>>(new Set());
  const toggle = (key: string) => {
    const next = new Set(expanded);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    expanded = next;
  };

  let sort = $state<{ key: PivotSortKey; dir: SortDir }>({ key: 'total', dir: 'asc' });
  const toggleSort = (key: PivotSortKey) => {
    sort = sameSortKey(sort.key, key) ? { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' };
  };
  const sortIndicator = (key: PivotSortKey) => (sameSortKey(sort.key, key) ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '');

  const hasSearch = $derived(chips.length > 0);
  const forceExpand = $derived(hasSearch);
  const filteredRows = $derived(rows.filter((r) => rowMatchesChips(r, chips, catPathOf)));

  // Árbol del dominio (fase 2); dupev duplica eventos bajo su categoría sin
  // alterar el TOTAL NETO (invariante del dominio, testeada allí).
  // opts canónico: { monthsCount, dupEventIds } — con `months` los promedios
  // saldrían todos a 0 (el dominio divide por monthsCount).
  const tree = $derived(
    buildPivotTree(filteredRows, dims, { monthsCount: months.length, dupEventIds: new Set(dupEventIds) })
  );

  // Gastos: ascendente = mayor gasto primero. Ingresos/eventos: dirección
  // contraria salvo por etiqueta, que ordena igual en las tres secciones.
  const oppositeDir = $derived<SortDir>(sort.dir === 'asc' ? 'desc' : 'asc');
  const ingresosDir = $derived(sort.key === 'label' ? sort.dir : oppositeDir);
  // Sin `as`: `sortTree<T extends SortableNodeLike & { children: T[] }>` infiere
  // T = PivotNode (el nodo del dominio, fase 2) directamente de `tree.gastos`,
  // y PivotNode es estructuralmente asignable a PivotNodeLike (mismos campos,
  // más `concepts` que aquí no hace falta).
  const gastoTree = $derived(sortTree(tree.gastos, sort.key, sort.dir));
  const ingresoTree = $derived(sortTree(tree.ingresos, sort.key, ingresosDir));
  const internaTree = $derived(tree.internas);
  const inversionTree = $derived(tree.inversiones);
  const eventTree = $derived(
    [...tree.eventos]
      .map((e) => ({ ...e, children: sortTree(e.children, sort.key, ingresosDir) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'es'))
  );
  // Eventos sin movimientos en el periodo: fila vacía, sigue siendo drop target.
  // Anotar el retorno del `map` como `PivotEventGroup` (en vez de `as
  // PivotNodeLike[]` sobre `children: []`) da a `[]` el contexto `PivotNode[]`
  // sin casts: mismo tipo final que `eventTree` para el `[...a, ...b]` de abajo.
  const displayEventos = $derived(
    hasSearch
      ? eventTree
      : [
          ...eventTree,
          ...events
            .filter((e) => !eventTree.some((t) => t.eventId === e.id))
            .map(
              (e): PivotEventGroup => ({
                eventId: e.id, name: e.name, count: 0, netCents: 0n, avgCents: 0n, ticketCents: 0n, monthly: {}, children: []
              })
            )
        ].sort((a, b) => a.name.localeCompare(b.name, 'es'))
  );

  const colSpan = $derived(4 + months.length);
  const isEmpty = $derived(hasSearch && gastoTree.length === 0 && ingresoTree.length === 0 && displayEventos.length === 0 && internaTree.length === 0 && inversionTree.length === 0);
  const cellText = (v: bigint | undefined) => (!v ? '·' : formatCents(v));
  const tintFor = (depth: number) =>
    depth === 0 ? '' : `background: color-mix(in srgb, var(--surface) ${100 - Math.min(depth, 4) * 7}%, var(--line-strong));`;
  const openLeaf = (node: PivotNodeLike) =>
    onOpenIds(node.movs.map((m) => m.id), node.label, `${node.movs.length} ${node.movs.length === 1 ? 'movimiento' : 'movimientos'}`);

  // ── Selección (Map inmutable + rango con Shift) ────────────────────────────
  let selected = $state<Map<string, SelectableItem>>(new Map());
  let lastKey = $state<string | null>(null);
  const selectionList = $derived([...selected.values()]);
  const selectionMovs = $derived(selectionList.reduce((s, i) => s + i.count, 0));
  const clearSelection = () => { selected = new Map(); lastKey = null; };

  /** Guarda de tipo: evita el `!` sobre `txId` (prohibido) en los aplicadores de abajo. */
  function hasTxId(item: SelectableItem): item is SelectableItem & { txId: string } {
    return item.txId != null;
  }

  function clickItem(item: SelectableItem, siblings: SelectableItem[], shiftKey: boolean): void {
    if (shiftKey && lastKey) {
      const range = rangeBetween(siblings, lastKey, item.key);
      if (range) {
        const next = new Map(selected);
        for (const it of range) next.set(it.key, it);
        selected = next;
        lastKey = item.key;
        return;
      }
    }
    selected = toggleInMap(selected, item);
    lastKey = item.key;
  }

  // Sin `as`: cada árbol es un `PivotNode[]`/`PivotEventGroup['children']` del
  // dominio, estructuralmente asignable a `PivotNodeLike` (mismos campos, más
  // `concepts` que aquí no hace falta) — TS lo infiere sin forzar el tipo.
  const allRoots = $derived([
    ...gastoTree, ...ingresoTree, ...internaTree, ...inversionTree,
    ...displayEventos.flatMap((e) => e.children)
  ]);
  const movIdsByKey = $derived(collectMovIdsByKey(allRoots));
  // `AnaliticaPivotRow` no lleva categoryId por movimiento: cada fila del pivot
  // ya agrupa movimientos que comparten `catId` (fase 2, mismo groupBy que
  // `PivotSourceRow`), así que se aplana a pares {id, categoryId} usando el
  // catId de la fila que contiene cada mov — no es la firma literal del brief
  // (`buildTxCategoryIndex(rows)`), que asumía filas por movimiento.
  const txCatIndex = $derived(
    buildTxCategoryIndex(rows.flatMap((r) => r.movs.map((m) => ({ id: m.id, categoryId: r.catId }))))
  );

  // ── Toast con Deshacer y envío secuencial de comandos ──────────────────────
  // `sendAll`/`acuse`/`COLA` viven en `$lib/finance/pivot-actions` (tarea 6),
  // ya probados allí (R14/R25): aquí solo se encadena `householdId` y el
  // `invalidate` de `$app/navigation` con el token canónico 'cc:finance'
  // (Task 8) a través de este cierre — `sendAll` real pide 3 argumentos
  // (householdId, payloads, { invalidate }), no uno solo como el brief.
  let toast = $state<{ message: string; onUndo?: () => Promise<void> } | null>(null);
  const submit = (payloads: readonly FinanceWritePayloadV1[]) => sendAll(householdId, payloads, { invalidate });

  async function runCategoryUndo(plan: CategoryUndo): Promise<void> {
    const payloads = [
      ...plan.reassignments.map((r) => assignConceptToCategory(r.provider, r.concept, r.categoryId)),
      ...plan.bulkRestores.map((g) => bulkByIds(g.transactionIds, { categoryId: g.categoryId }))
    ];
    const r = await submit(payloads);
    const aviso = plan.bulkRestores.length > 0 ? ' · las reglas creadas se conservan (bórralas en Ajustes)' : '';
    const saltos = plan.skipped > 0 ? ` · ${plan.skipped} sin categoría previa` : '';
    toast = { message: acuse(r, `Deshecho${aviso}${saltos}`) };
  }

  // ── Aplicadores compartidos ───────────────────────────────────────────────
  // La barra de acciones y el drag-and-drop (tarea 13) son dos caminos para el
  // MISMO gesto: comparten estas tres funciones para que no puedan divergir.

  async function applyEventAssignment(
    items: readonly SelectableItem[], eventId: string, eventName: string, omitted: number
  ): Promise<void> {
    const transactionIds = items.filter(hasTxId).map((i) => i.txId);
    const conceptItems = items.filter((i) => i.txId == null);
    const movs = items.reduce((s, i) => s + i.count, 0);
    const r = await submit([
      ...conceptItems.map((i) => assignConceptToEvent(conceptTargetOf(i), { eventId })),
      ...(transactionIds.length ? [assignTransactionsToEvent(eventId, transactionIds, 'add')] : [])
    ]);
    toast = {
      message: acuse(r, summarizeEventDrop(movs, eventName, omitted)),
      ...(r.ok && (conceptItems.length > 0 || transactionIds.length > 0)
        ? {
            onUndo: async () => {
              const u = await submit([
                ...conceptItems.map((i) => undoEventAssign(conceptTargetOf(i))),
                ...(transactionIds.length ? [assignTransactionsToEvent(eventId, transactionIds, 'remove')] : [])
              ]);
              toast = { message: acuse(u, 'Deshecho') };
            }
          }
        : {})
    };
  }

  /**
   * Evento nuevo: el id lo genera el cliente para poder encadenar «crear» y
   * «asignar» sin esperar al ACK. Así los movimientos sueltos (hojas con txId)
   * también se asignan — antes se perdían en silencio con un toast de éxito.
   */
  async function applyNewEventAssignment(
    items: readonly SelectableItem[], name: string, omitted: number
  ): Promise<void> {
    const existing = events.find((e) => e.name.toLocaleLowerCase() === name.toLocaleLowerCase());
    if (existing) return applyEventAssignment(items, existing.id, existing.name, omitted);
    const eventId = crypto.randomUUID();
    const transactionIds = items.filter(hasTxId).map((i) => i.txId);
    const conceptItems = items.filter((i) => i.txId == null);
    const movs = items.reduce((s, i) => s + i.count, 0);
    // R27: la firma real es createEventPayload(name, id?) — el id va SEGUNDO.
    const r = await submit([
      createEventPayload(name, eventId),
      ...conceptItems.map((i) => assignConceptToEvent(conceptTargetOf(i), { eventId })),
      ...(transactionIds.length ? [assignTransactionsToEvent(eventId, transactionIds, 'add')] : [])
    ]);
    toast = { message: acuse(r, summarizeEventDrop(movs, name, omitted)) };
  }

  async function applyCategoryAssignment(
    items: readonly SelectableItem[], categoryId: string, omitted: number
  ): Promise<void> {
    const transactionIds = resolveSelectionIds(items.filter(hasTxId), movIdsByKey);
    const conceptItems = items.filter((i) => i.txId == null && i.categoryId == null);
    const omitidos = omitted + items.filter((i) => i.categoryId != null).length;
    const plan = planCategoryUndo(conceptItems, movIdsByKey, txCatIndex);
    const movidos = conceptItems.reduce((s, i) => s + i.count, 0) + transactionIds.length;
    const r = await submit([
      ...conceptItems.map((i) => assignConceptToCategory(i.provider, i.concept, categoryId)),
      ...(transactionIds.length ? [bulkByIds(transactionIds, { categoryId })] : [])
    ]);
    toast = {
      // Con 0 movidos, summarizeCategoryDrop ya explica POR QUÉ no se movió nada
      // («las categorías no pueden soltarse sobre otra categoría»): ese texto es
      // mejor acuse vacío que el genérico.
      message: acuse(
        r,
        summarizeCategoryDrop(movidos, catPathOf(categoryId), omitidos),
        summarizeCategoryDrop(0, catPathOf(categoryId), omitidos)
      ),
      ...(r.ok && movidos > 0 ? { onUndo: () => runCategoryUndo(plan) } : {})
    };
  }

  // ── Acciones de la barra (delegan en los aplicadores) ──────────────────────
  async function actionMoveToEvent(eventId: string): Promise<void> {
    const items = selectionList;
    if (items.length === 0) return;
    const name = events.find((e) => e.id === eventId)?.name ?? '';
    await applyEventAssignment(items, eventId, name, 0);
    clearSelection();
  }
  async function actionNewEvent(name: string): Promise<void> {
    const items = selectionList;
    if (items.length === 0) return;
    await applyNewEventAssignment(items, name, 0);
    clearSelection();
  }
  async function actionMoveToCategory(categoryId: string): Promise<void> {
    const items = selectionList;
    if (items.length === 0) return;
    await applyCategoryAssignment(items, categoryId, 0);
    clearSelection();
  }
  async function actionSetRecurrence(rec: 'recurrente' | 'extraordinario'): Promise<void> {
    const items = selectionList;
    if (items.length === 0) return;
    // Por concepto: assignConceptRecurrence. Hoja suelta: transaction.update
    // (finance.transactions.bulk NO admite recurrence, resolución nº 5).
    const transactionIds = items.filter(hasTxId).map((i) => i.txId);
    const conceptItems = items.filter((i) => i.txId == null);
    const r = await submit([
      ...conceptItems.map((i) => assignConceptRecurrence(conceptTargetOf(i), rec)),
      ...transactionIds.map((id) => updateTransactionRecurrence(id, rec))
    ]);
    const label = rec === 'recurrente' ? '♻ recurrente' : '✦ extraordinario';
    toast = { message: acuse(r, `${selectionMovs} movimiento${selectionMovs === 1 ? '' : 's'} → ${label}`) };
    clearSelection();
  }
  async function actionInvest(accountId: string): Promise<void> {
    // Solo cargos negativos sin cruzar (el servidor rechaza el resto): se envía
    // por id exacto resolviendo la selección completa.
    const ids = resolveSelectionIds(selectionList, movIdsByKey);
    if (ids.length === 0) {
      toast = { message: 'No hay nada que asignar' };
      return;
    }
    const name = invAccounts.find((a) => a.id === accountId)?.name ?? '';
    const r = await submit(ids.map((id) => investTransaction(id, accountId)));
    toast = { message: acuse(r, `${ids.length} movimiento${ids.length === 1 ? '' : 's'} → inversión ${name}`) };
    clearSelection();
  }
  function actionOpenPanel(): void {
    const ids = resolveSelectionIds(selectionList, movIdsByKey);
    const n = selectionList.length;
    onOpenIds(ids, `${n} seleccionado${n === 1 ? '' : 's'}`, `${ids.length} movimiento${ids.length === 1 ? '' : 's'}`);
  }
</script>

{#snippet subtotalRow(label: string, data: { count: number; totalCents: bigint; avgCents: bigint; ticketCents: bigint; monthly: Record<string, bigint> }, tone: '' | 'ok' | 'warn', tooltip: string, testid = '')}
  <tr class="subtotal" class:aviso={tone === 'warn'} title={tooltip || undefined} data-testid={testid || undefined}>
    <td class="arbol" class:ok={tone === 'ok'}>{label}{tone === 'warn' ? ' ⚠' : ''}{hasSearch ? ' (filtrado)' : ''} <small>({data.count})</small></td>
    <td class="importe cifra">{cellText(data.totalCents)}</td>
    <td class="importe cifra">{cellText(data.avgCents)}</td>
    <td class="importe cifra">{cellText(data.ticketCents)}</td>
    {#each months as m (m)}<td class="importe cifra">{cellText(data.monthly[m])}</td>{/each}
  </tr>
{/snippet}

{#snippet nodeRow(node: PivotNodeLike, kind: 'gasto' | 'ingreso' | 'evento' | 'transferencia' | 'inversion', nodeDims: readonly PivotDimension[], siblings: SelectableItem[])}
  {@const isExpanded = forceExpand || expanded.has(node.key)}
  {@const hasChildren = node.children.length > 0}
  {@const canOpen = !hasChildren && node.movs.length > 0}
  {@const item = kind === 'transferencia' || kind === 'inversion' ? toMovementSelectable(node, nodeDims) : toAnySelectable(node, nodeDims)}
  {@const childSiblings = selectableListAny(node.children, nodeDims)}
  {@const natClass = (kind === 'gasto' || kind === 'ingreso') && nodeDims[node.depth] === 'nat'
    ? node.nat === 'recurrente' ? (kind === 'gasto' ? 'neg' : 'pos') : node.nat === 'extraordinario' ? 'suave' : ''
    : ''}
  <tr style={tintFor(node.depth)} class:clicable={hasChildren} onclick={() => hasChildren && toggle(node.key)}>
    <td class="arbol" style={`padding-left: calc(var(--space-3) + ${node.depth} * var(--space-4));`}>
      <!-- El disparador de expansión es un BOTÓN: con teclado y lector de
           pantalla el árbol tiene que ser operable (spec §8, axe 0 serious).
           El onclick del <tr> queda solo como atajo de ratón. -->
      {#if hasChildren}
        <button type="button" class="flecha" aria-expanded={isExpanded}
          aria-label={`desplegar ${node.label}`}
          onclick={(e) => { e.stopPropagation(); toggle(node.key); }}>{isExpanded ? '▾' : '▸'}</button>
      {:else}
        <span class="flecha" aria-hidden="true"></span>
      {/if}
      <input type="checkbox" class="marca" style:visibility={item ? 'visible' : 'hidden'}
        tabindex={item ? 0 : -1} checked={item ? selected.has(node.key) : false}
        aria-label={`seleccionar ${node.label}`}
        onclick={(e) => { e.stopPropagation(); if (item) clickItem(item, siblings, e.shiftKey); }} />
      {#if canOpen}
        <button type="button" class="abrir" title="abrir ficha"
          onclick={(e) => { e.stopPropagation(); openLeaf(node); }}>{node.label}</button>
      {:else}
        <span class={natClass}>{node.label}</span>
      {/if}
      <small>({node.count})</small>
    </td>
    <td class="importe cifra {natClass}">{cellText(node.totalCents)}</td>
    <td class="importe cifra {natClass}">{cellText(node.avgCents)}</td>
    <td class="importe cifra {natClass}">{cellText(node.ticketCents)}</td>
    {#each months as m (m)}<td class="importe cifra {natClass}">{cellText(node.monthly[m])}</td>{/each}
  </tr>
  {#if isExpanded}
    {#each node.children as child (child.key)}
      {@render nodeRow(child, kind, nodeDims, childSiblings)}
    {/each}
  {/if}
{/snippet}

<div class="pivot-controles">
  <PivotSearch rows={filteredRows.length ? filteredRows : rows} {catPathOf} {chips}
    onChips={(next) => setShallowParam('q', serializeChips(next))} />
  <div class="dims" role="group" aria-label="Dimensiones del pivot">
    {#each dims as d, i (d)}
      <span class="chip activa">
        <button type="button" disabled={i === 0} aria-label={`mover ${DIM_LABELS[d]} antes`} onclick={() => setDims(moveDim(dims, i, -1))}>◀</button>
        {DIM_LABELS[d]}
        <button type="button" disabled={i === dims.length - 1} aria-label={`mover ${DIM_LABELS[d]} después`} onclick={() => setDims(moveDim(dims, i, 1))}>▶</button>
        <button type="button" disabled={dims.length <= 1} aria-label={`quitar ${DIM_LABELS[d]}`} onclick={() => setDims(removeDim(dims, d))}>×</button>
      </span>
    {/each}
    {#each PIVOT_DIMENSIONS.filter((d) => !dims.includes(d)) as d (d)}
      <button type="button" class="chip" onclick={() => setDims(addDim(dims, d))}>{DIM_LABELS[d]}</button>
    {/each}
  </div>
</div>

{#if isEmpty}
  <p class="vacio">Sin resultados que coincidan con la búsqueda.
    <button type="button" class="limpiar" onclick={() => setShallowParam('q', '')}>limpiar búsqueda</button></p>
{:else}
  <div class="pivot-scroll">
    <table class="pivot" data-testid="pivot-table">
      <thead>
        <tr>
          <th class="arbol"><button type="button" onclick={() => toggleSort('label')}>{dims.map((d) => DIM_LABELS[d]).join(' / ')}{sortIndicator('label')}</button></th>
          <th class="importe"><button type="button" onclick={() => toggleSort('total')}>Acumulado{sortIndicator('total')}</button></th>
          <th class="importe"><button type="button" onclick={() => toggleSort('avg')}>Promedio{sortIndicator('avg')}</button></th>
          <th class="importe"><button type="button" onclick={() => toggleSort('ticket')}>Ticket{sortIndicator('ticket')}</button></th>
          {#each months as m (m)}
            <th class="importe"><button type="button" onclick={() => toggleSort({ month: m })}>{monthLabel(m)}{sortIndicator({ month: m })}</button></th>
          {/each}
        </tr>
      </thead>
      <tbody>
        {#if ingresoTree.length > 0}
          <tr class="banda" data-testid="pivot-banda-ingresos"><td colspan={colSpan}>INGRESOS</td></tr>
          {#each ingresoTree as node (node.key)}{@render nodeRow(node, 'ingreso', dims, selectableListAny(ingresoTree, dims))}{/each}
          {@render subtotalRow('Subtotal ingresos', tree.subtotales.ingresos, '', '')}
        {/if}
        {#if gastoTree.length > 0}
          <tr class="banda" data-testid="pivot-banda-gastos"><td colspan={colSpan}>GASTOS</td></tr>
          {#each gastoTree as node (node.key)}{@render nodeRow(node, 'gasto', dims, selectableListAny(gastoTree, dims))}{/each}
          {@render subtotalRow('Subtotal gastos', tree.subtotales.gastos, '', '')}
        {/if}
        <tr class="banda" data-testid="pivot-banda-eventos"><td colspan={colSpan}>EVENTOS</td></tr>
        {#each displayEventos as event (event.eventId)}
          {@const key = `event/${event.eventId}`}
          {@const evExpanded = forceExpand || expanded.has(key)}
          <tr class="clicable" onclick={() => event.children.length > 0 && toggle(key)}>
            <td class="arbol">
              {#if event.children.length > 0}
                <button type="button" class="flecha" aria-expanded={evExpanded}
                  aria-label={`desplegar ${event.name}`}
                  onclick={(e) => { e.stopPropagation(); toggle(key); }}>{evExpanded ? '▾' : '▸'}</button>
              {:else}
                <span class="flecha" aria-hidden="true"></span>
              {/if}
              <input type="checkbox" checked={dupEventIds.includes(event.eventId)} disabled={event.children.length === 0}
                title="Ver los movimientos de este evento también dentro de sus categorías en GASTOS/INGRESOS"
                onclick={(e) => e.stopPropagation()} onchange={() => toggleDupEvent(event.eventId)} />
              🎉 {event.name} <small>({event.count})</small>
            </td>
            <td class="importe cifra">{cellText(event.netCents)}</td>
            <td class="importe cifra">{cellText(event.avgCents)}</td>
            <td class="importe cifra">{cellText(event.ticketCents)}</td>
            {#each months as m (m)}<td class="importe cifra">{cellText(event.monthly[m])}</td>{/each}
          </tr>
          {#if evExpanded}
            {#each event.children as child (child.key)}{@render nodeRow(child, 'evento', dims, selectableListAny(event.children, dims))}{/each}
          {/if}
        {/each}
        {#if displayEventos.length > 0}
          {@render subtotalRow('Subtotal eventos', tree.subtotales.eventos, '', '')}
        {/if}
        {#if internaTree.length > 0}
          <tr class="banda" data-testid="pivot-banda-internas"><td colspan={colSpan}>INTERNAS</td></tr>
          {#each internaTree as node (node.key)}{@render nodeRow(node, 'transferencia', INTERNA_DIMS, [])}{/each}
          {@render subtotalRow('Subtotal internas', tree.subtotales.internas,
            tree.subtotales.internas.totalCents === 0n ? 'ok' : 'warn',
            tree.subtotales.internas.totalCents === 0n ? '' : 'Con todas las cuentas seleccionadas debe sumar 0: un valor distinto indica una pata fuera del filtro de cuentas o un descuadre real.')}
        {/if}
        {#if inversionTree.length > 0}
          <tr class="banda" data-testid="pivot-banda-inversion"><td colspan={colSpan}>INVERSIÓN</td></tr>
          {#each inversionTree as node (node.key)}{@render nodeRow(node, 'inversion', INVERSION_DIMS, [])}{/each}
          {@render subtotalRow('Subtotal inversión', tree.subtotales.inversiones, '', '')}
        {/if}
        {#if gastoTree.length > 0 || ingresoTree.length > 0 || displayEventos.length > 0}
          {@render subtotalRow('TOTAL NETO', tree.subtotales.totalNeto, '', '', 'pivot-total-neto')}
        {/if}
      </tbody>
    </table>
  </div>
  {#if hasSearch}
    <p class="nota">los KPIs muestran el total del periodo</p>
  {/if}
{/if}

{#if selectionList.length > 0}
  <!-- `events` (el prop íntegro), no `displayEventos`: mientras `hasSearch` es
       true, `displayEventos` se reduce a `eventTree` y omitiría eventos sin
       movimientos visibles en la búsqueda actual — aquí hace falta la lista
       completa del household para poder mover la selección a cualquiera. -->
  <PivotActionBar concepts={selectionList.length} movs={selectionMovs}
    {events} {categories} {invAccounts}
    categoryOnlySelection={selectionList.every((i) => i.categoryId != null)}
    onMoveToEvent={actionMoveToEvent} onNewEvent={actionNewEvent}
    onMoveToCategory={actionMoveToCategory} onSetRecurrence={actionSetRecurrence}
    onInvest={actionInvest} onOpenPanel={actionOpenPanel} onClear={clearSelection} />
{/if}

{#if toast}
  <div class="pivot-toast" role="status" data-testid="pivot-toast">
    <span>{toast.message}</span>
    {#if toast.onUndo}<button type="button" onclick={() => { const u = toast?.onUndo; toast = null; void u?.(); }}>Deshacer</button>{/if}
    <button type="button" aria-label="cerrar aviso" onclick={() => (toast = null)}>✕</button>
  </div>
{/if}

<style>
  .pivot-controles { display: flex; gap: var(--space-3); flex-wrap: wrap; align-items: flex-start; margin-bottom: var(--space-2); }
  .dims { display: flex; gap: var(--space-2); flex-wrap: wrap; }
  .chip { border: 1px solid var(--line); border-radius: var(--r-full); background: var(--surface); padding: var(--space-1) var(--space-2); font-size: var(--text-meta); }
  .chip.activa { border-color: var(--primary); background: var(--primary-soft); font-weight: 700; }
  .chip button { border: 0; background: transparent; cursor: pointer; padding: 0 var(--space-1); }
  .chip button:disabled { opacity: .35; cursor: default; }
  .pivot-scroll { overflow-x: auto; border: 1px solid var(--line); border-radius: var(--r-lg); background: var(--surface); }
  table.pivot { border-collapse: collapse; width: 100%; font-size: var(--text-meta); }
  .pivot th, .pivot td { padding: var(--space-1) var(--space-2); border-top: 1px solid var(--line); text-align: left; white-space: nowrap; }
  .pivot thead th { border-top: 0; }
  .pivot thead button { border: 0; background: transparent; cursor: pointer; font: inherit; color: var(--ink-faint); font-size: var(--text-micro); text-transform: uppercase; letter-spacing: .04em; padding: 0; }
  .pivot .importe { text-align: right; font-variant-numeric: tabular-nums lining-nums; }
  .pivot .arbol { position: sticky; left: 0; background: inherit; }
  .pivot tr { background: var(--surface); }
  .pivot tr.clicable { cursor: pointer; }
  .flecha { display: inline-block; width: var(--space-4); color: var(--ink-faint); border: 0; background: transparent; font: inherit; padding: 0; text-align: left; }
  button.flecha { cursor: pointer; }
  .abrir { border: 0; background: transparent; cursor: pointer; font: inherit; padding: 0; text-decoration: underline dotted; }
  .banda td { background: var(--canvas-deep); font-weight: 700; font-size: var(--text-micro); letter-spacing: .06em; }
  .subtotal { background: var(--canvas); font-weight: 500; }
  .subtotal .ok { color: var(--success); }
  .subtotal.aviso { background: var(--danger-soft); color: var(--danger); }
  .pos { color: var(--success); }
  .neg { color: var(--danger); }
  .suave { color: var(--ink-soft); }
  .vacio, .nota { color: var(--ink-soft); font-size: var(--text-meta); margin-top: var(--space-2); }
  small { color: var(--ink-faint); }
  .limpiar { border: 0; background: transparent; cursor: pointer; color: var(--ink-soft); font-size: var(--text-meta); text-decoration: underline; }
  .marca { margin-right: var(--space-1); }
  .pivot-toast { position: fixed; z-index: 50; bottom: calc(var(--bottom-nav-h) + var(--space-6) + var(--space-6)); inset-inline: 0; margin-inline: auto; width: fit-content; max-width: calc(100% - var(--space-6)); display: flex; align-items: center; gap: var(--space-3); background: var(--primary); color: var(--ink-on-primary); border-radius: var(--r-md); box-shadow: var(--shadow-over); padding: var(--space-2) var(--space-3); font-size: var(--text-meta); }
  .pivot-toast button { border: 0; background: transparent; color: var(--ink-on-primary); cursor: pointer; font-weight: 700; text-decoration: underline; }

  /* Presupuesto de la spec §8: el módulo respeta prefers-reduced-motion. El
     toast aparece y desaparece sin desplazamiento ni fundido para quien lo pide. */
  @media (prefers-reduced-motion: reduce) {
    .pivot-toast, .pivot-toast button { transition: none; animation: none; }
  }
</style>
