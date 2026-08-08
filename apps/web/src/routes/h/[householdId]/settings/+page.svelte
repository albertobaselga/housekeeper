<script lang="ts">
  import PageHeader from '$lib/components/PageHeader.svelte';
  import ActionStatus from '$lib/components/ActionStatus.svelte';
  import { ROLE_LABELS, type Role } from '$lib/auth/capabilities';
  import { OptimisticActions } from '$lib/offline/optimistic';
  import { revokeMembership, setMembershipExpiry } from '$lib/access/commands';
  import type { PageData } from './$types';

  import { useAppContext } from '$lib/auth/context';

  let { data }: { data: PageData } = $props();
  const context = useAppContext();

  const access = $derived(data.access);

  // Patrón wiki: `invalidate('cc:settings')` selectivo y nota veraz unificada.
  const optimistic = new OptimisticActions({ householdId: context.household.id, invalidateToken: 'cc:settings' });
  const actionStatus = optimistic.status;
  $effect(() => optimistic.start());

  const DATE_LABEL = new Intl.DateTimeFormat('es-ES', { dateStyle: 'medium', timeStyle: 'short' });
  // P2-10: la palabra de confirmación acompaña al botón «Quitar el acceso».
  const CONFIRM_WORD = 'QUITAR';

  function formatInstant(iso: string): string {
    return DATE_LABEL.format(new Date(iso));
  }

  let busy = $state(false);
  // Borradores por membresía: caducidad propuesta y confirmación de revocación.
  let expiryDrafts = $state<Record<string, string>>({});
  let confirmingId = $state<string | null>(null);
  let confirmText = $state('');

  // Mensajes de rechazo exclusivos de accesos: viven aquí (y no en el
  // diccionario global) para no cargar en el grafo inicial de Hoy textos que
  // solo esta página puede provocar.
  const MEMBERSHIP_MESSAGES: Readonly<Record<string, string>> = {
    already_revoked: 'El acceso ya estaba retirado',
    expiry_in_past: 'La fecha límite no puede estar en el pasado',
    membership_not_found: 'Ese acceso ya no existe',
    cannot_modify_self: 'No puedes cambiar tu propio acceso'
  };

  async function dispatch(envelope: Parameters<typeof optimistic.run>[0]): Promise<void> {
    busy = true;
    try {
      await optimistic.run(envelope, { messageOverrides: MEMBERSHIP_MESSAGES });
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
      <div class="section-heading"><div><p class="eyebrow">Accesos del hogar</p><h2 id="access-title">¿Hasta cuándo puede entrar cada persona?</h2></div></div>
      <ActionStatus status={actionStatus} />
      <ul class="wiki-recent">
        {#each access.memberships as member (member.id)}
          <li>
            <div class="wiki-node-row">
              <span>
                <strong>{member.name}</strong>
                <small>{ROLE_LABELS[member.role]} · en el hogar desde {formatInstant(member.startsAt)}</small>
                {#if member.revokedAt}
                  <small>Sin acceso desde el {formatInstant(member.revokedAt)}</small>
                {:else if member.expiresAt}
                  <small>Puede entrar hasta el {formatInstant(member.expiresAt)}</small>
                {/if}
              </span>
              {#if member.revokedAt}
                <span class="status-chip warning">Sin acceso</span>
              {:else if member.expiresAt && new Date(member.expiresAt).getTime() <= Date.now()}
                <span class="status-chip warning">Fecha límite pasada</span>
              {:else if member.expiresAt}
                <span class="status-chip warning">Con fecha límite</span>
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
                <label>Fecha límite del acceso
                  <input type="datetime-local" bind:value={expiryDrafts[member.id]} />
                </label>
                <div class="menu-slot-actions">
                  <button class="button secondary small-button" type="submit" disabled={busy || !expiryDrafts[member.id]}>
                    Poner fecha límite
                  </button>
                  {#if member.expiresAt}
                    <button class="button secondary small-button" type="button" disabled={busy} onclick={() => clearExpiry(member.id)}>
                      Quitar la fecha límite
                    </button>
                  {/if}
                  <button class="button secondary small-button" type="button" disabled={busy} onclick={() => askRevoke(member.id)}>
                    {confirmingId === member.id ? 'Cancelar' : 'Quitar el acceso'}
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
                    Quitar el acceso es <strong>inmediato y no se puede deshacer desde esta pantalla</strong>: {member.name}
                    dejará de poder entrar en el hogar al momento, también en los dispositivos donde ya tenga la sesión
                    abierta. Escribe <strong>{CONFIRM_WORD}</strong> para confirmar.
                  </p>
                  <label>Confirmación
                    <input type="text" bind:value={confirmText} placeholder={CONFIRM_WORD} autocomplete="off" enterkeyhint="done" />
                  </label>
                  <div class="menu-slot-actions">
                    <button
                      class="button primary"
                      type="submit"
                      disabled={busy || confirmText.trim().toLocaleUpperCase('es') !== CONFIRM_WORD}
                    >
                      Quitar el acceso ahora
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
      {#if data.handover}
        <section class="card">
          <p class="eyebrow">Traspaso</p>
          <h2>Traspaso operativo de la casa</h2>
          <p>Todo lo necesario para que otra persona lleve la casa, en un único archivo comprimido.</p>
          <div class="handover-actions">
            <div class="handover-option">
              <a class="button secondary" href={`/api/v1/households/${data.handover.householdId}/handover?audience=helper`}>Descargar traspaso (apoyo)</a>
              <small>Incluye la guía publicada, las rutinas de toda la casa, el menú de la semana y los contactos.</small>
            </div>
            <div class="handover-option">
              <a class="button secondary" href={`/api/v1/households/${data.handover.householdId}/handover?audience=family`}>Descargar traspaso (familia)</a>
              <small>Lo mismo, con todas las rutinas (también las de la familia). El expediente laboral no se incluye nunca.</small>
            </div>
          </div>
        </section>
      {/if}
      <section class="card warning-card"><p class="eyebrow">Entorno de prueba</p><h2>Datos exclusivamente sintéticos</h2><p>Las sesiones no se guardan: al reiniciar la aplicación hay que volver a entrar. Cada hogar solo puede ver lo suyo, pero esta demo no sustituye a la versión final: no introduzcas datos reales.</p></section>
    </div>
  </div>
</div>

<style>
  .handover-actions {
    display: grid;
    gap: 0.85rem;
    margin-top: 0.75rem;
  }

  /* P2-11: cada descarga cuenta en una línea qué incluye su versión. */
  .handover-option {
    display: grid;
    gap: 0.3rem;
    justify-items: start;
  }

  .handover-option small {
    color: var(--ink-soft);
    font-size: 0.74rem;
  }
</style>
