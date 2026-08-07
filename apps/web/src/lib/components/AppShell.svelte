<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { onMount, type Snippet } from 'svelte';
  import { ROLE_LABELS, type Capability } from '$lib/auth/capabilities';
  import { householdPath, type HouseholdModule } from '$lib/auth/routing';
  import type { AppContext } from '$lib/auth/types';
  import { startSyncMonitor, syncStatus } from '$lib/offline/sync';
  import NavIcon from './NavIcon.svelte';

  let { context, children }: { context: AppContext; children: Snippet } = $props();

  const navigation: Array<{ module: HouseholdModule; label: string; capability: Capability }> = [
    { module: 'today', label: 'Hoy', capability: 'emergency.read' },
    { module: 'employment', label: 'Acuerdos y pagos', capability: 'settlement.read' },
    { module: 'menu', label: 'Menú', capability: 'menu.read' },
    { module: 'recipes', label: 'Recetas', capability: 'content.read' },
    { module: 'wiki', label: 'Wiki de la casa', capability: 'content.read' },
    { module: 'routines', label: 'Rutinas', capability: 'routine.read' },
    { module: 'calendar', label: 'Calendario', capability: 'calendar.read' },
    { module: 'contacts', label: 'Contactos', capability: 'contact.read' }
  ];

  const visibleNavigation = navigation.filter((item) => context.capabilities.includes(item.capability));
  const has = (capability: Capability) => context.capabilities.includes(capability);
  const pathFor = (moduleName: HouseholdModule) => householdPath(context.household.id, moduleName);
  const isActive = (moduleName: HouseholdModule) => page.url.pathname === pathFor(moduleName) || page.url.pathname.startsWith(`${pathFor(moduleName)}/`);

  onMount(() => {
    const stopMonitor = startSyncMonitor(context.criticalSnapshot, context.snapshotPublicKey);
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 'k' && has('search.use')) {
        event.preventDefault();
        void goto(pathFor('search'));
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

{#if $syncStatus.phase === 'offline' || $syncStatus.phase === 'conflict' || $syncStatus.phase === 'error'}
  <div class="status-banner" class:danger={$syncStatus.phase !== 'offline'} role="status">
    <strong>{$syncStatus.label}</strong>
    <span>{$syncStatus.detail}</span>
  </div>
{/if}

<div class="app-shell" class:with-banner={$syncStatus.phase === 'offline' || $syncStatus.phase === 'conflict' || $syncStatus.phase === 'error'}>
  <aside class="sidebar" aria-label="Navegación principal">
    <a class="brand" href={pathFor('today')} aria-label="Casa Clara, ir a Hoy">
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
      <a class="mobile-brand" href={pathFor('today')} aria-label="Casa Clara, ir a Hoy">
        <span class="brand-mark small" aria-hidden="true">⌂</span><strong>Casa Clara</strong>
      </a>
      {#if has('search.use')}
        <a class="global-search" href={pathFor('search')}>
          <NavIcon name="search" />
          <span>Buscar en toda la casa…</span>
          <kbd>⌘ K</kbd>
        </a>
      {/if}
      <div class="topbar-actions">
        <span class="sync-pill" class:pending={$syncStatus.phase !== 'saved'} role="status" title={$syncStatus.detail}>
          <i aria-hidden="true"></i><span>{$syncStatus.label}</span>
        </span>
        <span class="top-avatar" aria-hidden="true">{context.user.initials}</span>
      </div>
    </header>

    <main id="main-content" tabindex="-1">
      {@render children()}
    </main>
  </div>

  <nav class="bottom-nav" aria-label="Navegación móvil">
    {#each visibleNavigation.slice(0, 4) as item}
      <a class:active={isActive(item.module)} href={pathFor(item.module)} aria-current={isActive(item.module) ? 'page' : undefined}>
        <NavIcon name={item.module} /><span>{item.label === 'Acuerdos y pagos' ? 'Pagos' : item.label.replace(' de la casa', '')}</span>
      </a>
    {/each}
    <a class:active={isActive('emergency')} href={pathFor('emergency')} aria-current={isActive('emergency') ? 'page' : undefined}>
      <NavIcon name="emergency" /><span>Ayuda</span>
    </a>
  </nav>
</div>
