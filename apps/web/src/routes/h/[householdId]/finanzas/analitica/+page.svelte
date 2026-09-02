<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import FinanceFilterBar from '$lib/components/finance/FinanceFilterBar.svelte';
  import { formatCents } from '$lib/finance/format';
  import { buildNatureChartData, monthsInRange, pctOf, perMonth } from '$lib/finance/chart-data';
  import { isUuid, rangeLabel } from '$lib/finance/filters';
  import { parseIdList, serializeIdList } from '$lib/finance/pivot-state';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const a = $derived(data.analitica);

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
  const pct = (v: number | null) => (v === null ? '—' : `${v} %`);
</script>

<div class="page-wrap">
<PageHeader eyebrow="Cuentas de la casa" title="Analítica" support={rangeLabel(a.filters)} />

<FinanceFilterBar filters={a.filters} accounts={a.accounts} />
<!-- ↑ props canónicas de la fase 4: { filters: FinanceFilters; accounts: {id;name;kind}[] },
     las mismas que el Dashboard (apps/web/src/routes/h/[householdId]/finanzas/+page.svelte). -->

<section class="kpi-grid" data-testid="kpi-analitica" aria-label="Indicadores del periodo">
  <article class="kpi"><span>Ingresos</span><strong class="cifra pos">{formatCents(a.summary.incomeCents)}</strong>
    <small>♻ {formatCents(incomeRec)} · ✦ {formatCents(incomeExt)} · — {formatCents(incomeSin)}</small></article>
  <article class="kpi"><span>Gastos</span><strong class="cifra neg">{formatCents(a.summary.expenseCents)}</strong>
    <small>♻ {formatCents(a.summary.recurringExpenseCents)} · {pctOf(a.summary.recurringExpenseCents, a.summary.expenseCents)}% gasto · {pctOf(a.summary.recurringExpenseCents, a.summary.incomeCents)}% ingr<br />
      ✦ {formatCents(a.summary.extraordinaryExpenseCents)} · {pctOf(a.summary.extraordinaryExpenseCents, a.summary.expenseCents)}% gasto · {pctOf(a.summary.extraordinaryExpenseCents, a.summary.incomeCents)}% ingr</small></article>
  <article class="kpi"><span>Tasa ahorro bruta</span><strong class="cifra">{pct(a.summary.grossSavingsRate)}</strong>
    <small>{formatCents(a.summary.incomeCents + a.summary.recurringExpenseCents)} · sin extraordinarios ni inversión</small></article>
  <article class="kpi"><span>Tasa ahorro neta</span><strong class="cifra">{pct(a.summary.netSavingsRate)}</strong>
    <small>{formatCents(a.summary.savingsCents)} · gasto total, sin inversión</small></article>
  <article class="kpi"><span>Inversión</span><strong class="cifra pos">{formatCents(a.summary.investedCents)}</strong>
    <small>{pct(a.summary.investmentRate)} sobre ingreso total</small></article>
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
              <td><label><input type="checkbox" checked={!excludedEventIds.includes(ev.id)} onchange={() => toggleExcluded(ev.id)} />
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
</div>

<style>
  .kpi-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr)); gap: var(--gap-card); margin-top: var(--space-4); }
  .kpi { border: 1px solid var(--line); border-radius: var(--r-lg); background: var(--surface); padding: var(--pad-card); display: grid; gap: var(--space-1); align-content: start; }
  .kpi > span { color: var(--ink-faint); font-size: var(--text-micro); font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
  .kpi > small { color: var(--ink-soft); font-size: var(--text-meta); }
  .kpi-grid.compact .kpi { padding: var(--space-2); }
  .cifra.pos { color: var(--success); }
  .cifra.neg { color: var(--danger); }
  .media-rotulo { color: var(--ink-faint); font-size: var(--text-micro); font-weight: 700; letter-spacing: .04em; text-transform: uppercase; margin-top: var(--space-5); }
  h2 { font-size: var(--text-title); margin-top: var(--space-6); }
  h2 small { color: var(--ink-soft); font-weight: 400; font-size: var(--text-meta); margin-left: var(--space-2); }
  .vacio { color: var(--ink-soft); }
  .tabla-scroll { overflow-x: auto; border: 1px solid var(--line); border-radius: var(--r-lg); background: var(--surface); margin-top: var(--space-3); }
  .tabla-finanzas { border-collapse: collapse; width: 100%; font-size: var(--text-meta); }
  .tabla-finanzas th, .tabla-finanzas td { padding: var(--space-2) var(--space-3); border-top: 1px solid var(--line); text-align: left; white-space: nowrap; }
  .tabla-finanzas thead th { border-top: 0; color: var(--ink-faint); font-size: var(--text-micro); text-transform: uppercase; letter-spacing: .04em; }
  .tabla-finanzas .importe { text-align: right; font-variant-numeric: tabular-nums lining-nums; }
  .tabla-finanzas tr.excluida { opacity: .5; }
  .tabla-finanzas .subtotal { background: var(--canvas); font-weight: 500; }
</style>
