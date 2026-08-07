<svelte:head><title>Sin conexión · Casa Clara</title></svelte:head>

<main class="error-stage">
  <section class="error-card" aria-labelledby="offline-title">
    <span class="brand-mark" aria-hidden="true">⌂</span>
    <p class="eyebrow">Sin conexión</p>
    <h1 id="offline-title">Casa Clara sigue guardando lo esencial</h1>
    <p>Vuelve a una página que ya hayas visitado o recupera Emergencias desde la aplicación instalada. Los cambios compatibles esperan en este dispositivo hasta recibir confirmación.</p>
    <button class="button primary" type="button" onclick={() => history.back()}>Volver</button>
  </section>
</main>
