<script lang="ts">
  import { natureStackLayout, type NatureBucketInput } from '$lib/finance/chart-geometry';
  import { formatCents } from '$lib/finance/format';

  let { buckets }: { buckets: NatureBucketInput[] } = $props();

  // `layout` son coordenadas y anchos en píxeles del viewBox: geometría de
  // presentación (Task 3), no dinero. Los céntimos de `buckets` solo llegan a
  // esta plantilla vía `formatCents` sobre el bigint, jamás convertidos aquí.
  const layout = $derived(natureStackLayout(buckets));

  // Naturaleza → token. Nada de terracota: está reservada a «ahora».
  const NATURE_FILL: Record<string, string> = {
    recurrente: 'var(--primary)',
    extraordinario: 'var(--info)',
    sin: 'var(--line-strong)'
  };
</script>

{#if buckets.length === 0}
  <p class="audit-note">No hay gasto en este periodo.</p>
{:else}
  <figure class="naturestack">
    <svg viewBox="0 0 {layout.width} {layout.height}" role="img"
      aria-label="Gasto apilado por naturaleza y línea de ahorro">
      {#each layout.ticks as tick (tick.value)}
        <line x1={layout.plot.left} x2={layout.plot.right} y1={tick.y} y2={tick.y} stroke="var(--line)" />
        <text class="naturestack-tick" x={layout.plot.left - 8} y={tick.y + 4} text-anchor="end">{tick.label}</text>
      {/each}
      {#each layout.groups as group (group.label)}
        {#each group.segments as segment (segment.nature)}
          <rect x={segment.bar.x} y={segment.bar.y} width={segment.bar.width} height={segment.bar.height} rx="2"
            fill={NATURE_FILL[segment.nature] ?? 'var(--line-strong)'} />
        {/each}
        <text class="naturestack-tick" x={group.centerX} y={layout.height - 6} text-anchor="middle">{group.label}</text>
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
      <caption>Gasto por naturaleza y ahorro, por periodo</caption>
      <thead><tr><th>Periodo</th><th>Recurrente</th><th>Extraordinario</th><th>Sin clasificar</th><th>Ahorro</th></tr></thead>
      <tbody>
        {#each buckets as bucket (bucket.bucket)}
          <tr>
            <td>{bucket.bucket}</td>
            <td>{formatCents(bucket.recurringCents)}</td>
            <td>{formatCents(bucket.extraordinaryCents)}</td>
            <td>{formatCents(bucket.unclassifiedCents)}</td>
            <td>{formatCents(bucket.savingsCents)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
    <figcaption class="naturestack-legend">
      <span><i class="dot recurrente" aria-hidden="true"></i>Recurrente</span>
      <span><i class="dot extraordinario" aria-hidden="true"></i>Extraordinario</span>
      <span><i class="dot sin" aria-hidden="true"></i>Sin clasificar</span>
      <span><i class="dot ahorro" aria-hidden="true"></i>Ahorro</span>
    </figcaption>
  </figure>
{/if}

<style>
  .naturestack { margin: 0; }
  .naturestack svg { width: 100%; height: auto; }
  .naturestack-tick { font-size: var(--text-micro); fill: var(--ink-faint); }
  .naturestack-legend { display: flex; flex-wrap: wrap; gap: var(--space-4); margin-top: var(--space-2); color: var(--ink-soft); font-size: var(--text-meta); }
  .naturestack-legend span { display: inline-flex; align-items: center; gap: var(--space-1); }
  .dot { width: .6em; height: .6em; border-radius: var(--r-full); }
  .dot.recurrente { background: var(--primary); }
  .dot.extraordinario { background: var(--info); }
  .dot.sin { background: var(--line-strong); }
  .dot.ahorro { background: var(--ink); }
</style>
