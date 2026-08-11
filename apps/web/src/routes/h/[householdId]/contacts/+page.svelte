<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import { useAppContext } from '$lib/auth/context';
  import { archiveContact, upsertContact } from '$lib/contacts/commands';
  import { CONTACT_KINDS, CONTACT_KIND_LABELS, type ContactKind } from '$lib/contacts/kinds';
  import { queueCommand, type QueueCommandResult } from '$lib/offline/queue-command';
  import type { ContactView } from '$lib/server/contacts.server';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const context = useAppContext();

  const directory = $derived(data.directory);

  // ── Modo real (Postgres bajo RLS): CRUD de familia vía outbox ──────────────
  let busy = $state(false);
  let feedback = $state<QueueCommandResult | null>(null);
  let editorOpen = $state(false);
  let editingId = $state<string | null>(null);
  let draftName = $state('');
  let draftRole = $state('');
  let draftPhone = $state('');
  let draftKind = $state<ContactKind>('otros');
  let draftFeatured = $state(false);
  let draftNotes = $state('');

  const grouped = $derived(
    CONTACT_KINDS.map((kind) => ({
      kind,
      label: CONTACT_KIND_LABELS[kind],
      contacts: (directory?.contacts ?? []).filter((contact) => contact.kind === kind)
    })).filter((group) => group.contacts.length > 0)
  );

  function openNew(): void {
    editingId = null;
    draftName = '';
    draftRole = '';
    draftPhone = '';
    draftKind = 'otros';
    draftFeatured = false;
    draftNotes = '';
    editorOpen = true;
  }

  function openEdit(contact: ContactView): void {
    editingId = contact.id;
    draftName = contact.name;
    draftRole = contact.roleLabel;
    draftPhone = contact.phone;
    draftKind = contact.kind;
    draftFeatured = contact.featured;
    draftNotes = contact.notes;
    editorOpen = true;
  }

  async function dispatch(envelope: Parameters<typeof queueCommand>[0]): Promise<QueueCommandResult> {
    busy = true;
    try {
      const result = await queueCommand(envelope);
      feedback = result;
      if (result.outcome === 'synced') await invalidateAll();
      return result;
    } finally {
      busy = false;
    }
  }

  async function submitContact(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!directory || !draftName.trim() || !draftPhone.trim()) return;
    const result = await dispatch(
      upsertContact({
        householdId: directory.householdId,
        contactId: editingId ?? undefined,
        name: draftName,
        roleLabel: draftRole,
        phone: draftPhone,
        kind: draftKind,
        featured: draftFeatured,
        notes: draftNotes
      })
    );
    if (result.outcome === 'synced' || result.outcome === 'queued') editorOpen = false;
  }

  function archive(contact: ContactView): void {
    if (!directory) return;
    void dispatch(archiveContact({ householdId: directory.householdId, contactId: contact.id }));
  }

  function telHref(phone: string): string {
    return `tel:${phone.replace(/[^+\d]/g, '')}`;
  }

  // Mismo patrón que el CHECK de app.contacts y el schema congelado.
  const PHONE_PATTERN = '[0-9+][0-9 ().-]{1,24}';
</script>

