<script lang="ts">
  import type { Snippet } from 'svelte';

  /*
   * [FASE 5, T10 · corrección Important 1] La navegación del módulo vivía
   * aquí, pintada por encima de `{@render children()}`: eso la dejaba FUERA
   * del `.page-wrap` de cada pantalla y sumaba su alto al «marco» que mide
   * `mobile-densidad.dbe2e.ts` en las siete rutas (regresión declarada en el
   * informe de la tarea). Ahora vive en `$lib/components/finance/FinanceNav.svelte`,
   * que cada página importa y pinta DENTRO de su propio `.page-wrap`, justo
   * después de `PageHeader` — el mismo sitio donde `EmploymentTabs.svelte` ya
   * resolvía este mismo problema para `employment/*`. `+layout.server.ts`
   * sigue calculando `pendingReviewCount`: cada página lo recibe ya mezclado
   * en su propio `data` (herencia de `load` de SvelteKit) y se lo pasa a
   * `FinanceNav`.
   */
  let { children }: { children: Snippet } = $props();
</script>

{@render children()}
