<script lang="ts">
  import { page } from '$app/state';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import CashflowChart from '$lib/components/finance/CashflowChart.svelte';
  import CategoryBars from '$lib/components/finance/CategoryBars.svelte';
  import FinanceFilterBar from '$lib/components/finance/FinanceFilterBar.svelte';
  import FinanceSparkline from '$lib/components/finance/FinanceSparkline.svelte';
  import { mergeParams, rangeLabel } from '$lib/finance/filters';
  import { deltaPct, formatCents, formatPct } from '$lib/finance/format';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const dashboard = $derived(data.dashboard);
  const summary = $derived(dashboard.summary);
  const prev = $derived(summary.prev);
  const base = $derived(`/h/${dashboard.householdId}/finanzas`);
  const empty = $derived(summary.incomeCents === '0' && summary.expenseCents === '0');

  // La serie de la sparkline es una FORMA, no dinero: Number solo para píxeles.
  const savingsSpark = $derived(dashboard.series.map((point) => Number(point.savingsCents) / 100));
  const cashflowBuckets = $derived(dashboard.series.map((point) => ({
    bucket: point.bucket,
    incomeCents: BigInt(point.incomeCents),
    expenseCents: BigInt(point.expenseCents),
    savingsCents: BigInt(point.savingsCents)
  })));

  const movementsHref = (categoryId: string): string =>
    `${base}/movimientos?${mergeParams(page.url.searchParams, { cat: categoryId })}`;

  // Los gastos viajan en céntimos NEGATIVOS (son salidas). Para el chip de
  // variación de la tarjeta «Gastos» el signo del dato no es el signo de la
  // noticia: `deltaPct` conserva el signo del valor con signo (su propio test
  // lo fija: deltaPct(-150n, -100n) === -50), así que sobre `expenseCents` tal
  // cual, gastar MENOS pintaba ▲ + naranja y gastar MÁS pintaba ▼ + verde —
  // al revés de lo que la tarjeta debe decir. `magnitude` da el valor absoluto
  // en cadena de céntimos para que la comparación sea de TAMAÑO, no de signo.
  const magnitude = (cents: string): string => {
    const value = BigInt(cents);
    return (value < 0n ? -value : value).toString();
  };

  // El rótulo sigue a la granularidad: el load pide 12 cubos, no 12 meses
  // (SERIES_MONTHS en finance.server.ts). «Últimos 12 periodos» a secas mentiría
  // en cuanto el usuario cambiara a trimestres o años.
  const SERIES_LABEL = {
    month: 'Últimos 12 meses',
    quarter: 'Últimos 12 trimestres',
    year: 'Últimos 10 años'
  } as const;
  const seriesLabel = $derived(SERIES_LABEL[dashboard.filters.granularity]);
</script>

