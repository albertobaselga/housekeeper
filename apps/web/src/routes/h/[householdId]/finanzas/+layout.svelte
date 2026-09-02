<script lang="ts">
  import { page } from '$app/state';
  import type { Snippet } from 'svelte';
  import type { LayoutData } from './$types';

  let { data, children }: { data: LayoutData; children: Snippet } = $props();

  const SECTIONS = [
    ['', 'Dashboard'], ['analitica', 'Analítica'], ['movimientos', 'Movimientos'],
    ['revision', 'Revisión'], ['eventos', 'Eventos'], ['importar', 'Importar'], ['ajustes', 'Ajustes']
  ] as const;

  const base = $derived(`/h/${page.params.householdId}/finanzas`);
</script>

<nav class="finance-nav" aria-label="Secciones de Finanzas">
  {#each SECTIONS as [slug, label] (slug)}
    {@const href = slug ? `${base}/${slug}` : base}
    <a {href} aria-current={page.url.pathname === href ? 'page' : undefined}>
      {label}{#if slug === 'revision' && data.pendingReviewCount > 0}<span class="status-chip revision-badge">{data.pendingReviewCount}</span>{/if}
    </a>
  {/each}
</nav>

{@render children()}

<style>
  /* FUERA de `.page-wrap` (cada pantalla dibuja el suyo): el mismo margen que
     `.install-banner`/`.push-banner` para no pegarse al borde del contenido.
     UNA sola línea (`.employment-tabs`, mismo patrón): `flex-wrap: wrap` con
     `overflow-x: auto` es contradictorio —el navegador envuelve en vez de
     desbordar— y siete etiquetas partidas en dos o tres líneas se comen el
     presupuesto de marco de mobile-densidad.dbe2e.ts en las siete rutas. */
  .finance-nav {
    display: flex;
    flex-wrap: nowrap;
    gap: var(--space-2);
    overflow-x: auto;
    scrollbar-width: none;
    -webkit-overflow-scrolling: touch;
    margin: var(--pad-page-y) var(--pad-page-x) 0;
    mask-image: linear-gradient(to right, #000 0, #000 calc(100% - var(--space-6)), transparent 100%);
  }
  .finance-nav::-webkit-scrollbar { display: none; }
  .finance-nav a {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    min-height: var(--row-data);
    border-radius: var(--r-sm);
    padding: var(--space-1) var(--space-3);
    color: var(--ink-soft);
    font-weight: 500;
    text-decoration: none;
    white-space: nowrap;
    touch-action: manipulation;
  }
  .finance-nav a[aria-current='page'] {
    background: var(--surface-strong);
    color: var(--primary);
    font-weight: 700;
  }
  .revision-badge { margin-inline-start: var(--space-1); }
</style>
