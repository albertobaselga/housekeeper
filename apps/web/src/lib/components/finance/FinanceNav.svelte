<script lang="ts">
  import { page } from '$app/state';

  /**
   * Navegación de las siete pantallas del módulo — antes vivía en
   * `finanzas/+layout.svelte`, como un `<nav>` compartido pintado POR ENCIMA
   * de `{@render children()}`.
   *
   * [FASE 5, T10 · corrección Important 1] Ese `<nav>` de layout quedaba
   * FUERA del `.page-wrap` que dibuja cada pantalla, así que su alto se sumaba
   * al «marco» que mide `mobile-densidad.dbe2e.ts` (`firstContentTop`) en las
   * SIETE rutas de Finanzas — regresión medida y declarada en el informe de
   * la tarea (106/125 px de base + ~56 px de barra, contra un presupuesto de
   * 142 px a 320×568). Aquí, cada página la importa y la pinta DENTRO de su
   * `.page-wrap`, justo después de `PageHeader` — el mismo sitio en el que
   * vive `EmploymentTabs.svelte` en `employment/*`, que por eso nunca tuvo
   * este problema: colocada ahí, la barra ES el primer contenido no-cabecera
   * (`content[0]` de la prueba), así que su TOP no se mueve respecto de la
   * línea base sin barra — solo desplaza lo que viene DESPUÉS, que es lo que
   * un elemento de contenido debe hacer.
   *
   * `pendingReviewCount` llega por prop en vez de leerse de `page.data`: cada
   * página ya lo recibe mezclado en su propio `data` (herencia de `load` de
   * SvelteKit desde `finanzas/+layout.server.ts`), así que pasarlo explícito
   * deja el contrato de este componente visible en su firma.
   */
  let { pendingReviewCount }: { pendingReviewCount: number } = $props();

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
      {label}{#if slug === 'revision' && pendingReviewCount > 0}<span class="status-chip revision-badge">{pendingReviewCount}</span>{/if}
    </a>
  {/each}
</nav>

<style>
  /* Una sola línea con scroll horizontal y máscara: `flex-wrap: wrap` +
     `overflow-x: auto` es contradictorio (el navegador envuelve en vez de
     desbordar) y siete etiquetas partidas en dos o tres líneas se comían el
     presupuesto de marco de mobile-densidad.dbe2e.ts. Mismo patrón que
     `.employment-tabs`. */
  .finance-nav {
    display: flex;
    flex-wrap: nowrap;
    gap: var(--space-2);
    overflow-x: auto;
    scrollbar-width: none;
    -webkit-overflow-scrolling: touch;
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
