<script lang="ts">
  import { monthLabel, type NatureChartPoint } from '$lib/finance/chart-data';
  import { formatCents } from '$lib/finance/format';

  let { points }: { points: NatureChartPoint[] } = $props();

  // Geometría (viewBox fijo; el ancho real lo da el contenedor).
  const W = 720;
  const H = 300;
  const PAD = { top: 12, right: 12, bottom: 28, left: 64 };
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;

  // Geometría de píxeles: convierte céntimos a euros SOLO para calcular posiciones
  // de barras y líneas; el dinero de verdad nunca sale de bigint.
  const n = (v: bigint) => Number(v) / 100;

  const maxPos = $derived(
    Math.max(
      1,
      ...points.map((p) => n(p.ingresosRecCents + p.ingresosExtCents + p.ingresosSinCents)),
      ...points.map((p) => n(p.gastosRecCents + p.gastosExtCents + p.gastosSinCents)),
      ...points.map((p) => n(p.inversionCents)),
      ...points.map((p) => n(p.ahorroBrutoCents))
    )
  );
  const minNeg = $derived(Math.min(0, ...points.map((p) => n(p.ahorroNetoCents))));
  const y = $derived((euros: number) => PAD.top + ((maxPos - euros) / (maxPos - minNeg)) * innerH);
  const slotW = $derived(points.length ? innerW / points.length : innerW);
  const barW = $derived(Math.min(18, slotW / 4));
  const xSlot = (i: number) => PAD.left + i * slotW;

  interface Segment { x: number; yTop: number; h: number; fill: string; name: string; cents: bigint }
  function stack(x: number, parts: { cents: bigint; fill: string; name: string }[]): Segment[] {
    let acc = 0;
    const out: Segment[] = [];
    for (const part of parts) {
      const h = (n(part.cents) / (maxPos - minNeg)) * innerH;
      out.push({ x, yTop: y(acc + n(part.cents)), h, fill: part.fill, name: part.name, cents: part.cents });
      acc += n(part.cents);
    }
    return out;
  }

  const bars = $derived(
    points.map((p, i) => ({
      point: p,
      gastos: stack(xSlot(i) + slotW / 2 - barW * 1.6, [
        { cents: p.gastosRecCents, fill: 'var(--danger)', name: 'Gastos ♻' },
        { cents: p.gastosExtCents, fill: 'var(--danger-soft)', name: 'Gastos ✦' },
        { cents: p.gastosSinCents, fill: 'var(--line-strong)', name: 'Gastos sin clasificar' }
      ]),
      ingresos: stack(xSlot(i) + slotW / 2 - barW * 0.5, [
        { cents: p.ingresosRecCents, fill: 'var(--success)', name: 'Ingresos ♻' },
        { cents: p.ingresosExtCents, fill: 'var(--success-soft)', name: 'Ingresos ✦' },
        { cents: p.ingresosSinCents, fill: 'var(--line-strong)', name: 'Ingresos sin clasificar' }
      ]),
      inversion: stack(xSlot(i) + slotW / 2 + barW * 0.6, [
        { cents: p.inversionCents, fill: 'var(--accent)', name: 'Inversión' }
      ])
    }))
  );

  const lineOf = (value: (p: NatureChartPoint) => bigint) =>
    points.map((p, i) => `${xSlot(i) + slotW / 2},${y(n(value(p)))}`).join(' ');
  const netoLine = $derived(lineOf((p) => p.ahorroNetoCents));
  const brutoLine = $derived(lineOf((p) => p.ahorroBrutoCents));
</script>

