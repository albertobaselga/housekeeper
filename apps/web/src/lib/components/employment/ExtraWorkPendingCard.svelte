<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import {
    acceptExtra,
    markExtraPerformed,
    queueEmploymentCommand,
    registerExtra,
    resolveExtra
  } from '$lib/employment/commands';
  import type { PendingExtraWorkView } from '$lib/employment/model';

  let {
    householdId,
    agreementId,
    extras,
    ownMembershipId,
    canRegister,
    canConfirm
  }: {
    householdId: string;
    agreementId: string;
    extras: PendingExtraWorkView[];
    ownMembershipId: string;
    canRegister: boolean;
    canConfirm: boolean;
  } = $props();

  let busy = $state(false);
  let queued = $state(false);
  // Entidades ya actuadas en esta sesión: el control queda deshabilitado aunque
  // el overview tarde en reflejar el cambio tras invalidateAll().
  let acted = $state<string[]>([]);

  let resolveOpenId = $state<string | null>(null);
  let resolveResolution = $state<'money' | 'time_off'>('money');
  let resolveReason = $state('');

  let registerKind = $state<'overtime' | 'worked_rest_day'>('overtime');
  let registerDate = $state(new Date().toISOString().slice(0, 10));
  let registerMinutes = $state(60);
  let registerNote = $state('');
  let registerSent = $state(false);

  async function run(envelope: Parameters<typeof queueEmploymentCommand>[0], entityId?: string): Promise<void> {
    busy = true;
    try {
      const outcome = await queueEmploymentCommand(envelope);
      queued = outcome === 'queued';
      if (outcome === 'synced') {
        // El servidor ya lo aplicó: el overview fresco decide qué acciones quedan.
        await invalidateAll();
      } else if (entityId) {
        acted = [...acted, entityId];
      }
    } finally {
      busy = false;
    }
  }

  async function submitRegister(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!registerDate || registerMinutes < 1) return;
    await run(
      registerExtra({
        householdId,
        agreementId,
        kind: registerKind,
        workedOn: registerDate,
        durationMinutes: Math.trunc(registerMinutes),
        note: registerNote
      })
    );
    registerNote = '';
    registerSent = true;
  }

  async function submitResolve(event: SubmitEvent, extraId: string): Promise<void> {
    event.preventDefault();
    if (!resolveReason.trim()) return;
    await run(
      resolveExtra({
        householdId,
        extraWorkEventId: extraId,
        resolution: resolveResolution,
        reason: resolveReason
      }),
      extraId
    );
    resolveOpenId = null;
    resolveReason = '';
  }
</script>

<article class="card">
  <div class="section-heading">
    <div><p class="eyebrow">Jornadas extra</p><h2>Pendientes de acordar o resolver</h2></div>
    {#if extras.length > 0}<span class="status-chip warning">{extras.length} sin resolver</span>{/if}
  </div>

  <div class="ledger-list">
    {#each extras as extra (extra.id)}
      <div id={`extra-${extra.id}`}>
        <span>
          <strong>{extra.kindLabel} · {extra.workedOnLabel}</strong>
          <small>{extra.durationLabel}{extra.note ? ` · ${extra.note}` : ''} · {extra.statusLabel}</small>
        </span>
        <span class="inline-actions">
          {#if acted.includes(extra.id)}
            <span class="status-chip success">Enviado</span>
          {:else}
            {#if canConfirm && extra.acceptable}
              <button
                class="button secondary small-button"
                type="button"
                disabled={busy}
                onclick={() => void run(acceptExtra({ householdId, extraWorkEventId: extra.id }), extra.id)}
              >Aceptar</button>
            {/if}
            {#if canConfirm && extra.resolvable}
              <button
                class="button secondary small-button"
                type="button"
                disabled={busy}
                aria-expanded={resolveOpenId === extra.id}
                onclick={() => { resolveOpenId = resolveOpenId === extra.id ? null : extra.id; resolveReason = ''; }}
              >Resolver</button>
            {/if}
            {#if canRegister && extra.performable && extra.employeeMembershipId === ownMembershipId}
              <button
                class="button secondary small-button"
                type="button"
                disabled={busy}
                onclick={() => void run(markExtraPerformed({ householdId, extraWorkEventId: extra.id }), extra.id)}
              >Marcar realizada</button>
            {/if}
          {/if}
        </span>
      </div>
      {#if canConfirm && resolveOpenId === extra.id && !acted.includes(extra.id)}
        <form class="action-form" onsubmit={(event) => void submitResolve(event, extra.id)}>
          <div class="form-grid">
            <label>Compensación
              <select bind:value={resolveResolution}>
                <option value="money">Pagar en dinero</option>
                <option value="time_off">Compensar con descanso</option>
              </select>
            </label>
            <label>Motivo
              <input type="text" bind:value={resolveReason} maxlength="500" required placeholder="Motivo de la resolución" />
            </label>
          </div>
          <div class="action-row">
            <button class="button primary small-button" type="submit" disabled={busy || !resolveReason.trim()}>Confirmar resolución</button>
            <small>La tarifa se congela en el servidor con la versión vigente del acuerdo.</small>
          </div>
        </form>
      {/if}
    {:else}
      <div><span><strong>Sin jornadas pendientes</strong><small>Todo lo registrado está resuelto.</small></span></div>
    {/each}
  </div>

  {#if canRegister}
    <form class="action-form" onsubmit={(event) => void submitRegister(event)}>
      <h3>Registrar jornada extra</h3>
      <div class="form-grid">
        <label>Tipo
          <select bind:value={registerKind}>
            <option value="overtime">Horas extraordinarias</option>
            <option value="worked_rest_day">Festivo o descanso trabajado</option>
          </select>
        </label>
        <label>Fecha
          <input type="date" bind:value={registerDate} required />
        </label>
        <label>Minutos
          <input type="number" bind:value={registerMinutes} min="1" max="1440" step="1" required />
        </label>
      </div>
      <label>Nota (opcional)
        <input type="text" bind:value={registerNote} maxlength="500" placeholder="Qué se trabajó y por qué" />
      </label>
      <div class="action-row">
        <button class="button primary small-button" type="submit" disabled={busy}>Registrar jornada extra</button>
        {#if registerSent && !queued}<span class="status-chip success">Enviada</span>{/if}
      </div>
    </form>
  {/if}

  {#if queued}
    <p class="queued-note" role="status">Guardado en este dispositivo; se sincronizará al recuperar la conexión.</p>
  {/if}
</article>
