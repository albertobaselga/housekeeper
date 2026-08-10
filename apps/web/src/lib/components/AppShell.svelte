<script lang="ts">
  import { goto } from '$app/navigation';
  import { navigating, page } from '$app/state';
  import { onMount, tick, type Snippet } from 'svelte';
  import type { Action } from 'svelte/action';
  import { ROLE_LABELS, type Capability } from '$lib/auth/capabilities';
  import { householdPath, type HouseholdModule } from '$lib/auth/routing';
  import type { AppContext } from '$lib/auth/types';
  import { startSyncMonitor, syncStatus } from '$lib/offline/sync';
  import NavIcon from './NavIcon.svelte';

  let { context, children }: { context: AppContext; children: Snippet } = $props();

  const has = (capability: Capability) => context.capabilities.includes(capability);
  /** ¿Hay identidad real con contraseña detrás de esta instalación? */
  const hasPasswordAuth = () => Boolean(context.passwordAuth);

  interface NavEntry {
    module: HouseholdModule;
    label: string;
    short: string;
    capability: Capability;
  }

  const NAV_ENTRIES: Readonly<Record<string, NavEntry>> = {
    today: { module: 'today', label: 'Hoy', short: 'Hoy', capability: 'emergency.read' },
    employment: { module: 'employment', label: 'Pagos', short: 'Pagos', capability: 'settlement.read' },
    menu: { module: 'menu', label: 'Menú', short: 'Menú', capability: 'menu.read' },
    wiki: { module: 'wiki', label: 'Guía de la casa', short: 'Guía', capability: 'content.read' },
    routines: { module: 'routines', label: 'Rutinas', short: 'Rutinas', capability: 'routine.read' },
    calendar: { module: 'calendar', label: 'Calendario', short: 'Agenda', capability: 'calendar.read' },
    contacts: { module: 'contacts', label: 'Contactos', short: 'Contactos', capability: 'contact.read' },
    emergency: { module: 'emergency', label: 'Emergencias', short: 'Ayuda', capability: 'emergency.read' }
  };

  // Orden por rol según el mapa del informe heurístico (H-02/H-12): quien
  // trabaja la casa (registra jornadas o no gestiona pagos) lleva Rutinas al
  // frente; la familia prioriza Menú, Pagos y Agenda. Recetas deja de ser
  // destino de primer nivel: vive dentro de Menú y sigue accesible por URL.
  const handsOnOrder = ['today', 'routines', 'menu', 'employment', 'wiki', 'calendar', 'contacts'];
  const familyOrder = ['today', 'menu', 'employment', 'calendar', 'wiki', 'routines', 'contacts'];
  const order = has('work.register.self') || !has('settlement.read') ? handsOnOrder : familyOrder;

  const visibleNavigation = order
    .map((key) => NAV_ENTRIES[key])
    .filter((item) => has(item.capability));

  // Bottom-nav móvil: 4 destinos principales + «Más». Emergencias cierra la
  // lista para que roles con pocos módulos (viewer) la conserven a un tap.
  const mobileOrder = [...visibleNavigation, NAV_ENTRIES.emergency];
  const mobilePrimary = mobileOrder.slice(0, 4);
  // «Tu contraseña» solo cuando hay identidad real detrás: en la demo por
  // fixtures no existe contraseña alguna y el enlace sería una promesa vacía.
  const accountEntry = { module: 'account', label: 'Tu contraseña', short: 'Contraseña', capability: 'emergency.read' } as NavEntry;
  const sheetNavigation: NavEntry[] = [
    ...mobileOrder.slice(4),
    ...(hasPasswordAuth() ? [accountEntry] : []),
    ...(has('access.manage')
      ? [{ module: 'settings', label: 'Ajustes del hogar', short: 'Ajustes', capability: 'access.manage' } as NavEntry]
      : [])
  ];

  const pathFor = (moduleName: HouseholdModule) => householdPath(context.household.id, moduleName);
  const isActive = (moduleName: HouseholdModule) => page.url.pathname === pathFor(moduleName) || page.url.pathname.startsWith(`${pathFor(moduleName)}/`);

  let moreOpen = $state(false);
  let searchOpen = $state(false);
  let searchQuery = $state('');
  // Detalle de la píldora de sync accesible en táctil (P3): el `title` es
  // invisible en móvil, así que un tap abre un mini-popover con el estado.
  let pillOpen = $state(false);

  // Feedback de navegación (H-07 / P2-4): barra de progreso fina, global y
  // sin CLS (position: fixed). Solo aparece en navegaciones que superan los
  // 150 ms para no parpadear en las instantáneas.
  let navBusy = $state(false);
  $effect(() => {
    if (!navigating.to) {
      navBusy = false;
      return;
    }
    const timer = setTimeout(() => {
      navBusy = true;
    }, 150);
    return () => {
      clearTimeout(timer);
      navBusy = false;
    };
  });

  const sheetActive = $derived(sheetNavigation.some((item) => isActive(item.module)));

  // Cerrar hoja y overlay al navegar (backstop además del cierre en el click).
  $effect(() => {
    void page.url.pathname;
    moreOpen = false;
    searchOpen = false;
    pillOpen = false;
  });

  /**
   * Diálogo accesible mínimo: foco inicial, ciclo de Tab dentro del nodo,
   * Escape cierra, bloqueo de scroll del fondo y foco de vuelta al disparador.
   */
  const modalDialog: Action<HTMLElement, { onClose: () => void }> = (node, options) => {
    const previous = document.activeElement as HTMLElement | null;
    const focusables = () =>
      Array.from(
        node.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'
        )
      );
    void tick().then(() => {
      (node.querySelector<HTMLElement>('[data-autofocus]') ?? focusables()[0] ?? node).focus();
    });
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        options.onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const current = document.activeElement;
      if (event.shiftKey && (current === first || current === node)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && current === last) {
        event.preventDefault();
        first.focus();
      }
    };
    node.addEventListener('keydown', onKeydown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return {
      destroy() {
        node.removeEventListener('keydown', onKeydown);
        document.body.style.overflow = previousOverflow;
        previous?.focus?.();
      }
    };
  };

  function openSearch(): void {
    searchQuery = '';
    moreOpen = false;
    searchOpen = true;
  }

  function submitSearch(event: SubmitEvent): void {
    event.preventDefault();
    const query = searchQuery.trim();
    searchOpen = false;
    // Sin duplicar la lógica de resultados: navega a la página de búsqueda.
    void goto(query ? `${pathFor('search')}?q=${encodeURIComponent(query)}` : pathFor('search'));
  }

  onMount(() => {
    const stopMonitor = startSyncMonitor(context.criticalSnapshot, context.snapshotPublicKey);
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 'k' && has('search.use')) {
        event.preventDefault();
        if (searchOpen) searchOpen = false;
        else openSearch();
      }
    };
    window.addEventListener('keydown', handleShortcut);
    return () => {
      stopMonitor();
      window.removeEventListener('keydown', handleShortcut);
    };
  });
