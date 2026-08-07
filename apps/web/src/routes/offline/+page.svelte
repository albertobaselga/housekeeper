<script lang="ts">
  import { browser } from '$app/environment';
  import { onMount } from 'svelte';
  import { readCriticalSnapshot } from '$lib/offline/idb';

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

  let contacts = $state<SnapshotContact[]>([]);
  let notes = $state<SnapshotNote[]>([]);
  let snapshotLoaded = $state(false);

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
      contacts = snapshot.payload.contacts.map(asContact).filter((value): value is SnapshotContact => value !== null);
      notes = snapshot.payload.emergency.map(asNote).filter((value): value is SnapshotNote => value !== null);
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
        <h3 style="margin: 0 0 0.5rem; font-size: 0.95rem; color: #1a1a1a;">Notas críticas</h3>
        <ul style="list-style: none; margin: 0; padding: 0;">
          {#each notes as note (note.id)}
            <li style="padding: 0.5rem 0; border-bottom: 1px solid #eee;">
              <strong style="display: block; color: #1a1a1a;">{note.title}</strong>
              <span style="color: #444;">{note.body}</span>
            </li>
          {/each}
        </ul>
      {/if}
      <p style="margin: 0.75rem 0 0; font-size: 0.8rem; color: #666;">Información del snapshot crítico guardado en este dispositivo.</p>
    {:else}
      <p style="margin: 0; font-size: 0.9rem; color: #444;">Si has iniciado sesión en este dispositivo, los contactos de emergencia guardados aparecerán aquí en cuanto la página termine de cargar.</p>
    {/if}
  </section>
</main>
