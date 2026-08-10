<script lang="ts">
  import { browser } from '$app/environment';
  import { onMount } from 'svelte';
  import { readCriticalSnapshot } from '$lib/offline/idb';
  import { savedAtLabel, snapshotProvenance } from '$lib/offline/saved';

  interface SnapshotContact {
    id: string;
    name: string;
    phone: string;
  }

  interface SnapshotNote {
    id: string;
    title: string;
    body: string;
  }

  interface SnapshotMenuSlot {
    id: string;
    mealLabel: string;
    groupName: string;
    dish: string;
    confirmed: boolean;
  }

  interface SnapshotRoutine {
    id: string;
    title: string;
    dueLabel: string;
    overdue: boolean;
    done: boolean;
  }

  interface SnapshotGuidePage {
    id: string;
    title: string;
    space: string;
    body: string;
  }

  let contacts = $state<SnapshotContact[]>([]);
  let notes = $state<SnapshotNote[]>([]);
  let dateLabel = $state('');
  let menu = $state<SnapshotMenuSlot[]>([]);
  let routines = $state<SnapshotRoutine[]>([]);
  let guidePages = $state<SnapshotGuidePage[]>([]);
  let snapshotLoaded = $state(false);
  /**
   * De dónde salió lo que se está enseñando y desde cuándo. Se pinta siempre
   * que haya paquete: quien lee esto puede estar decidiendo a quién llamar, y
   * tiene derecho a saber si son los datos de la casa o los de una demostración,
   * y de qué día son.
   */
  let savedLabel = $state('');

  function asContact(value: unknown): SnapshotContact | null {
    if (!value || typeof value !== 'object') return null;
    const candidate = value as Partial<SnapshotContact>;
    if (typeof candidate.id !== 'string' || typeof candidate.name !== 'string' || typeof candidate.phone !== 'string') {
      return null;
    }
    return { id: candidate.id, name: candidate.name, phone: candidate.phone };
  }

  function asNote(value: unknown): SnapshotNote | null {
    if (!value || typeof value !== 'object') return null;
    const candidate = value as Partial<SnapshotNote>;
    if (typeof candidate.id !== 'string' || typeof candidate.title !== 'string' || typeof candidate.body !== 'string') {
      return null;
    }
    return { id: candidate.id, title: candidate.title, body: candidate.body };
  }

  function asMenuSlot(value: unknown): SnapshotMenuSlot | null {
    if (!value || typeof value !== 'object') return null;
    const candidate = value as Partial<SnapshotMenuSlot>;
    if (typeof candidate.id !== 'string' || typeof candidate.dish !== 'string') return null;
    return {
      id: candidate.id,
      mealLabel: typeof candidate.mealLabel === 'string' ? candidate.mealLabel : '',
      groupName: typeof candidate.groupName === 'string' ? candidate.groupName : '',
      dish: candidate.dish,
      confirmed: candidate.confirmed === true
    };
  }

  function asRoutine(value: unknown): SnapshotRoutine | null {
    if (!value || typeof value !== 'object') return null;
    const candidate = value as Partial<SnapshotRoutine>;
    if (typeof candidate.id !== 'string' || typeof candidate.title !== 'string') return null;
    return {
      id: candidate.id,
      title: candidate.title,
      dueLabel: typeof candidate.dueLabel === 'string' ? candidate.dueLabel : '',
      overdue: candidate.overdue === true,
      done: candidate.done === true
    };
  }

  function asGuidePage(value: unknown): SnapshotGuidePage | null {
    if (!value || typeof value !== 'object') return null;
    const candidate = value as Partial<SnapshotGuidePage>;
    if (typeof candidate.id !== 'string' || typeof candidate.title !== 'string' || typeof candidate.body !== 'string') {
      return null;
    }
    return {
      id: candidate.id,
      title: candidate.title,
      space: typeof candidate.space === 'string' ? candidate.space : '',
      body: candidate.body
    };
  }

  /** Párrafos legibles sin hoja de estilos: el Markdown se lee tal cual, por líneas. */
  function paragraphs(body: string): string[] {
    return body
      .split(/\n{2,}/)
      .map((block) => block.replace(/\s*\n\s*/g, ' ').trim())
      .filter(Boolean);
  }

  // El fallback offline se sirve bajo la URL que se intentaba visitar
  // (p. ej. /h/<id>/emergency): el hogar se lee de esa URL, no de datos de
  // servidor, porque aquí no hay servidor.
  function householdIdFromPath(pathname: string): string | null {
    const match = /^\/h\/([0-9a-fA-F-]{36})(?:\/|$)/.exec(pathname);
    return match ? match[1]! : null;
  }

  onMount(async () => {
    if (!browser) return;
    try {
      const householdId = householdIdFromPath(location.pathname);
      if (!householdId) return;
      const snapshot = await readCriticalSnapshot(householdId);
      if (!snapshot) return;
      const provenance = snapshotProvenance(snapshot);
      savedLabel =
        provenance === 'fixture'
          ? 'Datos de DEMOSTRACIÓN guardados en este dispositivo. No son los de una casa real.'
          : savedAtLabel(snapshot.generatedAt);
      contacts = snapshot.payload.contacts.map(asContact).filter((value): value is SnapshotContact => value !== null);
      notes = snapshot.payload.emergency.map(asNote).filter((value): value is SnapshotNote => value !== null);
      const today = (snapshot.payload.today ?? {}) as Record<string, unknown>;
      dateLabel = typeof today.dateLabel === 'string' ? today.dateLabel : '';
      menu = (Array.isArray(today.menu) ? today.menu : [])
        .map(asMenuSlot)
        .filter((value): value is SnapshotMenuSlot => value !== null);
      routines = (Array.isArray(today.routines) ? today.routines : [])
        .map(asRoutine)
        .filter((value): value is SnapshotRoutine => value !== null);
      guidePages = snapshot.payload.wikiPages
        .map(asGuidePage)
        .filter((value): value is SnapshotGuidePage => value !== null);
      snapshotLoaded = true;
    } catch {
      // Sin IndexedDB o snapshot ilegible: se mantiene el aviso genérico.
    }
  });
