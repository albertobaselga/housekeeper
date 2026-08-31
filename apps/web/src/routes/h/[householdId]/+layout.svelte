<script lang="ts">
  import { browser } from '$app/environment';
  import AppShell from '$lib/components/AppShell.svelte';
  import { provideAppContext } from '$lib/auth/context';
  import { onMount, untrack } from 'svelte';
  import type { LayoutData } from './$types';

  let { data, children }: { data: LayoutData; children: import('svelte').Snippet } = $props();
  const context = provideAppContext(untrack(() => data.context));

  // Calentamiento de caché (UX-P1-5 / I-03): Emergencias debe abrir offline
  // aunque nunca se haya visitado. Una vez por sesión y sin bloquear nada, se
  // pide la página con el header de calentamiento; el service worker la guarda
  // en la caché de páginas como si hubiera sido una navegación completa.
  onMount(() => {
    if (!browser || !('serviceWorker' in navigator) || !navigator.onLine) return;
    const householdId = untrack(() => data.context.household.id);
    const warmKey = `housekeeper-warmed-emergency:${householdId}`;
    try {
      if (sessionStorage.getItem(warmKey)) return;
    } catch {
      // Sin sessionStorage (modo privado extremo): calentar igualmente.
    }
    // El fetch solo calienta la caché si el SW ya controla esta página; en la
    // primera visita (SW recién instalado) se espera al `controllerchange` de
    // clients.claim() con un tope corto para no dejar promesas colgadas.
    const whenControlled = (): Promise<boolean> => {
      if (navigator.serviceWorker.controller) return Promise.resolve(true);
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(Boolean(navigator.serviceWorker.controller)), 10_000);
        navigator.serviceWorker.addEventListener(
          'controllerchange',
          () => {
            clearTimeout(timer);
            resolve(true);
          },
          { once: true }
        );
      });
    };

    void navigator.serviceWorker.ready
      .then(whenControlled)
      .then((controlled) => {
        if (!controlled) return;
        return fetch(`/h/${householdId}/emergency`, {
          headers: { 'x-housekeeper-warm-page': '1' },
          credentials: 'same-origin'
        }).then((response) => {
          if (!response.ok) return;
          try {
            sessionStorage.setItem(warmKey, new Date().toISOString());
          } catch {
            // El guard por sesión es solo un ahorro de red; sin él no pasa nada.
          }
        });
      })
      .catch(() => {
        // Sin red o SW aún no activo: la próxima navegación online lo reintentará.
      });
  });
</script>

<AppShell {context}>
  {@render children()}
</AppShell>