{#snippet delta(nowCents: string, prevCents: string | undefined, invert: boolean, signedPrevCents?: string)}
  {#if prevCents !== undefined}
    {@const pct = deltaPct(BigInt(nowCents), BigInt(prevCents))}
    <!-- El tooltip rotula el importe anterior como su propia tarjeta: para
         Gastos eso es con signo negativo (`−3.550,00 €`), aunque `prevCents`
         aquí sea la MAGNITUD que usa el cálculo del pct (ver `magnitude` más
         arriba). `signedPrevCents` lleva el valor con signo cuando difiere;
         si no se pasa, `prevCents` ya es el valor real (Ingresos, Ahorro). -->
    {@const titleCents = signedPrevCents ?? prevCents}
    {#if pct === null}
      <span class="status-chip">sin periodo anterior</span>
    {:else if pct === 0}
      <!-- Igual que el periodo anterior no es ni una bajada ni un aviso. -->
      <span class="status-chip" title={`anterior: ${formatCents(titleCents)}`}>sin cambios</span>
    {:else}
      {@const good = invert ? pct < 0 : pct > 0}
      <span class="status-chip {good ? 'success' : 'warning'}" title={`anterior: ${formatCents(titleCents)}`}>
        {pct > 0 ? '▲' : '▼'} {Math.abs(pct)} %
      </span>
    {/if}
  {/if}
{/snippet}

<div class="page-wrap">
  <PageHeader eyebrow="Cuentas de la casa" title="Finanzas" support={rangeLabel(dashboard.filters)} />

  <FinanceFilterBar filters={dashboard.filters} accounts={dashboard.accounts} />

  {#if empty}
    <!-- Vacío honesto: quien llega hasta aquí SÍ puede ver; es que no hay datos.
         m9: el vacío es del PERIODO filtrado; pendingCount es de todo el hogar,
         así que el aviso de pendientes no debe desaparecer con el periodo. -->
    <article class="card quiet-card">
      <span class="card-icon" aria-hidden="true">·</span>
      <h2>No hay movimientos en este periodo</h2>
      <p>Cambia el periodo con los filtros o <a href={`${base}/importar`}>importa un extracto</a>.</p>
      {#if summary.pendingCount > 0}
        <a class="status-chip warning" href={`${base}/revision`}>{summary.pendingCount} sin revisar</a>
      {/if}
    </article>
  {:else}
    <section class="finance-kpis" aria-label="Indicadores del periodo">
      <article class="card">
        <p class="eyebrow">Ingresos</p>
        <p class="cifra kpi-pos">{formatCents(summary.incomeCents)}</p>
        {@render delta(summary.incomeCents, prev?.incomeCents, false)}
      </article>
      <article class="card">
        <p class="eyebrow">Gastos</p>
        <p class="cifra kpi-neg">{formatCents(summary.expenseCents)}</p>
        {@render delta(magnitude(summary.expenseCents), prev ? magnitude(prev.expenseCents) : undefined, true, prev?.expenseCents)}
        <p class="kpi-note">♻ {formatCents(summary.recurringExpenseCents)} · ✦ {formatCents(summary.extraordinaryExpenseCents)}{summary.unclassifiedExpenseCents !== '0' ? ` · — ${formatCents(summary.unclassifiedExpenseCents)}` : ''}</p>
      </article>
      <article class="card">
        <p class="eyebrow">Ahorro</p>
        <p class="cifra">{formatCents(summary.savingsCents)}</p>
        {@render delta(summary.savingsCents, prev?.savingsCents, false)}
        <FinanceSparkline values={savingsSpark} label="Evolución del ahorro por periodo" />
      </article>
      <article class="card">
        <p class="eyebrow">Tasa de ahorro</p>
        <p class="cifra">{formatPct(summary.netSavingsRate)}</p>
        {#if summary.pendingCount > 0}
          <a class="status-chip warning" href={`${base}/revision`}>{summary.pendingCount} sin revisar</a>
        {:else}
          <span class="status-chip success">todo revisado</span>
        {/if}
      </article>
      <article class="card">
        <p class="eyebrow">Inversión</p>
        <p class="cifra kpi-pos">{formatCents(summary.investedCents)}</p>
        <p class="kpi-note">{formatPct(summary.investmentRate)} sobre ingresos</p>
      </article>
    </section>

    <article class="card">
      <div class="section-heading"><div><p class="eyebrow">{seriesLabel}</p><h2>Flujo de caja</h2></div></div>
      <CashflowChart buckets={cashflowBuckets} />
    </article>

    <div class="content-grid">
      <article class="card">
        <div class="section-heading"><div><h2>Gasto por categoría</h2></div></div>
        <CategoryBars rows={dashboard.breakdown} categories={dashboard.categories} {movementsHref} />
      </article>
      <article class="card">
        <div class="section-heading"><div><h2>Top proveedores</h2></div></div>
        <div class="ledger-list">
          {#each dashboard.providers as provider, index (provider.provider)}
            <div>
              <span><strong>{index + 1} · {provider.providerDisplay}</strong><small>×{provider.count}</small></span>
              <strong class="cifra pequena">{formatCents(provider.totalCents)}</strong>
            </div>
          {:else}
            <div><span><strong>Sin gasto con proveedor</strong><small>No hay proveedores en este periodo.</small></span></div>
          {/each}
        </div>
      </article>
    </div>
  {/if}
</div>

<style>
  .finance-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr)); gap: var(--gap-card); }
  .finance-kpis .card { display: grid; align-content: start; gap: var(--space-1); }
  .kpi-pos { color: var(--success); }
  .kpi-neg { color: var(--danger); }
  .kpi-note { color: var(--ink-faint); font-size: var(--text-meta); }
</style>
