<script lang="ts">
  import { page } from '$app/state';
</script>

<svelte:head><title>{page.status === 403 ? 'Acceso restringido' : 'No encontrado'} · Casa Clara</title></svelte:head>

<main class="error-stage">
  <section class="error-card" aria-labelledby="error-title">
    <span class="brand-mark" aria-hidden="true">⌂</span>
    <p class="eyebrow">Error {page.status}</p>
    <h1 id="error-title">{page.status === 403 ? 'Esta zona no está incluida en tu acceso' : 'No encontramos esta página'}</h1>
    <p>{page.error?.message ?? 'Vuelve al inicio y prueba otra sección.'}</p>
    <a class="button primary" href="/">Volver a Casa Clara</a>
  </section>
</main>
