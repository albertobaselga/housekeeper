<script lang="ts">
  import { cashflowLayout, type CashflowBucketInput } from '$lib/finance/chart-geometry';
  import { formatCents } from '$lib/finance/format';

  let { buckets }: { buckets: CashflowBucketInput[] } = $props();

  // `layout` son coordenadas y anchos en píxeles del viewBox: geometría de
  // presentación (Task 3), no dinero. Los céntimos de `buckets` solo llegan a
  // esta plantilla vía `formatCents` sobre el bigint, jamás convertidos aquí.
  const layout = $derived(cashflowLayout(buckets));
</script>

{#if buckets.length === 0}
  <p class="audit-note">No hay movimientos en este periodo.</p>
{:else}
  <figure class="cashflow">
    <svg viewBox="0 0 {layout.width} {layout.height}" role="img"
      aria-label="Flujo de caja: barras de ingresos y gastos por periodo y línea de ahorro">
      {#each layout.ticks as tick (tick.value)}
        <line x1={layout.plot.left} x2={layout.plot.right} y1={tick.y} y2={tick.y} stroke="var(--line)" />
        <text class="cashflow-tick" x={layout.plot.left - 8} y={tick.y + 4} text-anchor="end">{tick.label}</text>
      {/each}
      {#each layout.groups as group (group.label)}
        <rect x={group.income.x} y={group.income.y} width={group.income.width} height={group.income.height} rx="2" fill="var(--success)" />
        <rect x={group.expense.x} y={group.expense.y} width={group.expense.width} height={group.expense.height} rx="2" fill="var(--danger)" />
        <text class="cashflow-tick" x={group.centerX} y={layout.height - 6} text-anchor="middle">{group.label}</text>
      {/each}
      <polyline points={layout.savings.map((point) => `${point.x},${point.y}`).join(' ')}
        fill="none" stroke="var(--ink)" stroke-width="2" stroke-linejoin="round" />
      {#each layout.savings as point, index (index)}
        <circle cx={point.x} cy={point.y} r="2.5" fill="var(--ink)" />
      {/each}
    </svg>
    <!-- La tabla sr-only va ANTES que figcaption: un <figcaption> debe ser el
         primer o el último hijo de <figure> (a11y_figcaption_index). -->
    <table class="sr-only">
      <caption>Flujo de caja por periodo</caption>
      <thead><tr><th>Periodo</th><th>Ingresos</th><th>Gastos</th><th>Ahorro</th></tr></thead>
      <tbody>
        {#each buckets as bucket (bucket.bucket)}
          <tr>
            <td>{bucket.bucket}</td>
            <td>{formatCents(bucket.incomeCents)}</td>
            <td>{formatCents(bucket.expenseCents)}</td>
            <td>{formatCents(bucket.savingsCents)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
    <figcaption class="cashflow-legend">
      <span><i class="dot ingresos" aria-hidden="true"></i>Ingresos</span>
      <span><i class="dot gastos" aria-hidden="true"></i>Gastos</span>
      <span><i class="dot ahorro" aria-hidden="true"></i>Ahorro</span>
    </figcaption>
  </figure>
{/if}

<style>
  .cashflow { margin: 0; }
  .cashflow svg { width: 100%; height: auto; }
  .cashflow-tick { font-size: var(--text-micro); fill: var(--ink-faint); }
  .cashflow-legend { display: flex; gap: var(--space-4); margin-top: var(--space-2); color: var(--ink-soft); font-size: var(--text-meta); }
  .cashflow-legend span { display: inline-flex; align-items: center; gap: var(--space-1); }
  .dot { width: .6em; height: .6em; border-radius: var(--r-full); }
  .dot.ingresos { background: var(--success); }
  .dot.gastos { background: var(--danger); }
  .dot.ahorro { background: var(--ink); }
</style>
