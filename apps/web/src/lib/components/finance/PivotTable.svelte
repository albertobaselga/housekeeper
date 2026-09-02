<script lang="ts">
  import { replaceState } from '$app/navigation';
  import { page } from '$app/state';
  import {
    buildPivotTree,
    INTERNA_DIMS,
    INVERSION_DIMS,
    type PivotDimension,
    type PivotEventGroup
  } from '@housekeeper/domain/finance';
  import { monthLabel } from '$lib/finance/chart-data';
  import { categoryPath } from '$lib/finance/breakdown';
  import { formatCents } from '$lib/finance/format';
  import {
    addDim, DIM_LABELS, moveDim, parseChips, parseDims, parseIdList, PIVOT_DIMENSIONS,
    removeDim, sameSortKey, serializeChips, serializeDims, serializeIdList, sortTree, rowMatchesChips,
    type PivotNodeLike, type PivotSortKey, type SortDir
  } from '$lib/finance/pivot-state';
  import type { AnaliticaCategory, AnaliticaEventSummary, AnaliticaPivotRow } from '$lib/finance/analitica-data';
  import PivotSearch from './PivotSearch.svelte';

  // `invAccounts` y `householdId` no se usan todavía: los consume la Task 12
  // (barra de acciones y envío de comandos). Se mantienen en la firma pública
  // del componente porque la integración de la página (Task 10, Step 3) ya
  // los pasa; svelte-check/eslint no señalan props de `$props()` sin usar en
  // este repo (no hay `noUnusedParameters`/`eslint-plugin-svelte`), así que no
  // hace falta ningún `svelte-ignore`/`eslint-disable` para mantenerlos.
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

{#snippet nodeRow(node: PivotNodeLike, kind: 'gasto' | 'ingreso' | 'evento' | 'transferencia' | 'inversion', nodeDims: readonly PivotDimension[])}
  {@const isExpanded = forceExpand || expanded.has(node.key)}
  {@const hasChildren = node.children.length > 0}
  {@const canOpen = !hasChildren && node.movs.length > 0}
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
      {@render nodeRow(child, kind, nodeDims)}
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
          {#each ingresoTree as node (node.key)}{@render nodeRow(node, 'ingreso', dims)}{/each}
          {@render subtotalRow('Subtotal ingresos', tree.subtotales.ingresos, '', '')}
        {/if}
        {#if gastoTree.length > 0}
          <tr class="banda" data-testid="pivot-banda-gastos"><td colspan={colSpan}>GASTOS</td></tr>
          {#each gastoTree as node (node.key)}{@render nodeRow(node, 'gasto', dims)}{/each}
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
            {#each event.children as child (child.key)}{@render nodeRow(child, 'evento', dims)}{/each}
          {/if}
        {/each}
        {#if displayEventos.length > 0}
          {@render subtotalRow('Subtotal eventos', tree.subtotales.eventos, '', '')}
        {/if}
        {#if internaTree.length > 0}
          <tr class="banda" data-testid="pivot-banda-internas"><td colspan={colSpan}>INTERNAS</td></tr>
          {#each internaTree as node (node.key)}{@render nodeRow(node, 'transferencia', INTERNA_DIMS)}{/each}
          {@render subtotalRow('Subtotal internas', tree.subtotales.internas,
            tree.subtotales.internas.totalCents === 0n ? 'ok' : 'warn',
            tree.subtotales.internas.totalCents === 0n ? '' : 'Con todas las cuentas seleccionadas debe sumar 0: un valor distinto indica una pata fuera del filtro de cuentas o un descuadre real.')}
        {/if}
        {#if inversionTree.length > 0}
          <tr class="banda" data-testid="pivot-banda-inversion"><td colspan={colSpan}>INVERSIÓN</td></tr>
          {#each inversionTree as node (node.key)}{@render nodeRow(node, 'inversion', INVERSION_DIMS)}{/each}
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
</style>
