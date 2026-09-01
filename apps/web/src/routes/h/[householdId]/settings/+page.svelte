<script lang="ts">
  import { enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import ActionStatus from '$lib/components/ActionStatus.svelte';
  import type { Role } from '$lib/auth/capabilities';
  import { ROLE_LABELS } from '$lib/auth/role-labels';
  import { OptimisticActions } from '$lib/offline/optimistic';
  import { revokeMembership, setMembershipExpiry } from '$lib/access/commands';
  import { financeGrantToggle } from '$lib/finance/commands';
  import { createFinanceGrantDispatch } from '$lib/finance/grant-dispatch';
  import type { ActionData, PageData } from './$types';

  import { useAppContext } from '$lib/auth/context';

  let { data, form }: { data: PageData; form: ActionData } = $props();
  const context = useAppContext();

  const access = $derived(data.access);

  // Patrón wiki: `invalidate('cc:settings')` selectivo y nota veraz unificada.
  const optimistic = new OptimisticActions({ householdId: context.household.id, invalidateToken: 'cc:settings' });
  const actionStatus = optimistic.status;
  $effect(() => optimistic.start());

  const DATE_LABEL = new Intl.DateTimeFormat('es-ES', { dateStyle: 'medium' });
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

  // ── Concesiones de Finanzas (spec §4) ──────────────────────────────────────
  // Despacho propio, y no una segunda `OptimisticActions` suelta: el módulo
  // `$lib/finance/grant-dispatch` fija el token, los mensajes de rechazo y —lo
  // que importa— hace IMPOSIBLE entregarle un gancho de pintado optimista. Esta
  // tarjeta no puede decir «Activado» de algo que el servidor no ha aceptado.
  // La nota es propia porque el acuse tiene que aparecer donde estaba el dedo
  // (§2.5 del sistema móvil) y la tarjeta de accesos queda muy por encima.
  const financeGrant = createFinanceGrantDispatch({ householdId: context.household.id });
  const financeStatus = financeGrant.status;
  $effect(() => financeGrant.start());

  type FinanceAdmin = NonNullable<PageData['finance']>['admins'][number];

  /** La fila cuyo comando está en vuelo, para que lo diga ella y no la pantalla. */
  let financePendingId = $state<string | null>(null);
  let confirmingFinanceId = $state<string | null>(null);

  /**
   * Quitarse Finanzas a una misma cierra el módulo en el acto, así que se
   * pregunta antes. No se impide: Alberto eligió que cualquier administración
   * familiar gestione esto, y la suya no es una excepción. Conceder —y revocar
   * a otra persona— no necesita confirmación: es reversible desde esta tarjeta.
   */
  function askFinance(admin: FinanceAdmin): void {
    if (admin.isSelf && admin.granted) {
      confirmingFinanceId = confirmingFinanceId === admin.membershipId ? null : admin.membershipId;
      return;
    }
    toggleFinance(admin);
  }

  function toggleFinance(admin: FinanceAdmin): void {
    const envelope = financeGrantToggle({
      householdId: context.household.id,
      membershipId: admin.membershipId,
      granted: admin.granted
    });
    busy = true;
    financePendingId = admin.membershipId;
    confirmingFinanceId = null;
    // La fila sigue diciendo lo que trajo el `load` hasta que el servidor
    // confirma y `cc:settings` la refresca; un rechazo la deja como estaba, con
    // su causa al lado. No es una convención que haya que recordar: el despacho
    // no admite ganchos de pintado.
    void financeGrant
      .run(envelope, {
        // Cambiar la concesión PROPIA cambia lo que el layout entrega al
        // cliente —la capacidad `finance.access`, y con ella la entrada de
        // navegación—, y `cc:settings` solo re-ejecuta el load de esta página.
        // Va como `settle`: después del acuse, nunca antes.
        settle: admin.isSelf ? () => void invalidateAll() : undefined
      })
      .finally(() => {
        busy = false;
        financePendingId = null;
      });
  }

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

  // ── Reponer contraseñas ────────────────────────────────────────────────────
  // No pasa por la cola offline a propósito: una contraseña se cambia contra el
  // servidor o no se cambia. Es una form action con mejora progresiva. La
  // contraseña PROPIA se cambia en «Tu acceso» (/account), que sí alcanza todo
  // el mundo; Ajustes es exclusivo del family_admin.
  let resettingId = $state<string | null>(null);

  function toggleReset(membershipId: string): void {
    resettingId = resettingId === membershipId ? null : membershipId;
  }
</script>

<div class="page-wrap">
  <PageHeader eyebrow="Administración" title="Ajustes del hogar" description="Miembros, acceso y preferencias generales de esta demo." />

  {#if access}
    <section class="card" aria-labelledby="access-title">
      <div class="section-heading"><div><p class="eyebrow">Accesos del hogar</p><h2 id="access-title">¿Hasta cuándo puede entrar cada persona?</h2></div></div>
      <ActionStatus status={actionStatus} />
      {#if form?.resetDone}
        <p class="demo-note" role="status"><strong>Contraseña repuesta.</strong> Dile a {form.resetDone} la contraseña nueva en persona; ya no puede entrar con la anterior en ningún dispositivo.</p>
      {/if}
      <ul class="wiki-recent" data-lista="principal">
        {#each access.memberships as member (member.id)}
          <!-- Cada persona es UNA fila de 56 px, y sus controles se despliegan
               desde ella. Sin esto la lista de seis miembros eran seis
               formularios apilados y de la primera pantalla se veía una sola
               persona: un listado de accesos sirve para MIRAR quién entra;
               cambiarlo es otra cosa y se pide. -->
          <li>
            <details class="member-admin">
              <summary class="fila-accion">
                <span class="fila-cuerpo">
                  <strong>{member.name}</strong>
                  <small>
                    {ROLE_LABELS[member.role]}
                    {#if member.revokedAt}· sin acceso desde el {formatInstant(member.revokedAt)}
                    {:else if member.expiresAt}· puede entrar hasta el {formatInstant(member.expiresAt)}
                    {:else}· en el hogar desde {formatInstant(member.startsAt)}{/if}
                  </small>
                </span>
                <span class="fila-fin">
                  {#if member.revokedAt}
                    <span class="status-chip warning">Sin acceso</span>
                  {:else if member.expiresAt && new Date(member.expiresAt).getTime() <= Date.now()}
                    <span class="status-chip warning">Fecha límite pasada</span>
                  {:else if member.expiresAt}
                    <span class="status-chip warning">Con fecha límite</span>
                  {:else}
                    <span class="status-chip success">Activo</span>
                  {/if}
                  {#if member.isSelf}<span class="status-chip">Tu acceso</span>{/if}
                </span>
              </summary>
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
                <div class="action-row">
                  <button class="button secondary small-button" type="submit" disabled={busy || !expiryDrafts[member.id]}>
                    Poner fecha límite
                  </button>
                  {#if member.expiresAt}
                    <button class="button secondary small-button" type="button" disabled={busy} onclick={() => clearExpiry(member.id)}>
                      Quitar la fecha límite
                    </button>
                  {/if}
                  {#if data.passwordAuth}
                    <button class="button secondary small-button" type="button" onclick={() => toggleReset(member.id)}>
                      {resettingId === member.id ? 'Cancelar' : `Poner una contraseña nueva a ${member.name}`}
                    </button>
                  {/if}
                </div>
                <!-- La destructiva va separada por un divisor, agrupada al final
                     del bloque de SU dueño y nombrando a su sujeto en el propio
                     botón. Antes «Poner fecha límite» y «Quitar el acceso» eran
                     dos botones idénticos a 7 px uno de otro, y el nombre al que
                     pertenecían quedaba a 212 px por encima —a 9 px del nombre
                     de la siguiente persona—. Ahora también se ve que es
                     peligrosa: `--danger` existía en :root y no se usaba nunca. -->
                <div class="action-row destructiva">
                  <button class="button danger small-button" type="button" disabled={busy} onclick={() => askRevoke(member.id)}>
                    {confirmingId === member.id ? 'Cancelar' : `Quitar el acceso a ${member.name}`}
                  </button>
                </div>
              </form>
              {#if data.passwordAuth && resettingId === member.id}
                <form class="action-form" method="POST" action="?/resetMemberPassword" use:enhance={() => {
                  return async ({ result, update }) => {
                    await update({ reset: true });
                    // Hecha la reposición, el formulario se cierra: dejarlo
                    // abierto invita a repetirla sin querer.
                    if (result.type === 'success') resettingId = null;
                  };
                }}>
                  <p class="audit-note">
                    Vas a poner una contraseña nueva a <strong>{member.name}</strong>. Díctasela en persona y pídele que la
                    cambie desde «Tu contraseña» en cuanto entre. Al hacerlo, <strong>{member.name} saldrá de todos los
                    dispositivos donde tuviera la sesión abierta</strong> y tendrá que entrar con la contraseña nueva.
                    Escribe <strong>{data.resetConfirmWord}</strong> para confirmar.
                  </p>
                  {#if form?.resetError && form?.resetMembershipId === member.id}
                    <p class="form-error" role="alert">{form.resetError}</p>
                  {/if}
                  <input type="hidden" name="membershipId" value={member.id} />
                  <label for={`reset-new-${member.id}`}>Contraseña nueva (mínimo {data.minPasswordLength} caracteres)
                    <input id={`reset-new-${member.id}`} name="newPassword" type="password" autocomplete="new-password" minlength={data.minPasswordLength} required />
                  </label>
                  <label for={`reset-repeat-${member.id}`}>Repite la contraseña nueva
                    <input id={`reset-repeat-${member.id}`} name="repeatPassword" type="password" autocomplete="new-password" minlength={data.minPasswordLength} required />
                  </label>
                  <label for={`reset-confirm-${member.id}`}>Confirmación
                    <input id={`reset-confirm-${member.id}`} name="confirm" type="text" placeholder={data.resetConfirmWord} autocomplete="off" enterkeyhint="done" required />
                  </label>
                  <div class="menu-slot-actions">
                    <button class="button primary" type="submit">Poner la contraseña nueva</button>
                  </div>
                </form>
              {/if}
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
                      class="button danger"
                      type="submit"
                      disabled={busy || confirmText.trim().toLocaleUpperCase('es') !== CONFIRM_WORD}
                    >
                      Quitar el acceso a {member.name} ahora
                    </button>
                  </div>
                </form>
              {/if}
            {:else}
              <p class="audit-note">
                {member.isSelf
                  ? 'Tu propio acceso no se administra desde aquí.'
                  : 'Este acceso ya está retirado.'}
              </p>
            {/if}
            </details>
          </li>
        {/each}
      </ul>
    </section>

    <section class="card" aria-labelledby="finance-grants-title">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Finanzas</p>
          <h2 id="finance-grants-title">Quién puede ver las finanzas de la casa</h2>
        </div>
      </div>
      <!-- Sin `{:else}`: esta tarjeta va DENTRO del `{#if access}` de la
           pantalla, y `loadFinanceGrantOverview` devuelve null exactamente en
           los mismos casos en que `loadAccessOverview` lo devuelve (sin pool o
           sin rol de administración). Una rama alternativa aquí sería marcado
           inalcanzable. -->
      {#if data.finance}
        <ActionStatus status={financeStatus} />
        <p class="audit-note">
          Finanzas se activa cuenta a cuenta y solo para la familia administradora: quien no lo
          tiene activado no ve el módulo ni una sola cifra. Puedes desactivártelo a ti; no se borra
          nada y cualquier administración de la casa —tú incluida— puede volver a activarlo desde
          aquí.
        </p>
        <ul class="wiki-recent" data-lista="finanzas">
          {#each data.finance.admins as admin (admin.membershipId)}
            <li>
              <div class="fila-accion">
                <span class="fila-cuerpo">
                  <strong>{admin.name}</strong>
                  <small>{admin.granted ? 'Ve el módulo de Finanzas' : 'No ve el módulo de Finanzas'}</small>
                </span>
                <span class="fila-fin">
                  <!-- Mientras el comando viaja, el estado sigue siendo el de
                       antes: lo que cambia es que la fila avisa de que hay algo
                       en vuelo. Si el servidor lo rechaza, aquí no ha cambiado
                       nada y la causa aparece arriba de la tarjeta. -->
                  {#if financePendingId === admin.membershipId}
                    <span class="status-chip">Enviando…</span>
                  {/if}
                  {#if admin.granted}
                    <span class="status-chip success">Activado</span>
                  {:else}
                    <span class="status-chip">Apagado</span>
                  {/if}
                  {#if admin.isSelf}<span class="status-chip">Tu cuenta</span>{/if}
                  <!-- Patrón de fila de la casa (rutinas): el botón nombra a su
                       sujeto para el lector de pantalla, no en dos líneas de
                       texto que estrujan la fila a 320 px. El nombre visible
                       está a la izquierda, en la misma fila. -->
                  <button
                    class="button secondary small-button"
                    type="button"
                    disabled={busy}
                    aria-label={admin.granted
                      ? `Desactivar Finanzas a ${admin.name}`
                      : `Activar Finanzas a ${admin.name}`}
                    onclick={() => askFinance(admin)}
                  >
                    {admin.granted ? 'Desactivar Finanzas' : 'Activar Finanzas'}
                  </button>
                </span>
              </div>
              {#if confirmingFinanceId === admin.membershipId}
                <div class="action-form">
                  <p class="audit-note">
                    Vas a quitarte Finanzas a ti. En cuanto se guarde, <strong>dejarás de ver el módulo de
                    Finanzas</strong> y todas sus cifras, y desaparecerá de la navegación. No se borra nada:
                    puedes volver a activarlo desde esta misma tarjeta.
                  </p>
                  <div class="menu-slot-actions">
                    <button class="button primary" type="button" disabled={busy} onclick={() => toggleFinance(admin)}>
                      Quitarme Finanzas ahora
                    </button>
                  </div>
                </div>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <!--
      Personal no está en la barra de navegación: el AppShell vive dentro del
      grafo inicial de Hoy y una entrada más no cabe en su presupuesto. Se
      alcanza desde aquí, que es donde ya se viene a gestionar quién entra.
    -->
    <section class="card">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Personal</p>
          <h2>Quién trabaja en la casa</h2>
        </div>
      </div>
      <p class="audit-note">
        Las personas que trabajan aquí y las que trabajaron antes, con sus contratos y el historial de
        condiciones. También se dan de alta desde ahí.
      </p>
      <div class="action-row"><a class="button secondary" href={`/h/${context.household.id}/personal`}>Ver el personal</a></div>
    </section>
  {/if}

  <div class="settings-layout">
    <!--
      Censo y preferencias de la MAQUETA: solo existen en la demostración sin
      base de datos. Con hogar real detrás, `data.settings` es null y quien
      manda es la sección de accesos de arriba, que sale de la base bajo RLS.
    -->
    {#if data.settings}
      <section class="card"><p class="eyebrow">Miembros</p><h2>Accesos activos</h2>
        <div class="member-list">
          {#each data.settings.members as member}
            <div><span class="avatar">{member.initials}</span><span><strong>{member.name}</strong><small>{ROLE_LABELS[member.role as Role]}</small></span><span class="status-chip success">Demo</span></div>
          {/each}
        </div>
      </section>
    {/if}
    <div class="stack">
      {#if data.settings}
        <section class="card"><p class="eyebrow">Hogar</p><h2>{data.settings.household.name}</h2><dl class="settings-list"><div><dt>Idioma</dt><dd>{data.settings.preferences.locale}</dd></div><div><dt>Zona horaria</dt><dd>{data.settings.preferences.timeZone}</dd></div><div><dt>Primero de la semana</dt><dd>{data.settings.preferences.weekStarts}</dd></div></dl></section>
      {:else}
        <section class="card"><p class="eyebrow">Hogar</p><h2>{context.household.name}</h2><dl class="settings-list"><div><dt>Idioma</dt><dd>Español (España)</dd></div><div><dt>Zona horaria</dt><dd>{context.timeZone}</dd></div><div><dt>Primero de la semana</dt><dd>Lunes</dd></div></dl></section>
      {/if}
      {#if data.handover}
        <section class="card">
          <p class="eyebrow">Traspaso</p>
          <h2>Traspaso operativo de la casa</h2>
          <p>Todo lo necesario para que otra persona lleve la casa, en un único archivo comprimido.</p>
          <div class="handover-actions">
            <div class="handover-option">
              <a class="button secondary" href={`/api/v1/households/${data.handover.householdId}/handover?audience=helper`}>Descargar traspaso (apoyo)</a>
              <p class="audit-note">Incluye la guía publicada, las rutinas de toda la casa, el menú de la semana y los contactos.</p>
            </div>
            <div class="handover-option">
              <a class="button secondary" href={`/api/v1/households/${data.handover.householdId}/handover?audience=family`}>Descargar traspaso (familia)</a>
              <p class="audit-note">Lo mismo, con todas las rutinas (también las de la familia). El expediente laboral no se incluye nunca.</p>
            </div>
          </div>
        </section>
      {/if}
      <!-- Solo donde de verdad lo es. Esta tarjeta se escribió sin condición y
           salía también en una instalación real, diciéndole a la casa que no
           metiera datos reales justo en la pantalla desde la que se dan de alta
           los accesos de las personas que trabajan en ella. El mismo flag que
           pinta la banda del AppShell manda aquí. -->
      {#if context.synthetic}
        <section class="card warning-card"><p class="eyebrow">Entorno de prueba</p><h2>Datos exclusivamente sintéticos</h2><p>Las sesiones no se guardan: al reiniciar la aplicación hay que volver a entrar. Cada hogar solo puede ver lo suyo, pero esta demo no sustituye a la versión final: no introduzcas datos reales.</p></section>
      {/if}
    </div>
  </div>
</div>

<style>
  .handover-actions {
    display: grid;
    gap: var(--space-3);
    margin-top: var(--space-3);
  }

  /* P2-11: cada descarga cuenta en una línea qué incluye su versión. */
  .handover-option {
    display: grid;
    gap: var(--space-1);
    justify-items: start;
  }

  .handover-option .audit-note {
    margin-top: 0;
    color: var(--ink-soft);
  }
</style>
