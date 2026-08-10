<script lang="ts">
  import ActionStatus from '$lib/components/ActionStatus.svelte';
  import { OptimisticActions } from '$lib/offline/optimistic';
  import {
    acceptExtra,
    markExtraPerformed,
    registerExtra,
    resolveExtra
  } from '$lib/employment/commands';
  import {
    dateLabel,
    formatMinutes,
    type ExtraWorkTypeView,
    type PendingExtraWorkView
  } from '$lib/employment/model';

  let {
    householdId,
    agreementId,
    extras,
    types,
    ownMembershipId,
    canRegister,
    canRegisterForEmployee = false,
    employeeLabel = 'la empleada',
    canConfirm
  }: {
    householdId: string;
    agreementId: string;
    extras: PendingExtraWorkView[];
    /**
     * Conceptos con los que se puede registrar hoy. Llegan ya filtrados por la
     * RLS: si esta empleada no tiene horas permitidas, aquí no hay ninguna
     * opción por horas que elegir ni tarifa horaria que leer.
     */
    types: ExtraWorkTypeView[];
    ownMembershipId: string;
    canRegister: boolean;
    /**
     * Quien administra apunta la jornada a nombre de la empleada del acuerdo
     * que se está mirando, y puede cerrarla en el acto si ya ocurrió. El
     * servidor vuelve a comprobar el rol: esto solo decide qué se dibuja.
     */
    canRegisterForEmployee?: boolean;
    /** Nombre de esa persona, para no hablar de ella en abstracto. */
    employeeLabel?: string;
    canConfirm: boolean;
  } = $props();

  // El formulario es el mismo para las dos partes; lo que cambia es a nombre de
  // quién queda el hecho (lo decide el servidor por el acuerdo) y que quien
  // administra puede además decidir la compensación en el mismo gesto.
  const showRegisterForm = $derived(canRegister || canRegisterForEmployee);

  // Patrón wiki (P2-1): cada decisión pinta su chip al instante, con
  // `invalidate('cc:employment')` selectivo tras el ACK y reversión honesta
  // ante rejected/conflict. Sin `busy` de tarjeta: acciones encadenables.
  // svelte-ignore state_referenced_locally -- el hogar no cambia dentro de la página
  const optimistic = new OptimisticActions({ householdId, invalidateToken: 'cc:employment' });
  const actionStatus = optimistic.status;
  $effect(() => optimistic.start());

  // Entidades ya actuadas: el chip sustituye a los botones al instante y solo
  // vuelve atrás si el servidor rechaza la decisión.
  let acted = $state<string[]>([]);

  let resolveOpenId = $state<string | null>(null);
  let resolveResolution = $state<'money' | 'time_off'>('money');
  let resolveReason = $state('');

  // svelte-ignore state_referenced_locally -- el catálogo no cambia dentro de la página
  let registerTypeId = $state<string>(types[0]?.id ?? '');
  const registerType = $derived(types.find((type) => type.id === registerTypeId) ?? null);
  let registerDate = $state(new Date().toISOString().slice(0, 10));
  // P2-7 (revisión UX v3): la duración se pide en horas y minutos; el contrato
  // sigue viajando en minutos (durationMinutes) sin cambios.
  let registerHours = $state(1);
  let registerExtraMinutes = $state(0);
  let registerNote = $state('');
  let registerSent = $state(false);
  const registerMinutes = $derived(
    Math.trunc(Number(registerHours) || 0) * 60 + Math.trunc(Number(registerExtraMinutes) || 0)
  );

  // Cierre en el acto (solo quien administra): apuntar algo que ya pasó y decir
  // ya cómo se compensa. Va apagado por defecto —decidir es un acto aparte— y
  // exige motivo, igual que decidir la compensación de una jornada pendiente.
  let registerResolveNow = $state(false);
  let registerResolution = $state<'money' | 'time_off'>('money');
  let registerResolveReason = $state('');
  const resolvingNow = $derived(canRegisterForEmployee && registerResolveNow);
  const registerBlocked = $derived(resolvingNow && !registerResolveReason.trim());

  // La duración solo la pone quien trabaja cuando el concepto se paga POR HORA.
  // En una jornada o un importe fijo la duración es la pactada, y pedirla haría
  // creer que cambia el importe.
  const durationIsChosen = $derived(registerType?.unit === 'per_hour');

  // Alta optimista de jornadas: la fila nueva aparece YA como «Solicitada» y
  // se dedupe cuando los datos frescos la traen del servidor.
  type OptimisticExtra = {
    operationId: string;
    kindLabel: string;
    workedOnLabel: string;
    durationLabel: string;
    note: string;
    originLabel: string;
    statusLabel: string;
  };
  let optimisticExtras = $state<OptimisticExtra[]>([]);
  const pendingOptimistic = $derived(
    optimisticExtras.filter(
      (draft) =>
        !extras.some((extra) => extra.workedOnLabel === draft.workedOnLabel && extra.durationLabel === draft.durationLabel && (extra.note ?? '') === draft.note)
    )
  );

  function runDecision(envelope: Parameters<typeof optimistic.run>[0], entityId: string): void {
    void optimistic.run(envelope, {
      apply: () => {
        acted = [...acted, entityId];
      },
      revert: () => {
        acted = acted.filter((candidate) => candidate !== entityId);
      }
    });
  }

  function submitRegister(event: SubmitEvent): void {
    event.preventDefault();
    const type = registerType;
    if (!type || !registerDate || registerBlocked) return;
    // Para lo que no se paga por hora, la duración es la de referencia del
    // concepto (y 1 minuto si no pactó ninguna: el contrato exige un positivo).
    const minutes = durationIsChosen ? registerMinutes : (type.referenceMinutes ?? 1);
    if (minutes < 1 || minutes > 1440) return;
    const note = registerNote.trim();
    // Quien administra apunta a nombre de otra persona: el hecho queda con
    // origen «la apuntó la familia» y por eso el borrador optimista ya lo dice.
    const originLabel = canRegisterForEmployee
      ? 'La apuntó la familia'
      : 'La apuntó la empleada';
    const resolveNowInput = resolvingNow
      ? { resolution: registerResolution, reason: registerResolveReason }
      : undefined;
    const envelope = registerExtra({
      householdId,
      agreementId,
      extraWorkTypeId: type.id,
      kind: type.unit === 'per_hour' ? 'overtime' : 'worked_rest_day',
      workedOn: registerDate,
      durationMinutes: minutes,
      note: registerNote,
      ...(resolveNowInput ? { resolveNow: resolveNowInput } : {})
    });
    const removeDraft = () => {
      optimisticExtras = optimisticExtras.filter((draft) => draft.operationId !== envelope.operationId);
    };
    void optimistic.run(envelope, {
      apply: () => {
        optimisticExtras = [
          ...optimisticExtras,
          {
            operationId: envelope.operationId,
            kindLabel: type.name,
            workedOnLabel: dateLabel(registerDate),
            durationLabel: formatMinutes(minutes),
            note,
            originLabel,
            statusLabel: resolveNowInput
              ? resolveNowInput.resolution === 'money'
                ? 'Hecha y a pagar'
                : 'Hecha y compensada con descanso'
              : 'Solicitada'
          }
        ];
        registerNote = '';
        registerResolveReason = '';
        registerSent = true;
      },
      revert: () => {
        removeDraft();
        registerSent = false;
      },
      settle: removeDraft
    });
  }

  function submitResolve(event: SubmitEvent, extraId: string): void {
    event.preventDefault();
    if (!resolveReason.trim()) return;
    const envelope = resolveExtra({
      householdId,
      extraWorkEventId: extraId,
      resolution: resolveResolution,
      reason: resolveReason
    });
    resolveOpenId = null;
    resolveReason = '';
    runDecision(envelope, extraId);
  }
