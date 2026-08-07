<script lang="ts">
  import ActionStatus from '$lib/components/ActionStatus.svelte';
  import { OptimisticActions } from '$lib/offline/optimistic';
  import { submitWeek } from '$lib/employment/commands';
  import { dateLabel, type WeeklyReportView } from '$lib/employment/model';
  import {
    MAX_WEEK_ROWS,
    buildWeekEntries,
    currentWeekMonday,
    localIsoDate,
    weekDays,
    type WeekEntryDraft
  } from '$lib/employment/week';

  let {
    householdId,
    agreementId,
    recentReports,
    canSubmit
  }: {
    householdId: string;
    agreementId: string;
    recentReports: WeeklyReportView[];
    canSubmit: boolean;
  } = $props();

  // El lunes de la semana en curso se calcula en el cliente, en la zona del hogar.
  const weekStartsOn = currentWeekMonday();
  const days = weekDays(weekStartsOn);
  const today = localIsoDate();

  // Una semana ya enviada no admite reenvío: el servidor la rechazaría como
  // week_already_reported, así que el formulario ni siquiera se ofrece.
  const alreadyReported = $derived(
    recentReports.some((report) => report.weekStartsOn === weekStartsOn)
  );

  // Patrón wiki (P2-1): el chip «Semana enviada» se pinta al instante, con
  // `invalidate('cc:employment')` selectivo tras el ACK y reversión honesta.
  // svelte-ignore state_referenced_locally -- el hogar no cambia dentro de la página
  const optimistic = new OptimisticActions({ householdId, invalidateToken: 'cc:employment' });
  const actionStatus = optimistic.status;
  $effect(() => optimistic.start());

  let rows = $state<WeekEntryDraft[]>([
    { workedOn: days.includes(today) ? today : days[0]!, minutes: 480, note: '' }
  ]);
  let sent = $state(false);
  let error = $state<string | null>(null);

  function addRow(): void {
    if (rows.length >= MAX_WEEK_ROWS) return;
    const used = new Set(rows.map((row) => row.workedOn));
    const nextDay = days.find((day) => !used.has(day)) ?? days[0]!;
    rows = [...rows, { workedOn: nextDay, minutes: 480, note: '' }];
  }

  function removeRow(index: number): void {
    if (rows.length <= 1) return;
    rows = rows.filter((_, position) => position !== index);
  }

  function submit(event: SubmitEvent): void {
    event.preventDefault();
    const result = buildWeekEntries(weekStartsOn, rows);
    if (!result.ok) {
      error = result.error;
      return;
    }
    error = null;
    void optimistic.run(submitWeek({ householdId, agreementId, weekStartsOn, entries: result.entries }), {
      // El chip «Semana enviada» sustituye al formulario al instante; si el
      // servidor rechaza el parte, el formulario vuelve con la causa visible.
      apply: () => {
        sent = true;
      },
      revert: () => {
        sent = false;
      }
    });
  }
</script>

<article class="card">
  <div class="section-heading">
    <div><p class="eyebrow">Mi semana</p><h2>Parte semanal de tiempo</h2></div>
    {#if alreadyReported || sent}
      <span class="status-chip success">Semana enviada</span>
    {/if}
  </div>

  {#if canSubmit && !alreadyReported && !sent}
    <form class="action-form" onsubmit={submit}>
      <p class="audit-note">Semana en curso: del {dateLabel(days[0]!)} al {dateLabel(days[6]!)}. Una fila por día trabajado.</p>
      {#each rows as row, index (index)}
        <div class="form-grid">
          <label>Día
            <input type="date" bind:value={row.workedOn} min={days[0]} max={days[6]} required />
          </label>
          <label>Minutos trabajados
            <input type="number" bind:value={row.minutes} min="0" max="1440" step="1" required />
          </label>
          <label>Nota (opcional)
            <input type="text" bind:value={row.note} maxlength="500" placeholder="Detalle del día" />
          </label>
          {#if rows.length > 1}
            <button
              class="button secondary small-button"
              type="button"
              onclick={() => removeRow(index)}
            >Quitar día</button>
          {/if}
        </div>
      {/each}
      {#if error}<p class="queued-note" role="alert">{error}</p>{/if}
      <div class="action-row">
        <button
          class="button secondary small-button"
          type="button"
          disabled={rows.length >= MAX_WEEK_ROWS}
          onclick={addRow}
        >Añadir día</button>
        <button class="button primary small-button" type="submit">Enviar parte semanal</button>
        <small>Al enviarlo, la familia tiene tres días para confirmarlo o disputarlo.</small>
      </div>
    </form>
  {:else if canSubmit && alreadyReported}
    <p class="audit-note">Esta semana ya está enviada; no se puede reenviar.</p>
  {/if}

  <ActionStatus status={actionStatus} />

  <div class="ledger-list">
    {#each recentReports as report (report.id)}
      <div>
        <span>
          <strong>{report.weekLabel}</strong>
          <small>
            {report.statusLabel}{report.disputeReason ? ` · ${report.disputeReason}` : ''}
          </small>
        </span>
        <span class="status-chip {report.status === 'confirmed' ? 'success' : 'warning'}">
          {report.status === 'confirmed' ? (report.autoConfirmed ? 'Auto-confirmado' : 'Confirmado') : report.status === 'disputed' ? 'Disputado' : 'Enviado'}
        </span>
      </div>
    {:else}
      <div><span><strong>Sin partes recientes</strong><small>Todavía no hay semanas enviadas.</small></span></div>
    {/each}
  </div>
</article>
