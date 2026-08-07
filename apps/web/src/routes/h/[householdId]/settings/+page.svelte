<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import { ROLE_LABELS, type Role } from '$lib/auth/capabilities';
  import {
    queueAccessCommand,
    revokeMembership,
    setMembershipExpiry
  } from '$lib/access/commands';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const access = $derived(data.access);

  const DATE_LABEL = new Intl.DateTimeFormat('es-ES', { dateStyle: 'medium', timeStyle: 'short' });
  const CONFIRM_WORD = 'REVOCAR';

  function formatInstant(iso: string): string {
    return DATE_LABEL.format(new Date(iso));
  }

  let queued = $state(false);
  let busy = $state(false);
  // Borradores por membresía: caducidad propuesta y confirmación de revocación.
  let expiryDrafts = $state<Record<string, string>>({});
  let confirmingId = $state<string | null>(null);
  let confirmText = $state('');

  async function dispatch(envelope: Parameters<typeof queueAccessCommand>[0]): Promise<void> {
    busy = true;
    try {
      const outcome = await queueAccessCommand(envelope);
      if (outcome === 'synced') await invalidateAll();
      else queued = true;
    } finally {
      busy = false;
    }
  }

  function submitExpiry(membershipId: string): void {
    if (!access) return;
    const draft = expiryDrafts[membershipId];
    if (!draft) return;
    // datetime-local llega sin zona; el contrato exige ISO-8601 con zona.
    const expiresAt = new Date(draft).toISOString();
    void dispatch(setMembershipExpiry({ householdId: access.householdId, membershipId, expiresAt })).then(() => {
      expiryDrafts = { ...expiryDrafts, [membershipId]: '' };
    });
  }

  function clearExpiry(membershipId: string): void {
    if (!access) return;
    void dispatch(setMembershipExpiry({ householdId: access.householdId, membershipId, expiresAt: null }));
  }

  function askRevoke(membershipId: string): void {
    confirmingId = confirmingId === membershipId ? null : membershipId;
    confirmText = '';
  }

  function submitRevoke(membershipId: string): void {
    if (!access || confirmText.trim().toLocaleUpperCase('es') !== CONFIRM_WORD) return;
    void dispatch(revokeMembership({ householdId: access.householdId, membershipId })).then(() => {
      confirmingId = null;
      confirmText = '';
    });
  }
</script>

<svelte:head><title>Ajustes · Casa Clara</title></svelte:head>

<div class="page-wrap">
  <PageHeader eyebrow="Administración" title="Ajustes del hogar" description="Miembros, acceso y preferencias generales de esta demo." />

  {#if access}
    <section class="card" aria-labelledby="access-title">
      <div class="section-heading"><div><p class="eyebrow">Accesos del hogar</p><h2 id="access-title">Caducidad y revocación</h2></div></div>
      {#if queued}<p class="success-message" role="status">Cambio guardado en la outbox local, pendiente de sincronizar.</p>{/if}
      <ul class="wiki-recent">
        {#each access.memberships as member (member.id)}
          <li>
            <div class="wiki-node-row">
              <span>
                <strong>{member.name}</strong>
                <small>{ROLE_LABELS[member.role]} · en el hogar desde {formatInstant(member.startsAt)}</small>
                {#if member.revokedAt}
                  <small>Acceso revocado el {formatInstant(member.revokedAt)}</small>
                {:else if member.expiresAt}
                  <small>Caduca el {formatInstant(member.expiresAt)}</small>
                {/if}
              </span>
              {#if member.revokedAt}
                <span class="status-chip warning">Revocado</span>
              {:else if member.expiresAt && new Date(member.expiresAt).getTime() <= Date.now()}
                <span class="status-chip warning">Caducado</span>
              {:else if member.expiresAt}
                <span class="status-chip warning">Con caducidad</span>
              {:else}
                <span class="status-chip success">Activo</span>
              {/if}
              {#if member.isSelf}
                <span class="status-chip">Tu acceso</span>
              {/if}
            </div>
            {#if !member.isSelf && !member.revokedAt}
              <form
                class="action-form"
                onsubmit={(event) => {
                  event.preventDefault();
                  submitExpiry(member.id);
                }}
              >
                <label>Nueva caducidad
                  <input type="datetime-local" bind:value={expiryDrafts[member.id]} />
                </label>
                <div class="menu-slot-actions">
                  <button class="button secondary small-button" type="submit" disabled={busy || !expiryDrafts[member.id]}>
                    Fijar caducidad
                  </button>
                  {#if member.expiresAt}
                    <button class="button secondary small-button" type="button" disabled={busy} onclick={() => clearExpiry(member.id)}>
                      Quitar caducidad
                    </button>
                  {/if}
                  <button class="button secondary small-button" type="button" disabled={busy} onclick={() => askRevoke(member.id)}>
                    {confirmingId === member.id ? 'Cancelar revocación' : 'Revocar acceso'}
                  </button>
                </div>
              </form>
              {#if confirmingId === member.id}
                <form
                  class="action-form"
                  onsubmit={(event) => {
                    event.preventDefault();
                    submitRevoke(member.id);
                  }}
                >
                  <p class="audit-note">
                    La revocación es <strong>inmediata e irreversible desde esta pantalla</strong>: {member.name} perderá el
                    acceso al hogar en su siguiente petición, también en los dispositivos donde ya tenga sesión. Escribe
                    <strong>{CONFIRM_WORD}</strong> para confirmar.
                  </p>
                  <label>Confirmación
                    <input type="text" bind:value={confirmText} placeholder={CONFIRM_WORD} autocomplete="off" />
                  </label>
                  <div class="menu-slot-actions">
                    <button
                      class="button primary"
                      type="submit"
                      disabled={busy || confirmText.trim().toLocaleUpperCase('es') !== CONFIRM_WORD}
                    >
                      Revocar acceso ahora
                    </button>
                  </div>
                </form>
              {/if}
            {/if}
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  <div class="settings-layout">
    <section class="card"><p class="eyebrow">Miembros</p><h2>Accesos activos</h2>
      <div class="member-list">
        {#each data.settings.members as member}
          <div><span class="avatar">{member.initials}</span><span><strong>{member.name}</strong><small>{ROLE_LABELS[member.role as Role]}</small></span><span class="status-chip success">Demo</span></div>
        {/each}
      </div>
    </section>
    <div class="stack">
      <section class="card"><p class="eyebrow">Hogar</p><h2>{data.settings.household.name}</h2><dl class="settings-list"><div><dt>Idioma</dt><dd>{data.settings.preferences.locale}</dd></div><div><dt>Zona horaria</dt><dd>{data.settings.preferences.timeZone}</dd></div><div><dt>Primero de la semana</dt><dd>{data.settings.preferences.weekStarts}</dd></div></dl></section>
      <section class="card warning-card"><p class="eyebrow">Entorno de prueba</p><h2>Datos exclusivamente sintéticos</h2><p>Las sesiones viven en memoria y desaparecen al reiniciar el servidor. Esta interfaz no sustituye autenticación ni RLS de producción.</p></section>
    </div>
  </div>
</div>
