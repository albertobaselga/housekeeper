<script lang="ts">
  import { page } from '$app/state';

  // Si la URL era de un hogar (/h/<id>/…), la vuelta natural es SU pantalla de
  // Hoy; fuera de un hogar, la portada.
  const householdMatch = /^\/h\/([^/]+)/.exec(page.url.pathname);
  const homeHref = householdMatch ? `/h/${householdMatch[1]}/today` : '/';
  const forbidden = page.status === 403;
</script>

<svelte:head><title>{forbidden ? 'Sección no incluida en tu acceso' : 'No encontrado'} · Casa Clara</title></svelte:head>

<main class="error-stage">
  <section class="error-card" aria-labelledby="error-title">
    <span class="brand-mark" aria-hidden="true">⌂</span>
    <p class="eyebrow">{forbidden ? 'Acceso' : `Error ${page.status}`}</p>
    <h1 id="error-title">{forbidden ? 'Esta sección no está incluida en tu acceso' : 'No encontramos esta página'}</h1>
    {#if forbidden}
      <p>{page.error?.message ?? 'Esta parte la lleva la familia.'} No es ningún fallo: tu acceso simplemente no la incluye.</p>
      <a class="button primary" href={homeHref}>← Volver a Hoy</a>
    {:else}
      <p>{page.error?.message ?? 'Vuelve al inicio y prueba otra sección.'}</p>
      <a class="button primary" href={homeHref}>{householdMatch ? '← Volver a Hoy' : 'Volver a Casa Clara'}</a>
    {/if}
  </section>
</main>
