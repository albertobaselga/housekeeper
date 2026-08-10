<script lang="ts">
  import { untrack } from 'svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import ActionStatus from '$lib/components/ActionStatus.svelte';
  import { useAppContext } from '$lib/auth/context';
  import { queueOutbox } from '$lib/offline/idb';
  import { createCommandEnvelope, createOutboxRecord } from '$lib/offline/schema';
  import { refreshSyncStatus } from '$lib/offline/sync';
  import { OptimisticActions } from '$lib/offline/optimistic';
  import { routineCadenceLabel, routineUnitLabel } from '$lib/food/cadence';
  import { nextRoutineDue } from '$lib/food/dates';
  import {
    completeRoutine,
    upsertRoutine,
    type RoutineAudience,
    type RoutineFrequency
  } from '$lib/food/commands';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const context = useAppContext();

  const live = $derived(data.live);
  const canToggle = context.capabilities.includes('routine.toggle');

  const AUDIENCE_LABEL: Record<RoutineAudience, string> = {
    family: 'Familia',
    employee: 'Empleada',
    all: 'Toda la casa'
  };
  const DUE_LABEL = new Intl.DateTimeFormat('es-ES', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  // Hoy en la zona del hogar: default natural de «próxima fecha» en el alta.
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());

  // Patrón wiki replicado (P2-1): pintado optimista inmediato, invalidate
  // selectivo ('cc:routines') tras el ACK y reversión ante rejected/conflict.
  const optimistic = new OptimisticActions({ householdId: context.household.id, invalidateToken: 'cc:routines' });
  const actionStatus = optimistic.status;
  $effect(() => optimistic.start());

  // «Marcar hecha» optimista: el chip «Hecha ✓ · próxima el X» se pinta al
  // instante con la MISMA fecha que confirmará el servidor (nextRoutineDue).
  // El guard es POR RUTINA: otras filas siguen accionables (taps encadenables).
  let completingIds = $state<Record<string, true>>({});
  let completedFeedback = $state<Record<string, string>>({});

  function complete(routine: { id: string; nextDueOn: string; frequency: RoutineFrequency; intervalCount: number }): void {
    if (!live || completingIds[routine.id]) return;
    completingIds[routine.id] = true;
    const predictedDue = nextRoutineDue(routine.nextDueOn, routine.frequency, routine.intervalCount);
    const chip = `Hecha ✓ · próxima el ${DUE_LABEL.format(new Date(`${predictedDue}T00:00:00Z`))}`;
    void optimistic
      .run(completeRoutine({ householdId: live.householdId, routineId: routine.id, dueOn: routine.nextDueOn }), {
        apply: () => {
          completedFeedback[routine.id] = chip;
        },
        revert: () => {
          delete completedFeedback[routine.id];
          delete completingIds[routine.id];
        },
        settle: () => {
          // Los datos frescos ya traen la nueva fecha: la fila vuelve a ser
          // accionable para la SIGUIENTE ocurrencia.
          delete completingIds[routine.id];
        }
      })
      .catch(() => {
        delete completingIds[routine.id];
      });
  }

  // ── Crear/editar rutina (familia) ──────────────────────────────────────────
  let routineId = $state('');
  let routineTitle = $state('');
  let routineDetails = $state('');
  let routineAudience = $state<RoutineAudience>('all');
  let routineFrequency = $state<RoutineFrequency>('weekly');
  let routineInterval = $state(1);
  let routineNextDue = $state(today);
  let formBusy = $state(false);

  function editRoutineForm(id: string): void {
    const routine = live?.routines.find((candidate) => candidate.id === id);
    if (!routine) return;
    routineId = routine.id;
    routineTitle = routine.title;
    routineDetails = routine.details;
    routineAudience = routine.audience;
    routineFrequency = routine.frequency;
    routineInterval = routine.intervalCount;
    routineNextDue = routine.nextDueOn;
  }

  function resetRoutineForm(): void {
    routineId = '';
    routineTitle = '';
    routineDetails = '';
    routineAudience = 'all';
    routineFrequency = 'weekly';
    routineInterval = 1;
    routineNextDue = today;
  }

  function submitRoutine(event: SubmitEvent): void {
    event.preventDefault();
    if (!live || !routineTitle.trim() || !routineNextDue || formBusy) return;
    formBusy = true;
    void optimistic
      .run(
        upsertRoutine({
          householdId: live.householdId,
          routineId: routineId || undefined,
          title: routineTitle,
          details: routineDetails,
          audience: routineAudience,
          frequency: routineFrequency,
          intervalCount: routineInterval,
          nextDueOn: routineNextDue
        }),
        { apply: resetRoutineForm }
      )
      .finally(() => {
        formBusy = false;
      });
  }

  // Modo fixture (sin base de datos): toggle local de demostración.
  let groups = $state(untrack(() => (data.routines?.groups ?? []).map((group) => ({ ...group, items: group.items.map((item) => ({ ...item })) }))));
  let done = $derived(groups.flatMap((group) => group.items).filter((item) => item.done).length);
  let total = $derived(groups.flatMap((group) => group.items).length);

  async function toggle(itemId: string): Promise<void> {
    const item = groups.flatMap((group) => group.items).find((candidate) => candidate.id === itemId);
    if (!item) return;
    item.done = !item.done;
    await queueOutbox(createOutboxRecord(createCommandEnvelope({
      householdId: context.household.id,
      aggregateType: 'routine_occurrence',
      payload: { itemId, done: item.done }
    })));
    await refreshSyncStatus();
  }
