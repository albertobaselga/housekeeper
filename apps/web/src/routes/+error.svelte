<script lang="ts">
  import { page } from '$app/state';

  // Si la URL era de un hogar (/h/<id>/…), la vuelta natural es SU pantalla de
  // Hoy; fuera de un hogar, la portada.
  const householdMatch = /^\/h\/([^/]+)/.exec(page.url.pathname);
  const homeHref = householdMatch ? `/h/${householdMatch[1]}/today` : '/';
  const forbidden = page.status === 403;
  // 503: el servidor está en pie pero no ha podido leer los datos de la casa.
  // No es «no existe» ni «no te toca», y decirlo importa: es temporal, no hay
  // nada que arreglar por parte de quien lo lee, y volver a intentarlo sirve.
  const unavailable = page.status === 503;
  const emergencyHref = householdMatch ? `/h/${householdMatch[1]}/emergency` : null;
</script>

<!-- El <title> lo pone el layout de la raíz, que ya conoce `page.error`. -->
<main class="error-stage">
  <section class="error-card" aria-labelledby="error-title">
    <span class="brand-mark" aria-hidden="true">⌂</span>
    <p class="eyebrow">{forbidden ? 'Acceso' : unavailable ? 'Sin acceso a los datos' : `Error ${page.status}`}</p>
    <h1 id="error-title">
      {#if forbidden}Esta sección no está incluida en tu acceso{:else if unavailable}No podemos leer los datos de la casa{:else}No encontramos esta página{/if}
    </h1>
    {#if forbidden}
      <p>{page.error?.message ?? 'Esta parte la lleva la familia.'} No es ningún fallo: tu acceso simplemente no la incluye.</p>
      <a class="button primary" href={homeHref}>← Volver a Hoy</a>
    {:else if unavailable}
      <p>{page.error?.message ?? 'Vuelve a intentarlo en un momento.'}</p>
      <p>No te enseñamos datos de ejemplo en su lugar: preferimos decirte que no los tenemos.</p>
      {#if emergencyHref}
        <p><strong>Si es una urgencia, llama al 112.</strong></p>
        <a class="button primary" href={emergencyHref}>Ir a Emergencias</a>
      {/if}
      <a class="button secondary" href={page.url.pathname}>Volver a intentarlo</a>
    {:else}
      <p>{page.error?.message ?? 'Vuelve al inicio y prueba otra sección.'}</p>
      <a class="button primary" href={homeHref}>{householdMatch ? '← Volver a Hoy' : 'Volver al inicio'}</a>
    {/if}
  </section>
</main>
