<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import FinanceNav from '$lib/components/finance/FinanceNav.svelte';
  import FinanceFilterBar from '$lib/components/finance/FinanceFilterBar.svelte';
  import NatureStackChart from '$lib/components/finance/NatureStackChart.svelte';
  import PivotTable from '$lib/components/finance/PivotTable.svelte';
  import FinanceDetailPanel from '$lib/components/finance/FinanceDetailPanel.svelte';
  import { formatCents, formatPct } from '$lib/finance/format';
  import {
    buildNatureChartData,
    monthLabel,
    monthsInRange,
    pctOf,
    perMonth,
    SUMMARY_ROWS
  } from '$lib/finance/chart-data';
  import { isUuid, rangeLabel } from '$lib/finance/filters';
  import { parseIdList, serializeIdList } from '$lib/finance/pivot-state';
  // `FinanceDetailMode` vive en el módulo `.ts` de la fase 4 (`$lib/finance/api`),
  // no en `FinanceDetailPanel.svelte`: el nombre del tipo es el canónico, solo
  // cambia el módulo del que se importa (nota del brief de la Task 10).
  import type { FinanceDetailMode } from '$lib/finance/api';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const a = $derived(data.analitica);

  let recurrence = $state<'recurrente' | 'extraordinario' | null>(null);
  let panel = $state<FinanceDetailMode | null>(null);
  const pivotRows = $derived(a.pivotRows.filter((r) => !recurrence || r.nat === recurrence));

  // Partidas excluidas de KPIs y gráfica: ?exev= (CSV), navegación real porque
  // los KPIs se recalculan en el servidor. Filtrado por isUuid igual que el
  // servidor (+page.server.ts, Ruling R24): con `?exev=basura` el rótulo de
  // abajo no debe anunciar una exclusión que el servidor ignora.
  const excludedEventIds = $derived(parseIdList(page.url.searchParams.get('exev')).filter(isUuid));
  function toggleExcluded(id: string): void {
    const next = excludedEventIds.includes(id)
      ? excludedEventIds.filter((x) => x !== id)
      : [...excludedEventIds, id];
    const url = new URL(page.url);
    const param = serializeIdList(next);
    if (param) url.searchParams.set('exev', param);
    else url.searchParams.delete('exev');
    void goto(url, { replaceState: true, noScroll: true, keepFocus: true });
  }

  const monthCount = $derived(monthsInRange(a.from, a.to));
  const chartPoints = $derived(buildNatureChartData(a.months, a.analyticsRows));
  const incomeRec = $derived(chartPoints.reduce((s, p) => s + p.ingresosRecCents, 0n));
  const incomeExt = $derived(chartPoints.reduce((s, p) => s + p.ingresosExtCents, 0n));
  const incomeSin = $derived(chartPoints.reduce((s, p) => s + p.ingresosSinCents, 0n));

  const selP = $derived(a.eventsSummary.filter((e) => !excludedEventIds.includes(e.id)));
  const noselP = $derived(a.eventsSummary.filter((e) => excludedEventIds.includes(e.id)));
  const sum = (list: typeof a.eventsSummary, k: 'netCents' | 'incomeCents' | 'expenseCents') =>
    list.reduce((acc, e) => acc + e[k], 0n);
  // F6-S1: los porcentajes de la Analítica salían con punto decimal («35.3 %»)
  // frente a la coma del Dashboard porque esta pantalla se había declarado un
  // `pct` local. `formatPct` de $lib/finance/format ya formatea con
  // `toLocaleString('es-ES')` y ya lo usa el Dashboard: única definición.
</script>

<div class="page-wrap">
<PageHeader eyebrow="Cuentas de la casa" title="Analítica" support={rangeLabel(a.filters)} />
<FinanceNav pendingReviewCount={data.pendingReviewCount} />

<FinanceFilterBar filters={a.filters} accounts={a.accounts} />
<!-- ↑ props canónicas de la fase 4: { filters: FinanceFilters; accounts: {id;name;kind}[] },
     las mismas que el Dashboard (apps/web/src/routes/h/[householdId]/finanzas/+page.svelte). -->