</script>

<article class="card">
  <div class="section-heading">
    <div><p class="eyebrow">Jornadas extra</p><h2>Pendientes de acordar o compensar</h2></div>
    {#if extras.length > 0}<span class="status-chip warning">{extras.length} {extras.length === 1 ? 'pendiente' : 'pendientes'}</span>{/if}
  </div>

  <div class="ledger-list">
    {#each extras as extra (extra.id)}
      <div id={`extra-${extra.id}`}>
        <span>
          <strong>{extra.kindLabel} · {extra.workedOnLabel}</strong>
          <!-- El origen va con el hecho: ella tiene que ver de un vistazo
               cuáles apuntó la familia a su nombre y cuáles apuntó ella. -->
          <small>{extra.durationLabel}{extra.note ? ` · ${extra.note}` : ''} · {extra.originLabel} · {extra.statusLabel}</small>
        </span>
        <span class="inline-actions">
          {#if acted.includes(extra.id)}
            <span class="status-chip success">Enviado</span>
          {:else}
            {#if canConfirm && extra.acceptable}
              <button
                class="button secondary small-button"
                type="button"
                onclick={() => runDecision(acceptExtra({ householdId, extraWorkEventId: extra.id }), extra.id)}
              >Aceptar</button>
            {/if}
            {#if canConfirm && extra.resolvable}
              <button
                class="button secondary small-button"
                type="button"
                aria-expanded={resolveOpenId === extra.id}
                onclick={() => { resolveOpenId = resolveOpenId === extra.id ? null : extra.id; resolveReason = ''; }}
              >Decidir compensación</button>
            {/if}
            {#if canRegister && extra.performable && extra.employeeMembershipId === ownMembershipId}
              <button
                class="button secondary small-button"
                type="button"
                onclick={() => runDecision(markExtraPerformed({ householdId, extraWorkEventId: extra.id }), extra.id)}
              >Marcar realizada</button>
            {/if}
          {/if}
        </span>
      </div>
      {#if canConfirm && resolveOpenId === extra.id && !acted.includes(extra.id)}
        <form class="action-form" onsubmit={(event) => submitResolve(event, extra.id)}>
          <div class="form-grid">
            <label>Compensación
              <select bind:value={resolveResolution}>
                <option value="money">Pagarla</option>
                <option value="time_off">Darle descanso</option>
              </select>
            </label>
            <label>Motivo
              <input type="text" autocomplete="off" enterkeyhint="done" bind:value={resolveReason} maxlength="500" required placeholder="Por qué se decide así" />
            </label>
          </div>
          <div class="action-row">
            <button class="button primary small-button" type="submit" disabled={!resolveReason.trim()}>Confirmar la decisión</button>
            <small>Se pagará con la tarifa acordada en la fecha en que se trabajó.</small>
          </div>
        </form>
      {/if}
    {:else}
      {#if pendingOptimistic.length === 0}
        <div><span><strong>Sin jornadas pendientes</strong><small>Todo lo registrado está resuelto.</small></span></div>
      {/if}
    {/each}
    {#each pendingOptimistic as draft (draft.operationId)}
      <div>
        <span>
          <strong>{draft.kindLabel} · {draft.workedOnLabel}</strong>
          <small>{draft.durationLabel}{draft.note ? ` · ${draft.note}` : ''} · {draft.originLabel} · {draft.statusLabel}</small>
        </span>
      </div>
    {/each}
  </div>

  {#if showRegisterForm && types.length === 0}
    <div class="ledger-list"><div><span><strong>Sin trabajo extra disponible</strong><small>
Este acuerdo no permite registrar trabajo extra por ahora. Cuando se pacte un concepto con su tarifa, aparecerá aquí.</small></span></div></div>
  {:else if showRegisterForm}
    <!-- Clase propia: con quien administra en la tarjeta conviven el formulario
         de decidir compensación y este, y hay que poder apuntar a uno solo. -->
    <form class="action-form register-extra-form" onsubmit={submitRegister}>
      <!-- Quien administra apunta A NOMBRE de alguien y conviene decirlo con
           su nombre: el hecho se queda en el expediente de esa persona. -->
      <h3>{canRegisterForEmployee ? `Apuntar una jornada a ${employeeLabel}` : 'Registrar jornada extra'}</h3>
      <div class="form-grid">
        <label>Tipo
          <select bind:value={registerTypeId}>
            {#each types as type (type.id)}
              <option value={type.id}>{type.name}{type.rateLabel ? ` · ${type.rateLabel}` : ''}</option>
            {/each}
          </select>
        </label>
        <label>Fecha
          <input type="date" bind:value={registerDate} required />
        </label>
        {#if durationIsChosen}
          <label>Horas
            <input type="number" inputmode="numeric" enterkeyhint="next" bind:value={registerHours} min="0" max="24" step="1" required />
          </label>
          <label>Y minutos
            <input type="number" inputmode="numeric" enterkeyhint="next" bind:value={registerExtraMinutes} min="0" max="59" step="1" required />
          </label>
        {:else if registerType?.referenceLabel}
          <p><small>{registerType.referenceLabel}, según lo pactado.</small></p>
        {/if}
      </div>
      <label>Nota (opcional)
        <input type="text" autocomplete="off" enterkeyhint="done" bind:value={registerNote} maxlength="500" placeholder="Qué se trabajó y por qué" />
      </label>
      {#if canRegisterForEmployee}
        <!-- Apuntar por otra persona suele ser apuntar lo que YA pasó: aquí se
             cierra en el mismo gesto, sin pedirle a ella que vuelva a marcar
             como hecha una jornada de la semana pasada. -->
        <label class="inline-check">
          <input type="checkbox" bind:checked={registerResolveNow} />
          Ya la hizo: decidir ahora la compensación
        </label>
        {#if registerResolveNow}
          <div class="form-grid">
            <label>Compensación
              <select bind:value={registerResolution}>
                <option value="money">Pagarla</option>
                <option value="time_off">Darle descanso</option>
              </select>
            </label>
            <label>Motivo
              <input type="text" autocomplete="off" enterkeyhint="done" bind:value={registerResolveReason} maxlength="500" required placeholder="Por qué se decide así" />
            </label>
          </div>
        {/if}
      {/if}
      <div class="action-row">
        <button class="button primary small-button" type="submit" disabled={registerBlocked}>
          {canRegisterForEmployee ? 'Apuntar la jornada' : 'Registrar jornada extra'}
        </button>
        {#if registerSent}<span class="status-chip success">Enviada</span>{/if}
        {#if resolvingNow}
          <small>Se valora con la tarifa del concepto acordada en la fecha en que se trabajó.</small>
        {/if}
      </div>
    </form>
  {/if}

  <ActionStatus status={actionStatus} />
</article>