</script>

<svelte:head><title>Sin conexión · Casa Clara</title></svelte:head>

<!--
  Página de último recurso: puede servirse desde la caché del service worker
  cuando todo lo demás falla, incluida la hoja de estilos. Por eso el bloque
  de emergencia usa estilos inline: debe ser legible con HTML a pelo.
-->
<main class="error-stage" style="max-width: 40rem; margin: 0 auto; padding: 1.5rem; font-family: system-ui, sans-serif;">
  <section class="error-card" aria-labelledby="offline-title" style="margin-bottom: 1.5rem;">
    <span class="brand-mark" aria-hidden="true">⌂</span>
    <p class="eyebrow">Sin conexión</p>
    <h1 id="offline-title">Casa Clara sigue guardando lo esencial</h1>
    <p>Vuelve a una página que ya hayas visitado o usa la información de emergencia guardada en este dispositivo. Los cambios compatibles esperan aquí hasta recibir confirmación.</p>
    <button class="button primary" type="button" onclick={() => history.back()}>Volver</button>
  </section>

  <section aria-labelledby="offline-emergency-title" style="border: 2px solid #b3261e; border-radius: 12px; padding: 1.25rem; background: #fff;">
    <h2 id="offline-emergency-title" style="margin: 0 0 0.75rem; font-size: 1.15rem; color: #1a1a1a;">Emergencias</h2>
    <div style="display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 0.75rem 1rem; border-radius: 10px; background: #fdecea; margin-bottom: 1rem;">
      <div>
        <p style="margin: 0; font-size: 0.85rem; color: #5f1a15;">Emergencia vital</p>
        <strong style="font-size: 1.6rem; color: #b3261e;">112</strong>
      </div>
      <a href="tel:112" style="display: inline-block; padding: 0.6rem 1.1rem; border-radius: 999px; background: #b3261e; color: #fff; text-decoration: none; font-weight: 600;">Llamar al 112</a>
    </div>

    {#if snapshotLoaded}
      {#if contacts.length > 0}
        <h3 style="margin: 0 0 0.5rem; font-size: 0.95rem; color: #1a1a1a;">Contactos de emergencia</h3>
        <ul style="list-style: none; margin: 0 0 1rem; padding: 0;">
          {#each contacts as contact (contact.id)}
            <li style="display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 0.5rem 0; border-bottom: 1px solid #eee;">
              <span style="color: #1a1a1a;">{contact.name}</span>
              <a href={`tel:${contact.phone.replaceAll(' ', '')}`} style="color: #b3261e; font-weight: 600; text-decoration: none;">{contact.phone}</a>
            </li>
          {/each}
        </ul>
      {/if}
      {#if notes.length > 0}
        <h3 style="margin: 0 0 0.5rem; font-size: 0.95rem; color: #1a1a1a;">Qué hacer</h3>
        <ul style="list-style: none; margin: 0; padding: 0;">
          {#each notes as note (note.id)}
            <li style="padding: 0.5rem 0; border-bottom: 1px solid #eee;">
              <strong style="display: block; color: #1a1a1a;">{note.title}</strong>
              <span style="color: #444;">{note.body}</span>
            </li>
          {/each}
        </ul>
      {/if}
      <p style="margin: 0.75rem 0 0; font-size: 0.8rem; color: #666;">{savedLabel || 'Información guardada en este dispositivo la última vez que hubo conexión.'}</p>
    {:else}
      <p style="margin: 0; font-size: 0.9rem; color: #444;">Si has iniciado sesión en este dispositivo, los contactos de emergencia guardados aparecerán aquí en cuanto la página termine de cargar.</p>
    {/if}
  </section>

  {#if menu.length > 0 || routines.length > 0}
    <section aria-labelledby="offline-today-title" style="border: 1px solid #ddd; border-radius: 12px; padding: 1.25rem; background: #fff; margin-top: 1.25rem;">
      <h2 id="offline-today-title" style="margin: 0 0 0.25rem; font-size: 1.15rem; color: #1a1a1a;">El día de hoy</h2>
      {#if dateLabel}
        <p style="margin: 0 0 0.75rem; font-size: 0.85rem; color: #666;">{dateLabel}</p>
      {/if}

      {#if menu.length > 0}
        <h3 style="margin: 0 0 0.5rem; font-size: 0.95rem; color: #1a1a1a;">Qué se come</h3>
        <ul style="list-style: none; margin: 0 0 1rem; padding: 0;">
          {#each menu as slot (slot.id)}
            <li style="padding: 0.5rem 0; border-bottom: 1px solid #eee;">
              <strong style="color: #1a1a1a;">{slot.mealLabel}</strong>
              <span style="color: #444;"> · {slot.dish}</span>
              {#if slot.groupName}<span style="color: #666; font-size: 0.85rem;"> ({slot.groupName})</span>{/if}
              {#if !slot.confirmed}
                <span style="color: #8a5a00; font-size: 0.8rem;"> · Sin confirmar</span>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}

      {#if routines.length > 0}
        <h3 style="margin: 0 0 0.5rem; font-size: 0.95rem; color: #1a1a1a;">Tareas que tocan hoy</h3>
        <ul style="list-style: none; margin: 0; padding: 0;">
          {#each routines as routine (routine.id)}
            <li style="padding: 0.5rem 0; border-bottom: 1px solid #eee;">
              <strong style="color: #1a1a1a;">{routine.title}</strong>
              <span style="color: #666; font-size: 0.85rem;">
                {' · '}{routine.done ? 'Hecha' : routine.overdue ? routine.dueLabel : 'Pendiente'}
              </span>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}

  {#if guidePages.length > 0}
    <section aria-labelledby="offline-guide-title" style="border: 1px solid #ddd; border-radius: 12px; padding: 1.25rem; background: #fff; margin-top: 1.25rem;">
      <h2 id="offline-guide-title" style="margin: 0 0 0.75rem; font-size: 1.15rem; color: #1a1a1a;">Instrucciones guardadas</h2>
      {#each guidePages as page (page.id)}
        <article style="padding: 0.5rem 0 0.75rem; border-bottom: 1px solid #eee;">
          <h3 style="margin: 0; font-size: 0.98rem; color: #1a1a1a;">{page.title}</h3>
          {#if page.space}
            <p style="margin: 0.1rem 0 0.4rem; font-size: 0.8rem; color: #666;">{page.space}</p>
          {/if}
          {#each paragraphs(page.body) as block}
            <p style="margin: 0 0 0.4rem; color: #444;">{block}</p>
          {/each}
        </article>
      {/each}
    </section>
  {/if}
</main>