<section class="kpi-grid" data-testid="kpi-analitica" aria-label="Indicadores del periodo">
  <article class="kpi"><span>Ingresos</span><strong class="cifra pos">{formatCents(a.summary.incomeCents)}</strong>
    <small>♻ {formatCents(incomeRec)} · ✦ {formatCents(incomeExt)} · — {formatCents(incomeSin)}</small></article>
  <article class="kpi"><span>Gastos</span><strong class="cifra neg">{formatCents(a.summary.expenseCents)}</strong>
    <small>♻ {formatCents(a.summary.recurringExpenseCents)} · {pctOf(a.summary.recurringExpenseCents, a.summary.expenseCents)}% gasto · {pctOf(a.summary.recurringExpenseCents, a.summary.incomeCents)}% ingr<br />
      ✦ {formatCents(a.summary.extraordinaryExpenseCents)} · {pctOf(a.summary.extraordinaryExpenseCents, a.summary.expenseCents)}% gasto · {pctOf(a.summary.extraordinaryExpenseCents, a.summary.incomeCents)}% ingr</small></article>
  <article class="kpi"><span>Tasa ahorro bruta</span><strong class="cifra">{formatPct(a.summary.grossSavingsRate)}</strong>
    <small>{formatCents(a.summary.incomeCents + a.summary.recurringExpenseCents)} · sin extraordinarios ni inversión</small></article>
  <article class="kpi"><span>Tasa ahorro neta</span><strong class="cifra">{formatPct(a.summary.netSavingsRate)}</strong>
    <small>{formatCents(a.summary.savingsCents)} · gasto total, sin inversión</small></article>
  <article class="kpi"><span>Inversión</span><strong class="cifra pos">{formatCents(a.summary.investedCents)}</strong>
    <small>{formatPct(a.summary.investmentRate)} sobre ingreso total</small></article>
  <article class="kpi"><span>Free cash flow</span>
    <strong class="cifra {a.summary.freeCashFlowCents >= 0n ? 'pos' : 'neg'}">{formatCents(a.summary.freeCashFlowCents)}</strong>
    <small>{a.summary.freeCashFlowCents >= 0n ? 'caja generada' : 'caja destruida'} · ingresos − gastos − inversión</small></article>
  <article class="kpi"><span>Ops cash flow</span>
    <strong class="cifra {a.summary.opsCashFlowCents >= 0n ? 'pos' : 'neg'}">{formatCents(a.summary.opsCashFlowCents)}</strong>
    <small>free cash flow + inversión (líquida si se necesita)</small></article>
  {#if a.summary.receivedContributionsCents > 0n}
    <article class="kpi"><span>Aportaciones recibidas</span><strong class="cifra pos">{formatCents(a.summary.receivedContributionsCents)}</strong>
      <small>de otras cuentas propias · cuenta como ingreso</small></article>
  {/if}
  {#if a.summary.outgoingTransfersCents < 0n}
    <article class="kpi"><span>Traspasos / ahorro</span><strong class="cifra">{formatCents(a.summary.outgoingTransfersCents)}</strong>
      <small>movido a otras cuentas propias · no es gasto</small></article>
  {/if}
</section>

<p class="media-rotulo">Media mensual · {monthCount} {monthCount === 1 ? 'mes' : 'meses'} completos</p>
<section class="kpi-grid compact" aria-label="Medias mensuales">
  <article class="kpi"><span>Ingresos/mes</span><strong class="cifra pos">{formatCents(perMonth(a.summary.incomeCents, monthCount))}</strong></article>
  <article class="kpi"><span>Gastos/mes</span><strong class="cifra neg">{formatCents(perMonth(a.summary.expenseCents, monthCount))}</strong></article>
  <article class="kpi"><span>Ahorro/mes</span><strong class="cifra {a.summary.savingsCents >= 0n ? 'pos' : 'neg'}">{formatCents(perMonth(a.summary.savingsCents, monthCount))}</strong></article>
  <article class="kpi"><span>Inversión/mes</span><strong class="cifra pos">{formatCents(perMonth(a.summary.investedCents, monthCount))}</strong></article>
  <article class="kpi"><span>Free CF/mes</span><strong class="cifra">{formatCents(perMonth(a.summary.freeCashFlowCents, monthCount))}</strong></article>
  <article class="kpi"><span>Ops CF/mes</span><strong class="cifra">{formatCents(perMonth(a.summary.opsCashFlowCents, monthCount))}</strong></article>
</section>

<section aria-labelledby="partidas-titulo">
  <h2 id="partidas-titulo">Partidas
    {#if excludedEventIds.length > 0}
      <small>{excludedEventIds.length} {excludedEventIds.length === 1 ? 'partida excluida' : 'partidas excluidas'} de los KPIs</small>
    {/if}
  </h2>
  {#if a.eventsSummary.length === 0}
    <p class="vacio">Todavía no hay partidas: créalas desde la tabla del pivot.</p>
  {:else}
    <div class="tabla-scroll">
      <table class="tabla-finanzas" data-testid="partidas-tabla">
        <thead><tr><th>Partida</th><th class="importe">Total</th><th class="importe">Ingresos</th><th class="importe">Gastos</th></tr></thead>
        <tbody>
          {#each a.eventsSummary as ev (ev.id)}
            <tr class:excluida={excludedEventIds.includes(ev.id)}>
              <!--
                [F5-INT-1, despacho de cierre — excepción acotada]
                `mobile-densidad.dbe2e.ts` mide, para un checkbox, el `<label>`
                que lo envuelve: sin altura propia esta etiqueta salía a 179×17,
                por debajo del piso de 44 px (A3). Este fichero no está en la
                lista de permitidos de esta tarea (Importar/api.ts/calendar/
                LedgerTable/EventPicker/PivotTable/PivotSearch), pero tampoco lo
                reclama ninguna otra tarea de la ola (T15 lo excluye
                igual que lo excluye T16) y F5-INT-1 exige el dbe2e en VERDE en
                TODAS las rutas: una única clase, sin tocar lógica ni `load`.
                Anotado en el informe.
              -->
              <td><label class="evento-toggle"><input type="checkbox" checked={!excludedEventIds.includes(ev.id)} onchange={() => toggleExcluded(ev.id)} />
                🎉 {ev.name} <small>({ev.txCount})</small></label></td>
              <td class="importe cifra {ev.netCents >= 0n ? 'pos' : 'neg'}">{formatCents(ev.netCents)}</td>
              <td class="importe cifra pos">{formatCents(ev.incomeCents)}</td>
              <td class="importe cifra neg">{formatCents(ev.expenseCents)}</td>
            </tr>
          {/each}
        </tbody>
        <tfoot>
          {#each [
            { label: 'Seleccionado', list: selP, strong: false },
            { label: 'No seleccionado', list: noselP, strong: false },
            { label: 'Total', list: a.eventsSummary, strong: true }
          ] as foot (foot.label)}
            <tr class="subtotal">
              <td>{#if foot.strong}<strong>{foot.label}</strong>{:else}{foot.label}{/if}</td>
              <td class="importe cifra {sum(foot.list, 'netCents') >= 0n ? 'pos' : 'neg'}">{formatCents(sum(foot.list, 'netCents'))}</td>
              <td class="importe cifra pos">{formatCents(sum(foot.list, 'incomeCents'))}</td>
              <td class="importe cifra neg">{formatCents(sum(foot.list, 'expenseCents'))}</td>
            </tr>
          {/each}
        </tfoot>
      </table>
    </div>
  {/if}
</section>

{#if chartPoints.length === 0 || a.pivotRows.length === 0}
  <p class="vacio">No hay movimientos en este periodo.</p>
{:else}
  <section aria-labelledby="evolucion-titulo">
    <h2 id="evolucion-titulo">Evolución</h2>
    <div class="tarjeta"><NatureStackChart points={chartPoints} /></div>
  </section>

  <section aria-labelledby="resumen-titulo">
    <h2 id="resumen-titulo">Resumen mensual <small>media sobre {monthCount} {monthCount === 1 ? 'mes completo' : 'meses completos'}</small></h2>
    <div class="tabla-scroll">
      <table class="tabla-finanzas" data-testid="resumen-mensual">
        <thead>
          <tr>
            <th>Concepto</th>
            {#each chartPoints as p (p.month)}<th class="importe">{monthLabel(p.month)}</th>{/each}
            <th class="importe">Acumulado</th>
            <th class="importe">Media/mes</th>
          </tr>
        </thead>
        <tbody>
          {#each SUMMARY_ROWS as row (row.label)}
            {@const total = chartPoints.reduce((acc, p) => acc + row.value(p), 0n)}
            <tr class:destacada={row.strong} class:separada={row.sep}>
              <td>{row.label}</td>
              {#each chartPoints as p (p.month)}
                <td class="importe cifra {row.cls}">{formatCents(row.value(p))}</td>
              {/each}
              <td class="importe cifra {row.cls}"><strong>{formatCents(total)}</strong></td>
              <td class="importe cifra {row.cls}"><strong>{formatCents(perMonth(total, monthCount))}</strong></td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </section>

  <section aria-labelledby="pivot-titulo">
    <h2 id="pivot-titulo">Categorías</h2>
    <div class="chips-naturaleza" role="group" aria-label="Filtrar por naturaleza">
      <button type="button" class="chip" class:activa={recurrence === null} onclick={() => (recurrence = null)}>Todos</button>
      <button type="button" class="chip" class:activa={recurrence === 'recurrente'} onclick={() => (recurrence = 'recurrente')}>♻ Recurrente</button>
      <button type="button" class="chip" class:activa={recurrence === 'extraordinario'} onclick={() => (recurrence = 'extraordinario')}>✦ Extraordinario</button>
    </div>
    {#if pivotRows.length === 0}
      <!-- F6-M1: el guard de vacío de PivotTable solo mira la búsqueda, así que
           filtrar por naturaleza sin coincidencias dejaba la tabla con la banda
           EVENTOS sola y sin explicar por qué. El filtro de naturaleza vive
           aquí, así que aquí se explica. -->
      <p class="vacio">Sin movimientos con esa naturaleza en el rango.</p>
    {:else}
    <PivotTable
      rows={pivotRows}
      months={a.months}
      categories={a.categories}
      events={a.eventsSummary}
      invAccounts={a.invAccounts}
      householdId={page.params.householdId ?? ''}
      onOpenIds={(ids, label, sub) => (panel = { kind: 'ids', ids, label, sub })}
    />
    {/if}
  </section>

  {#if panel}
    <FinanceDetailPanel mode={panel} householdId={page.params.householdId ?? ''}
      live={!data.demo} onClose={() => (panel = null)} />
  {/if}
{/if}
</div>

<style>
  .kpi-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr)); gap: var(--gap-card); margin-top: var(--space-4); }
  .kpi { border: 1px solid var(--line); border-radius: var(--r-lg); background: var(--surface); padding: var(--pad-card); display: grid; gap: var(--space-1); align-content: start; }
  .kpi > span { color: var(--ink-faint); font-size: var(--text-micro); font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
  .kpi > small { color: var(--ink-soft); font-size: var(--text-meta); }
  .kpi-grid.compact .kpi { padding: var(--space-2); }
  .cifra.pos { color: var(--success); }
  .cifra.neg { color: var(--danger); }
  /*
    [F5-INT-1, despacho de cierre — misma excepción acotada que `.evento-toggle`]
    `mobile-densidad.dbe2e.ts` A5 (máximo 3 pesos por pantalla) solo se
    alcanzaba a comprobar en esta ruta desde que A3/A4 dejaron de fallar
    antes: un `<strong>` SIN su propia clase, dentro de una celda `.cifra`
    (peso 700), hereda ese 700 y el `strong` del UA de Chromium no es
    `font-weight: bold` sino `bolder` (RELATIVO) — la tabla CSS de «bolder»
    manda 700→900, así que «Resumen mensual» sumaba un cuarto peso a la
    pantalla sin que ninguna regla de este fichero lo pidiera nunca. La cifra
    YA se veía en negrita (700, la de `.cifra`); esto solo hace explícito el
    peso que el diseño siempre quiso, sin escalarlo por herencia.
  */
  .cifra strong { font-weight: 700; }
  .media-rotulo { color: var(--ink-faint); font-size: var(--text-micro); font-weight: 700; letter-spacing: .04em; text-transform: uppercase; margin-top: var(--space-5); }
  h2 { font-size: var(--text-title); margin-top: var(--space-6); }
  h2 small { color: var(--ink-soft); font-weight: 400; font-size: var(--text-meta); margin-left: var(--space-2); }
  .vacio { color: var(--ink-soft); }
  .tabla-scroll { overflow-x: auto; border: 1px solid var(--line); border-radius: var(--r-lg); background: var(--surface); margin-top: var(--space-3); }
  .tabla-finanzas { border-collapse: collapse; width: 100%; font-size: var(--text-meta); }
  .tabla-finanzas th, .tabla-finanzas td { padding: var(--space-2) var(--space-3); border-top: 1px solid var(--line); text-align: left; white-space: nowrap; }
  /* [F5-INT-1] Ver el comentario junto al marcado: la MARCA nativa mide
     13×13, la diana real es el `<label>` que la envuelve. */
  .evento-toggle { display: inline-flex; align-items: center; gap: var(--space-1); min-height: var(--row-data); }
  .tabla-finanzas thead th { border-top: 0; color: var(--ink-faint); font-size: var(--text-micro); text-transform: uppercase; letter-spacing: .04em; }
  .tabla-finanzas .importe { text-align: right; font-variant-numeric: tabular-nums lining-nums; }
  .tabla-finanzas tr.excluida { opacity: .5; }
  .tabla-finanzas .subtotal { background: var(--canvas); font-weight: 500; }
  .tarjeta { border: 1px solid var(--line); border-radius: var(--r-lg); background: var(--surface); padding: var(--pad-card); margin-top: var(--space-3); }
  .tabla-finanzas tr.destacada { background: var(--canvas); font-weight: 700; }
  .tabla-finanzas tr.separada td { border-top: 2px solid var(--line-strong); }
  .chips-naturaleza { display: flex; gap: var(--space-2); margin: var(--space-2) 0; flex-wrap: wrap; }
  .chip { border: 1px solid var(--line); border-radius: var(--r-full); background: var(--surface); padding: var(--space-1) var(--space-2); font-size: var(--text-meta); cursor: pointer; }
  .chip.activa { border-color: var(--primary); background: var(--primary-soft); font-weight: 700; }
</style>
