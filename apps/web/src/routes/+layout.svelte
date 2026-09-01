<script lang="ts">
  import '../app.css';
  // Registro TEMPRANO y estático de `beforeinstallprompt` (Frente B): Chromium
  // dispara ese evento una sola vez, a menudo antes de que nada diferido llegue
  // a escucharlo. Importado aquí, en la raíz, para que se evalúe antes de que
  // monte cualquier componente. Módulo diminuto y sin dependencias a propósito:
  // viaja en el arranque de TODA la aplicación, incluida Hoy (verify:bundle).
  import '$lib/pwa/prompt-capture';
  import { page } from '$app/state';
  import { documentTitle, sectionLabelFor } from '$lib/app-title';

  let { children } = $props();

  // Único <title> de la aplicación. Vive aquí, en la raíz, porque es el único
  // punto por el que pasan todas las páginas: las del hogar (que llevan
  // `context` en sus datos y por tanto se titulan con el nombre de ESE hogar),
  // la de acceso, la de sin conexión y la de error. Dos <svelte:head> con
  // <title> darían dos elementos y el navegador se quedaría con el primero:
  // ninguna otra página debe volver a declararlo.
  const section = $derived(
    page.error
      ? page.status === 403
        ? 'Sección no incluida en tu acceso'
        : page.status === 404
          ? 'No encontrado'
          : `Error ${page.status}`
      : (page.data.section ?? sectionLabelFor(page.url.pathname))
  );
  const title = $derived(documentTitle(section, page.data.context?.household.name));
</script>

<svelte:head><title>{title}</title></svelte:head>

{@render children()}
