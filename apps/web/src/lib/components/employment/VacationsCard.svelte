<script lang="ts">
  import ActionStatus from '$lib/components/ActionStatus.svelte';
  import { OptimisticActions } from '$lib/offline/optimistic';
  import { recordVacation, voidVacation } from '$lib/employment/commands';
  import { vacationDaysLabel, vacationRangeLabel, type VacationView } from '$lib/employment/model';

  let {
    householdId,
    agreementId,
    vacations,
    canRecord,
    allYearsLink = true
  }: {
    householdId: string;
    agreementId: string;
    vacations: VacationView;
    /** Solo la familia administradora apunta y anula; el resto solo mira. */
    canRecord: boolean;
    /** En la propia pestaña de Vacaciones el enlace se apuntaría a sí mismo. */
    allYearsLink?: boolean;
  } = $props();

  // Patrón wiki (P2-1): lo apuntado se pinta al instante y `invalidate`
  // selectivo trae el saldo recalculado; si el servidor lo rechaza, la fila
  // optimista desaparece y la nota unificada dice por qué.
  // svelte-ignore state_referenced_locally -- el hogar no cambia dentro de la página
  const optimistic = new OptimisticActions({ householdId, invalidateToken: 'cc:employment' });
  const actionStatus = optimistic.status;
  $effect(() => optimistic.start());

  let startsOn = $state('');
  let endsOn = $state('');
  let note = $state('');
  let formError = $state<string | null>(null);

  // Periodos ya anulados en esta sesión: el tachado aparece al instante y solo
  // vuelve atrás si el servidor rechaza la anulación.
  let voided = $state<string[]>([]);
  let voidOpenId = $state<string | null>(null);
  let voidReason = $state('');

  type Draft = { operationId: string; rangeLabel: string; daysLabel: string; note: string };
  let drafts = $state<Draft[]>([]);
  // Los datos frescos traen el periodo real: el borrador se retira comparando
  // por fechas, que es lo único que la fila optimista y la de verdad comparten.
  const pendingDrafts = $derived(
    drafts.filter((draft) => !vacations.periods.some((period) => period.rangeLabel === draft.rangeLabel))
  );

  function calendarDays(from: string, through: string): number {
    return Math.round(
      (Date.parse(`${through}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000
    ) + 1;
  }

  function record(event: SubmitEvent): void {
    event.preventDefault();
    if (!startsOn || !endsOn) return;
    if (endsOn < startsOn) {
      formError = 'La fecha de vuelta no puede ser anterior a la de salida.';
      return;
    }
    formError = null;

    // Mismo criterio de etiqueta que `buildVacationView`, para que el borrador
    // y la fila real que llega del servidor se reconozcan entre sí.
    const rangeLabel = vacationRangeLabel(startsOn, endsOn);
    const days = calendarDays(startsOn, endsOn);
    const trimmedNote = note.trim();
    const envelope = recordVacation({
      householdId,
      agreementId,
      startsOn,
      endsOn,
      ...(trimmedNote ? { note: trimmedNote } : {})
    });
    const removeDraft = () => {
      drafts = drafts.filter((draft) => draft.operationId !== envelope.operationId);
    };

    void optimistic.run(envelope, {
      apply: () => {
        drafts = [
          ...drafts,
          {
            operationId: envelope.operationId,
            rangeLabel,
            daysLabel: vacationDaysLabel(days),
            note: trimmedNote
          }
        ];
        startsOn = '';
        endsOn = '';
        note = '';
      },
      revert: removeDraft,
      settle: removeDraft,
      messageOverrides: {
        vacation_overlaps: 'Esas fechas se pisan con otras vacaciones ya apuntadas.',
        vacation_before_agreement: 'Esas fechas son anteriores al primer día de trabajo.',
        vacation_after_agreement: 'Esas fechas son posteriores al último día de trabajo.'
      }
    });
  }

  function annul(periodId: string): void {
    const reason = voidReason.trim();
    if (!reason) return;
    void optimistic.run(voidVacation({ householdId, vacationPeriodId: periodId, reason }), {
      apply: () => {
        voided = [...voided, periodId];
        voidOpenId = null;
        voidReason = '';
      },
      revert: () => {
        voided = voided.filter((candidate) => candidate !== periodId);
      }
    });
  }
</script>

<article class="card">
  <div class="section-heading">
    <div><p class="eyebrow">Vacaciones</p><h2>Días disfrutados y días que quedan</h2></div>
    <span class="status-chip {vacations.remainingDays < 0 ? 'warning' : 'success'}">
      {vacations.summaryLabel}
    </span>
  </div>

  <!-- El año va debajo del título y no en el epígrafe: el año de vacaciones es
       el del contrato, y sus fechas son justo lo que hace falta para entender
       de qué doce meses se habla. Por debajo de 600 px el epígrafe no se pinta,
       así que ahí se perderían. -->
  <p class="audit-note">{vacations.yearLabel}</p>

  {#if vacations.remainingDays < 0}
    <p class="audit-note" role="status">
      Se han apuntado más días de los que reconoce el contrato. La aplicación no lo corrige sola:
      lo enseña para que lo habléis y decidáis qué hacer.
    </p>
  {/if}

  {#if vacations.prorationNote}
    <p class="audit-note">{vacations.prorationNote}</p>
  {/if}

  <div class="ledger-list">
    <!-- Sin id por fila: el ancla `vacaciones-<id>` canónica la pinta el
         historial año a año de la propia página de Vacaciones, y dos ids
         iguales en el mismo documento dejan a uno de los dos inalcanzable. -->
    {#each vacations.periods as period (period.id)}
      <div>
        <span>
          <strong>{period.rangeLabel}</strong>
          <small>
            {#if period.voided || voided.includes(period.id)}
              Anulado{period.voidReason ? `: ${period.voidReason}` : ''} · no cuenta en el saldo
            {:else}
              {period.note || 'Vacaciones'}
            {/if}
          </small>
        </span>
        <span class="inline-actions">
          <strong>{period.voided || voided.includes(period.id) ? '—' : period.daysLabel}</strong>
          {#if canRecord && !period.voided}
            {#if voided.includes(period.id)}
              <span class="status-chip success">Anulado</span>
            {:else}
              <button
                class="button secondary small-button"
                type="button"
                aria-expanded={voidOpenId === period.id}
                onclick={() => {
                  voidOpenId = voidOpenId === period.id ? null : period.id;
                  voidReason = '';
                }}
              >Anular</button>
            {/if}
          {/if}
        </span>
      </div>
      {#if canRecord && voidOpenId === period.id && !period.voided && !voided.includes(period.id)}
        <form class="action-form" onsubmit={(event) => { event.preventDefault(); annul(period.id); }}>
          <label>Por qué se anula
            <input
              type="text"
              autocomplete="off"
              enterkeyhint="done"
              bind:value={voidReason}
              maxlength="500"
              required
              placeholder="Las fechas eran otras, al final no se cogieron…"
            />
          </label>
          <p class="audit-note">
            El periodo no se borra: se queda aquí anulado, con quién lo anuló y por qué.
          </p>
          <div class="action-row">
            <button class="button primary small-button" type="submit" disabled={!voidReason.trim()}>
              Anular el periodo
            </button>
          </div>
        </form>
      {/if}
    {:else}
      {#if pendingDrafts.length === 0}
        <div>
          <span>
            <strong>Todavía no hay vacaciones apuntadas en este año de contrato</strong>
            <p class="audit-note">Cuando disfrute días, se apuntan aquí y el saldo se ajusta solo.</p>
          </span>
        </div>
      {/if}
    {/each}
    {#each pendingDrafts as draft (draft.operationId)}
      <div>
        <span><strong>{draft.rangeLabel}</strong><small>{draft.note || 'Vacaciones'}</small></span>
        <span class="inline-actions"><strong>{draft.daysLabel}</strong></span>
      </div>
    {/each}
  </div>

  {#if canRecord}
    <form class="action-form" onsubmit={record}>
      <h3>Apuntar vacaciones</h3>
      <div class="form-grid">
        <label>Primer día
          <input type="date" bind:value={startsOn} required />
        </label>
        <label>Último día
          <input type="date" bind:value={endsOn} min={startsOn || undefined} required />
        </label>
      </div>
      <label>Nota (opcional)
        <input
          type="text"
          autocomplete="off"
          enterkeyhint="done"
          bind:value={note}
          maxlength="500"
          placeholder="Quincena de agosto, puente de mayo…"
        />
      </label>
      {#if formError}<p class="queued-note" role="alert">{formError}</p>{/if}
      <p class="audit-note">
        Se cuentan días naturales, festivos y fines de semana incluidos: del 1 al 15 son 15 días.
      </p>
      <div class="action-row">
        <button class="button primary small-button" type="submit">Apuntar vacaciones</button>
      </div>
    </form>
  {/if}

  <!-- Esta tarjeta es el año en curso, que es lo que se mira a diario. Todo lo
       demás —los años anteriores, lo anulado, y las otras personas si el hogar
       emplea a más de una— vive en su propia ruta, con su propio trozo de
       JavaScript, para no cargarlo aquí cada vez. -->
  {#if allYearsLink}
    <nav class="action-row">
      <a class="button secondary small-button" href={`/h/${householdId}/employment/vacaciones`}>
        Ver todos los años
      </a>
    </nav>
  {/if}

  <ActionStatus status={actionStatus} />
</article>