<figure class="nature-chart">
  <svg viewBox="0 0 {W} {H}" role="img" aria-label="Evolución mensual por naturaleza con ahorro neto y bruto">
    <line x1={PAD.left} y1={y(0)} x2={W - PAD.right} y2={y(0)} class="axis" />
    {#each bars as b, i}
      {#each [...b.gastos, ...b.ingresos, ...b.inversion] as seg}
        {#if seg.cents !== 0n}
          <rect x={seg.x} y={seg.yTop} width={barW} height={Math.max(1, seg.h)} fill={seg.fill}>
            <title>{monthLabel(b.point.month)} · {seg.name}: {formatCents(seg.cents)}</title>
          </rect>
        {/if}
      {/each}
      <text x={xSlot(i) + slotW / 2} y={H - 8} text-anchor="middle" class="tick">{monthLabel(b.point.month)}</text>
    {/each}
    {#if points.length > 1}
      <polyline points={netoLine} class="line-neto" />
      <polyline points={brutoLine} class="line-bruto" />
    {/if}
    <!-- maxPos ya es euros de geometría (Number, ver `n` arriba); se redondea y
         se vuelve a céntimos SOLO para reutilizar formatCents en la etiqueta del
         eje, nunca como dinero derivado. -->
    <text x={PAD.left - 6} y={PAD.top + 8} text-anchor="end" class="tick">{formatCents(BigInt(Math.round(maxPos)) * 100n)}</text>
    <text x={PAD.left - 6} y={y(0) + 4} text-anchor="end" class="tick">0 €</text>
  </svg>
  <!-- La tabla sr-only va ANTES que figcaption: un <figcaption> debe ser el
       primer o el último hijo de <figure> (a11y_figcaption_index). -->
  <table class="sr-only">
    <caption>Evolución mensual por naturaleza y ahorro, por mes</caption>
    <thead>
      <tr>
        <th>Mes</th>
        <th>Ingresos recurrentes</th>
        <th>Ingresos extraordinarios</th>
        <th>Ingresos sin clasificar</th>
        <th>Gastos recurrentes</th>
        <th>Gastos extraordinarios</th>
        <th>Gastos sin clasificar</th>
        <th>Inversión</th>
        <th>Ahorro bruto</th>
        <th>Ahorro neto</th>
      </tr>
    </thead>
    <tbody>
      {#each points as p (p.month)}
        <tr>
          <td>{monthLabel(p.month)}</td>
          <td>{formatCents(p.ingresosRecCents)}</td>
          <td>{formatCents(p.ingresosExtCents)}</td>
          <td>{formatCents(p.ingresosSinCents)}</td>
          <td>{formatCents(p.gastosRecCents)}</td>
          <td>{formatCents(p.gastosExtCents)}</td>
          <td>{formatCents(p.gastosSinCents)}</td>
          <td>{formatCents(p.inversionCents)}</td>
          <td>{formatCents(p.ahorroBrutoCents)}</td>
          <td>{formatCents(p.ahorroNetoCents)}</td>
        </tr>
      {/each}
    </tbody>
  </table>
  <figcaption class="nature-legend">
    <span><i class="dot gasto" aria-hidden="true"></i> Gastos ♻/✦/—</span>
    <span><i class="dot ingreso" aria-hidden="true"></i> Ingresos ♻/✦/—</span>
    <span><i class="dot inversion" aria-hidden="true"></i> Inversión</span>
    <span><i class="dash neto" aria-hidden="true"></i> Ahorro neto</span>
    <span><i class="dash bruto" aria-hidden="true"></i> Ahorro bruto</span>
  </figcaption>
</figure>

<style>
  .nature-chart { margin: 0; }
  .nature-chart svg { width: 100%; height: auto; }
  .axis { stroke: var(--line-strong); }
  .tick { font-size: var(--text-micro); fill: var(--ink-faint); font-variant-numeric: tabular-nums; }
  .line-neto { fill: none; stroke: var(--ink); stroke-width: 2; }
  .line-bruto { fill: none; stroke: var(--accent); stroke-width: 2; stroke-dasharray: 5 4; }
  .nature-legend { display: flex; flex-wrap: wrap; gap: var(--space-3); font-size: var(--text-meta); color: var(--ink-soft); margin-top: var(--space-2); }
  .dot, .dash { display: inline-block; width: var(--space-3); height: var(--space-2); border-radius: var(--r-sm); }
  .dot.gasto { background: var(--danger); }
  .dot.ingreso { background: var(--success); }
  .dot.inversion { background: var(--accent); }
  .dash { height: 0; border-top: 2px dashed var(--accent); border-radius: 0; }
  .dash.neto { border-top: 2px solid var(--ink); }
</style>