<div class="page-wrap">
  {#if directory}
    {#snippet actions()}
      {#if directory.canWrite}
        <button class="button primary" type="button" onclick={() => (editorOpen ? (editorOpen = false) : openNew())}>
          {editorOpen ? 'Cerrar el formulario' : 'Añadir contacto'}
        </button>
      {/if}
    {/snippet}
    <PageHeader
      eyebrow="Directorio del hogar"
      title={`Contactos · ${directory.contacts.length}`}
      description="Personas y servicios del hogar; los destacados aparecen en Emergencias y en el modo sin conexión."
      {actions}
    />

    {#if feedback}
      <p
        class={feedback.outcome === 'synced' ? 'success-message' : feedback.outcome === 'queued' ? 'queued-note' : 'form-error'}
        role="status"
      >{feedback.message}</p>
    {/if}

    {#if editorOpen && directory.canWrite}
      <section class="card">
        <form class="action-form" onsubmit={submitContact}>
          <h3>{editingId ? 'Editar contacto' : 'Nuevo contacto'}</h3>
          <div class="form-grid">
            <label>Nombre
              <input type="text" bind:value={draftName} maxlength="120" required autocomplete="off" enterkeyhint="next" />
            </label>
            <label>Rol o relación
              <input type="text" bind:value={draftRole} maxlength="120" placeholder="Pediatra, vecina, fontanero…" autocomplete="off" enterkeyhint="next" />
            </label>
            <label>Teléfono
              <input type="tel" bind:value={draftPhone} maxlength="25" required placeholder="600 000 000" pattern={PHONE_PATTERN} autocomplete="off" enterkeyhint="next" />
            </label>
            <label>Tipo
              <select bind:value={draftKind}>
                {#each CONTACT_KINDS as kind (kind)}
                  <option value={kind}>{CONTACT_KIND_LABELS[kind]}</option>
                {/each}
              </select>
            </label>
          </div>
          <label>Notas
            <input type="text" bind:value={draftNotes} maxlength="500" autocomplete="off" enterkeyhint="done" />
          </label>
          <label class="inline-check">
            <input type="checkbox" bind:checked={draftFeatured} />
            Destacado: visible en Emergencias y sin conexión
          </label>
          <div class="action-row">
            <button class="button primary" type="submit" disabled={busy}>{editingId ? 'Guardar contacto' : 'Crear contacto'}</button>
          </div>
        </form>
      </section>
    {/if}

    {#if directory.contacts.length === 0}
      <section class="empty-state">
        <span aria-hidden="true">☎</span>
        <h2>Todavía no hay contactos</h2>
        <p>
          {directory.canWrite
            ? 'Añade los contactos de tu hogar; los que marques como destacados aparecerán en Emergencias.'
            : 'La familia todavía no ha añadido contactos del hogar.'}
        </p>
      </section>
    {/if}

    {#each grouped as group (group.kind)}
      <section aria-labelledby={`contacts-${group.kind}`}>
        <div class="section-heading"><div><p class="eyebrow">{group.label}</p><h2 id={`contacts-${group.kind}`} class="sr-only">{group.label}</h2></div></div>
        <div class="contact-grid" data-lista="principal">
          {#each group.contacts as contact (contact.id)}
            <article class="card contact-card" class:featured={contact.featured}>
              <span class={`contact-avatar ${contact.kind}`} aria-hidden="true">{contact.kind === 'emergency' ? '+' : contact.name.slice(0, 1)}</span>
              <div>
                <p class="eyebrow">{contact.roleLabel || CONTACT_KIND_LABELS[contact.kind]}</p>
                <h2>{contact.name}</h2>
                <a href={telHref(contact.phone)}>{contact.phone}</a>
                {#if contact.notes}<small>{contact.notes}</small>{/if}
              </div>
              <!-- Una acción por fila y al final de la fila, siempre en el mismo
                   sitio: llamar es lo que se hace con un contacto. Editar y
                   archivar se separan por un divisor y nombran a su sujeto. -->
              <div class="contact-actions">
                <a class="call-button" href={telHref(contact.phone)} aria-label={`Llamar a ${contact.name}`}>Llamar</a>
              </div>
              {#if directory.canWrite}
                <div class="contact-admin action-row destructiva">
                  <button class="button secondary small-button" type="button" disabled={busy} onclick={() => openEdit(contact)}>Editar {contact.name}</button>
                  <button class="button secondary small-button" type="button" disabled={busy} onclick={() => archive(contact)}>Archivar {contact.name}</button>
                </div>
              {/if}
            </article>
          {/each}
        </div>
      </section>
    {/each}
  {:else if data.contacts}
    {#snippet fixtureActions()}{#if context.capabilities.includes('contact.write')}<button class="button primary" type="button">Añadir contacto</button>{/if}{/snippet}
    <PageHeader eyebrow="Directorio compartido" title="Contactos" description="Personas y servicios útiles, con los esenciales siempre a mano." actions={fixtureActions} />

    <section class="contact-grid">
      {#each data.contacts.contacts as contact}
        <article class="card contact-card" class:featured={contact.featured}>
          <span class={`contact-avatar ${contact.kind}`} aria-hidden="true">{contact.kind === 'emergency' ? '+' : contact.name.slice(0, 1)}</span>
          <div><p class="eyebrow">{contact.role}</p><h2>{contact.name}</h2><a href={`tel:${contact.phone.replaceAll(' ', '')}`}>{contact.phone}</a></div>
          <a class="call-button" href={`tel:${contact.phone.replaceAll(' ', '')}`} aria-label={`Llamar a ${contact.name}`}>Llamar</a>
        </article>
      {/each}
    </section>
  {/if}
</div>
