<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import { untrack } from 'svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import { useAppContext } from '$lib/auth/context';
  import { queueOutbox } from '$lib/offline/idb';
  import { createCommandEnvelope, createOutboxRecord } from '$lib/offline/schema';
  import { refreshSyncStatus } from '$lib/offline/sync';
  import {
    completeRoutine,
    queueFoodCommand,
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
  const FREQUENCY_LABEL: Record<RoutineFrequency, string> = {
    daily: 'día(s)',
    weekly: 'semana(s)',
    monthly: 'mes(es)',
    quarterly: 'trimestre(s)'
  };
  const DUE_LABEL = new Intl.DateTimeFormat('es-ES', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  // Hoy en la zona del hogar: default natural de «próxima fecha» en el alta.
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());

  // Las acciones de escritura reales solo existen sobre datos de Postgres; en
  // modo fixture la página conserva el toggle de demostración local.
  let queued = $state(false);
  let busy = $state(false);

  async function dispatch(envelope: Parameters<typeof queueFoodCommand>[0]): Promise<'synced' | 'queued'> {
    busy = true;
    try {
      const outcome = await queueFoodCommand(envelope);
      if (outcome === 'synced') await invalidateAll();
      else queued = true;
      return outcome;
    } finally {
      busy = false;
    }
  }

  // Guard anti doble disparo: el botón de la rutina queda deshabilitado desde
  // el click hasta que llegan datos frescos, y el resultado se anuncia con un
  // feedback visible en la propia fila (no solo la fecha pequeña).
  let completingId = $state<string | null>(null);
  let completedFeedback = $state<Record<string, string>>({});

  async function complete(routineId: string, dueOn: string): Promise<void> {
    if (!live || completingId !== null) return;
    completingId = routineId;
    try {
      const outcome = await dispatch(completeRoutine({ householdId: live.householdId, routineId, dueOn }));
      const fresh = live.routines.find((candidate) => candidate.id === routineId);
      completedFeedback = {
        ...completedFeedback,
        [routineId]:
          outcome === 'synced' && fresh
            ? `Hecha ✓ · próxima el ${DUE_LABEL.format(new Date(`${fresh.nextDueOn}T00:00:00Z`))}`
            : 'Hecha ✓ · pendiente de sincronizar'
      };
    } finally {
      completingId = null;
    }
  }

  // ── Crear/editar rutina (familia) ──────────────────────────────────────────
  let routineId = $state('');
  let routineTitle = $state('');
  let routineDetails = $state('');
  let routineAudience = $state<RoutineAudience>('all');
  let routineFrequency = $state<RoutineFrequency>('weekly');
  let routineInterval = $state(1);
  let routineNextDue = $state(today);

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
    if (!live || !routineTitle.trim() || !routineNextDue) return;
    void dispatch(
      upsertRoutine({
        householdId: live.householdId,
        routineId: routineId || undefined,
        title: routineTitle,
        details: routineDetails,
        audience: routineAudience,
        frequency: routineFrequency,
        intervalCount: routineInterval,
        nextDueOn: routineNextDue
      })
    ).then(resetRoutineForm);
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

<svelte:head><title>Rutinas · Casa Clara</title></svelte:head>

<div class="page-wrap">
  {#if live}
    <PageHeader eyebrow="Orden cotidiano" title="Rutinas" description="Cada rutina con su próxima fecha; sin porcentajes ni histórico." />

    {#if queued}<p class="success-message" role="status">Cambio guardado en la outbox local, pendiente de sincronizar.</p>{/if}

    <section class="card" aria-labelledby="routines-title">
      <div class="section-heading"><div><p class="eyebrow">Visibles para tu rol</p><h2 id="routines-title">Rutinas de la casa</h2></div></div>
      <ul class="wiki-recent">
        {#each live.routines as routine (routine.id)}
          <li>
            <div class="wiki-node-row">
              <span>
                <strong>{routine.title}</strong>
                <small>
                  {AUDIENCE_LABEL[routine.audience]} · cada {routine.intervalCount} {FREQUENCY_LABEL[routine.frequency]}
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
                  disabled={busy || completingId === routine.id}
                  onclick={() => void complete(routine.id, routine.nextDueOn)}
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
            <input type="text" bind:value={routineTitle} maxlength="160" required />
          </label>
          <label>Detalles
            <input type="text" bind:value={routineDetails} maxlength="1000" />
          </label>
          <label>Audiencia
            <select bind:value={routineAudience}>
              <option value="all">Toda la casa</option>
              <option value="family">Familia</option>
              <option value="employee">Empleada</option>
            </select>
          </label>
          <label>Frecuencia
            <select bind:value={routineFrequency}>
              <option value="daily">Diaria</option>
              <option value="weekly">Semanal</option>
              <option value="monthly">Mensual</option>
              <option value="quarterly">Trimestral</option>
            </select>
          </label>
          <label>Cada cuántas (1–12)
            <input type="number" min="1" max="12" bind:value={routineInterval} required />
          </label>
          <label>Próxima fecha
            <input type="date" bind:value={routineNextDue} required />
          </label>
          <div class="menu-slot-actions">
            <button class="button primary" type="submit" disabled={busy}>{routineId ? 'Guardar rutina' : 'Crear rutina'}</button>
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