</script>

<div class="page-wrap">
  {#if live}
    <PageHeader eyebrow="Orden cotidiano" title="Rutinas" description="Cada rutina con su próxima fecha; sin porcentajes ni histórico." />

    <ActionStatus status={actionStatus} />

    <section class="card" aria-labelledby="routines-title">
      <div class="section-heading"><div><p class="eyebrow">Visibles para tu rol</p><h2 id="routines-title">Rutinas de la casa</h2></div></div>
      <ul class="wiki-recent">
        {#each live.routines as routine (routine.id)}
          <li>
            <div class="wiki-node-row">
              <span>
                <strong>{routine.title}</strong>
                <small>
                  {AUDIENCE_LABEL[routine.audience]} · {routineCadenceLabel(routine.frequency, routine.intervalCount)}
                  · próxima: {DUE_LABEL.format(new Date(`${routine.nextDueOn}T00:00:00Z`))}
                </small>
                {#if routine.details}<small>{routine.details}</small>{/if}
              </span>
              {#if routine.completedCurrent}
                <span class="status-chip success">Hecha</span>
              {:else if canToggle}
                {#if completedFeedback[routine.id]}
                  <span class="status-chip success" role="status">{completedFeedback[routine.id]}</span>
                {/if}
                <button
                  class="button secondary small-button"
                  type="button"
                  disabled={completingIds[routine.id]}
                  onclick={() => complete(routine)}
                >
                  Marcar hecha
                </button>
              {/if}
              {#if live.canWrite}
                <button class="button secondary small-button" type="button" onclick={() => editRoutineForm(routine.id)}>Editar</button>
              {/if}
            </div>
          </li>
        {:else}
          <li><p class="audit-note">No hay rutinas visibles para tu rol en este hogar.</p></li>
        {/each}
      </ul>
    </section>

    {#if live.canWrite}
      <section class="card" aria-labelledby="routine-form-title">
        <div class="section-heading"><div><p class="eyebrow">Organizar</p><h2 id="routine-form-title">{routineId ? 'Editar rutina' : 'Nueva rutina'}</h2></div></div>
        <form class="action-form" onsubmit={submitRoutine}>
          <label>Título
            <input type="text" autocomplete="off" enterkeyhint="next" bind:value={routineTitle} maxlength="160" required />
          </label>
          <label>Detalles
            <input type="text" autocomplete="off" enterkeyhint="next" bind:value={routineDetails} maxlength="1000" />
          </label>
          <label>¿Quién la hace?
            <select bind:value={routineAudience}>
              <option value="all">Toda la casa</option>
              <option value="family">Familia</option>
              <option value="employee">Empleada</option>
            </select>
          </label>
          <!-- P2-2: la repetición se decide como una sola frase, no como tres
               campos acoplados. Las etiquetas del desplegable concuerdan en
               número con la cifra elegida («1 semana», «2 semanas»). -->
          <fieldset class="repeat-fieldset">
            <legend>Se repite</legend>
            <div class="repeat-phrase">
              <span aria-hidden="true">cada</span>
              <input
                type="number"
                inputmode="numeric"
                enterkeyhint="next"
                min="1"
                max="12"
                bind:value={routineInterval}
                aria-label="Se repite cada cuántas"
                required
              />
              <select bind:value={routineFrequency} aria-label="Unidad de repetición">
                <option value="daily">{routineUnitLabel('daily', routineInterval)}</option>
                <option value="weekly">{routineUnitLabel('weekly', routineInterval)}</option>
                <option value="monthly">{routineUnitLabel('monthly', routineInterval)}</option>
                <option value="quarterly">{routineUnitLabel('quarterly', routineInterval)}</option>
              </select>
            </div>
          </fieldset>
          <label>Próxima fecha
            <input type="date" bind:value={routineNextDue} required />
          </label>
          <div class="menu-slot-actions">
            <button class="button primary" type="submit" disabled={formBusy}>{routineId ? 'Guardar rutina' : 'Crear rutina'}</button>
            {#if routineId}<button class="button secondary" type="button" onclick={resetRoutineForm}>Cancelar edición</button>{/if}
          </div>
        </form>
      </section>
    {/if}
  {:else if data.routines}
    <PageHeader eyebrow="Orden cotidiano" title="Rutinas" description="Pasos pequeños y compartidos, con progreso local aunque falte la red." />
    <section class="routine-progress card"><div><p class="eyebrow">Progreso de hoy</p><h2>{done} de {total} tareas</h2></div><progress max={total} value={done}>{done} de {total}</progress><strong>{Math.round(done / total * 100)}%</strong></section>
    <div class="routine-columns">
      {#each groups as group}
        <section class="card routine-group"><h2>{group.title}</h2>
          {#each group.items as item}
            <button type="button" class:done={item.done} aria-pressed={item.done} onclick={() => void toggle(item.id)}><span aria-hidden="true">{item.done ? '✓' : ''}</span><strong>{item.title}</strong></button>
          {/each}
        </section>
      {/each}
    </div>
  {/if}
</div>
