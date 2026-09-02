<script lang="ts">
  import { sparklinePoints } from '$lib/finance/chart-geometry';

  // `values` son puntos de presentación (una serie ya en euros o en la unidad
  // que el llamante decida para dibujar); nunca céntimos ni dinero real: la
  // geometría solo los usa para escalar la línea dentro del viewBox 100×32.
  let { values, label, stroke = 'var(--success)' }: { values: number[]; label: string; stroke?: string } = $props();

  const points = $derived(sparklinePoints(values));
</script>

{#if points}
  <svg class="finance-sparkline" viewBox="0 0 100 32" role="img" aria-label={label}>
    <polyline {points} fill="none" {stroke} stroke-width="1.8" stroke-linejoin="round" />
  </svg>
{/if}

<style>
  .finance-sparkline { width: 6.25rem; height: 2rem; }
</style>
