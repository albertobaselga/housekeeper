<script lang="ts">
  import { can } from '$lib/auth/capabilities';
  import { useAppContext } from '$lib/auth/context';

  let {
    householdId,
    current,
    empleada = null
  }: {
    householdId: string;
    current: 'resumen' | 'conceptos' | 'vacaciones' | 'pagos' | 'contrato';
    empleada?: string | null;
  } = $props();

  const context = useAppContext();
  const base = $derived(`/h/${householdId}/employment`);
  // La empleada elegida viaja con cada pestaña: cambiar de pestaña nunca
  // cambia de persona. Vacaciones y el contrato reciben el parámetro aunque
  // pinten a todas, para que el enlace de vuelta tampoco la pierda.
  const query = $derived(empleada ? `?empleada=${encodeURIComponent(empleada)}` : '');

  // La quinta plaza tiene dos caras: quien pacta ve «Contrato» (el acuerdo);
  // quien solo lee ve «Condiciones». Nadie ve las dos.
  const contractTab = $derived(
    can(context.role, 'agreement.write')
      ? { href: `${base}/acuerdo`, label: 'Contrato' }
      : can(context.role, 'agreement.read')
        ? { href: `${base}/condiciones`, label: 'Condiciones' }
        : null
  );

  const tabs = $derived(
    [
      { key: 'resumen', href: base, label: 'Resumen', show: true },
      { key: 'conceptos', href: `${base}/conceptos`, label: 'Conceptos', show: true },
      {
        key: 'vacaciones',
        href: `${base}/vacaciones`,
        label: 'Vacaciones',
        show: can(context.role, 'agreement.read')
      },
      { key: 'pagos', href: `${base}/pagos`, label: 'Pagos', show: true },
      ...(contractTab
        ? [{ key: 'contrato', href: contractTab.href, label: contractTab.label, show: true }]
        : [])
    ].filter((tab) => tab.show)
  );
</script>

<!-- Enlaces con aria-current, no un tablist de widget: cada pestaña es una
     ruta con su propia capacidad y su propio trozo de JavaScript, y la
     navegación entre hermanas es de cliente, así que se siente una sola
     pantalla sin serlo. -->
<nav class="employment-tabs" aria-label="Secciones del contrato">
  {#each tabs as tab (tab.key)}
    <!-- Sin noscroll: cada pestaña es OTRA página con otra longitud, y llegar
         a mitad de una pantalla nueva conservando el scroll de la anterior
         deja el titular y la barra fuera de la vista. El noscroll es para los
         chips de persona, que re-renderizan la misma página. -->
    <a
      href={`${tab.href}${query}`}
      class:active={tab.key === current}
      aria-current={tab.key === current ? 'page' : undefined}
    >{tab.label}</a>
  {/each}
</nav>

<style>
  /* Barra de secciones, no tira de chips: rectangular y con el acento debajo,
     para que no se confunda con el selector de persona que puede ir encima.
     Cinco etiquetas largas no caben a 320 px: misma receta de desbordamiento
     con señal que la tira de chips (scroll con máscara), nunca una segunda
     línea de marco. */
  .employment-tabs {
    display: flex;
    /* 8 px entre dianas contiguas: es el mínimo del sistema (A3 de la suite
       de densidad), no una preferencia. */
    gap: var(--space-2);
    margin-bottom: var(--space-4);
    border-bottom: 1px solid var(--line);
    overflow-x: auto;
    scrollbar-width: none;
    -webkit-overflow-scrolling: touch;
    mask-image: linear-gradient(to right, #000 0, #000 calc(100% - var(--space-6)), transparent 100%);
  }

  .employment-tabs::-webkit-scrollbar {
    display: none;
  }

  .employment-tabs a {
    flex: 0 0 auto;
    display: inline-flex;
    min-height: var(--row-data);
    align-items: center;
    border-bottom: 2px solid transparent;
    padding: var(--space-2) var(--space-3);
    color: var(--ink-soft);
    font-size: var(--text-meta);
    font-weight: 500;
    text-decoration: none;
    white-space: nowrap;
    touch-action: manipulation;
  }

  .employment-tabs a.active {
    border-bottom-color: var(--primary);
    color: var(--primary);
    font-weight: 700;
  }
</style>