</script>

<a class="skip-link" href="#main-content">Saltar al contenido</a>

{#if navBusy}
  <!-- Barra fija fuera del flujo: cero CLS. El texto es solo para lectores. -->
  <div class="nav-progress" role="status">
    <span class="sr-only">Cargando la página…</span>
  </div>
{/if}

{#if $syncStatus.phase === 'offline' || $syncStatus.phase === 'conflict' || $syncStatus.phase === 'error'}
  <div class="status-banner" class:danger={$syncStatus.phase !== 'offline'} role="status">
    <strong>{$syncStatus.label}</strong>
    <span>{$syncStatus.detail}</span>
  </div>
{/if}

{#if context.synthetic}
  <!-- Control 9 (ALLOW_SYNTHETIC_DATA_ONLY): aviso discreto y persistente.
       Fijo al borde inferior y fuera del flujo: no desplaza ni tapa la
       navegación existente. -->
  <p class="synthetic-banner" role="note" data-testid="synthetic-banner">
    Entorno sintético: no introduzcas datos reales
  </p>
{/if}

<div class="app-shell" class:with-banner={$syncStatus.phase === 'offline' || $syncStatus.phase === 'conflict' || $syncStatus.phase === 'error'}>
  <aside class="sidebar" aria-label="Navegación principal">
    <a class="brand" href={pathFor('today')} aria-label={`${context.household.name}, ir a Hoy`}>
      <span class="brand-mark" aria-hidden="true">⌂</span>
      <span class="brand-copy"><strong>{context.household.name}</strong><small>{context.household.subtitle}</small></span>
    </a>

    <nav class="side-nav">
      {#each visibleNavigation as item}
        <a class:active={isActive(item.module)} href={pathFor(item.module)} aria-current={isActive(item.module) ? 'page' : undefined}>
          <NavIcon name={item.module} />
          <span>{item.label}</span>
        </a>
      {/each}
    </nav>

    <div class="sidebar-bottom">
      <a class="emergency-link" class:active={isActive('emergency')} href={pathFor('emergency')} aria-current={isActive('emergency') ? 'page' : undefined}>
        <NavIcon name="emergency" />
        <span><strong>Emergencias</strong><small>Disponible sin conexión</small></span>
      </a>
      {#if context.passwordAuth}
        <a class="settings-link" class:active={isActive('account')} href={pathFor('account')} aria-current={isActive('account') ? 'page' : undefined}>
          <NavIcon name="account" /> <span>Tu contraseña</span>
        </a>
      {/if}
      {#if has('access.manage')}
        <a class="settings-link" class:active={isActive('settings')} href={pathFor('settings')} aria-current={isActive('settings') ? 'page' : undefined}>
          <NavIcon name="settings" /> <span>Ajustes del hogar</span>
        </a>
      {/if}
      <div class="profile-block">
        <span class="avatar">{context.user.initials}</span>
        <span class="profile-copy"><strong>{context.user.name}</strong><small>{ROLE_LABELS[context.role]}</small></span>
        <form method="POST" action="/logout"><button type="submit" class="text-button" aria-label="Cerrar sesión de {context.user.name}">Salir</button></form>
      </div>
    </div>
  </aside>

  <div class="main-column">
    <header class="topbar">
      <!-- Cabecera con sesión: manda el nombre del hogar al que se ha entrado,
           el mismo que ya luce la barra lateral. Nunca el del proyecto. -->
      <a class="mobile-brand" href={pathFor('today')} aria-label={`${context.household.name}, ir a Hoy`}>
        <span class="brand-mark small" aria-hidden="true">⌂</span><strong>{context.household.name}</strong>
      </a>
      {#if has('search.use')}
        <button type="button" class="global-search" aria-haspopup="dialog" aria-label="Buscar en toda la casa" onclick={openSearch}>
          <NavIcon name="search" />
          <span>Buscar en toda la casa…</span>
          <kbd>⌘ K</kbd>
        </button>
      {/if}
      <div class="topbar-actions">
        <!-- El detalle de la píldora deja de vivir solo en `title` (invisible
             en táctil): el tap abre un mini-popover accesible con el estado. -->
        <button
          type="button"
          class="sync-pill"
          class:pending={$syncStatus.phase !== 'saved'}
          title={$syncStatus.detail}
          aria-label={`Estado de sincronización: ${$syncStatus.label}`}
          aria-haspopup="dialog"
          aria-expanded={pillOpen}
          onclick={() => (pillOpen = !pillOpen)}
        >
          <i aria-hidden="true"></i><span>{$syncStatus.label}</span>
        </button>
        <span class="top-avatar" aria-hidden="true">{context.user.initials}</span>
      </div>
    </header>

    <main id="main-content" tabindex="-1" aria-busy={navBusy}>
      {@render children()}
    </main>
  </div>

  <nav class="bottom-nav" aria-label="Navegación móvil">
    {#each mobilePrimary as item}
      <a class:active={isActive(item.module)} href={pathFor(item.module)} aria-current={isActive(item.module) ? 'page' : undefined}>
        <NavIcon name={item.module} /><span>{item.short}</span>
      </a>
    {/each}
    <button
      type="button"
      class="more-button"
      class:active={sheetActive}
      aria-haspopup="dialog"
      aria-expanded={moreOpen}
      onclick={() => (moreOpen = !moreOpen)}
    >
      <span class="nav-symbol" aria-hidden="true">⋯</span><span>Más</span>
    </button>
  </nav>
</div>

{#if moreOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="sheet-backdrop" onclick={() => (moreOpen = false)}></div>
  <div
    class="more-sheet"
    role="dialog"
    aria-modal="true"
    aria-labelledby="more-sheet-title"
    use:modalDialog={{ onClose: () => (moreOpen = false) }}
  >
    <header class="sheet-header">
      <h2 id="more-sheet-title">Más opciones</h2>
      <button type="button" class="sheet-close" onclick={() => (moreOpen = false)} aria-label="Cerrar el menú">✕</button>
    </header>
    <nav class="sheet-nav" aria-label="Más secciones">
      {#each sheetNavigation as item}
        <a
          class:active={isActive(item.module)}
          class:danger={item.module === 'emergency'}
          href={pathFor(item.module)}
          aria-current={isActive(item.module) ? 'page' : undefined}
          onclick={() => (moreOpen = false)}
        >
          <NavIcon name={item.module} />
          <span>{item.label}</span>
          {#if item.module === 'emergency'}<small>Disponible sin conexión</small>{/if}
        </a>
      {/each}
    </nav>
    <form method="POST" action="/logout" class="sheet-logout">
      <button type="submit">Salir<small>Cerrar la sesión de {context.user.name}</small></button>
    </form>
  </div>
{/if}

{#if pillOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="sheet-backdrop transparent" onclick={() => (pillOpen = false)}></div>
  <div
    class="sync-popover"
    role="dialog"
    aria-label="Estado de sincronización"
    use:modalDialog={{ onClose: () => (pillOpen = false) }}
  >
    <p class="sync-popover-label"><strong>{$syncStatus.label}</strong></p>
    <p class="sync-popover-detail">{$syncStatus.detail}</p>
    <button type="button" class="button secondary small-button" onclick={() => (pillOpen = false)}>Cerrar</button>
  </div>
{/if}

{#if searchOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="sheet-backdrop" onclick={() => (searchOpen = false)}></div>
  <div
    class="search-overlay"
    role="dialog"
    aria-modal="true"
    aria-label="Buscar en toda la casa"
    use:modalDialog={{ onClose: () => (searchOpen = false) }}
  >
    <form role="search" onsubmit={submitSearch}>
      <span aria-hidden="true">⌕</span>
      <input
        type="search"
        name="q"
        bind:value={searchQuery}
        data-autofocus
        placeholder="Buscar en toda la casa…"
        aria-label="Texto a buscar"
        autocomplete="off"
      />
      <button type="submit" class="button primary small-button">Buscar</button>
    </form>
    <p>Enter busca en la guía, contactos y más · Escape cierra</p>
  </div>
{/if}
