<script lang="ts">
  import { untrack } from 'svelte';
  import { invalidateAll } from '$app/navigation';
  // El triaje arrastra los descriptores de todos los dominios: se carga como
  // chunk aparte (mismo mecanismo que WikiEditor) para respetar el presupuesto
  // de JavaScript inicial de Hoy.
  const OutboxTriage = import('$lib/components/OutboxTriage.svelte').then((module) => module.default);
  import PageHeader from '$lib/components/PageHeader.svelte';
  import { useAppContext } from '$lib/auth/context';
  import { completeRoutine, queueFoodCommand } from '$lib/food/commands';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const context = useAppContext();
  const canToggle = context.capabilities.includes('routine.toggle');

  const overview = $derived(data.overview);

  // ── Modo real (Postgres bajo RLS): rutinas accionables con el comando que el
  // servidor SÍ implementa (routine.complete), con guard anti doble-tap. ──────
  let busyRoutineId = $state<string | null>(null);
  let queued = $state(false);

  async function markRoutineDone(routineId: string, dueOn: string): Promise<void> {
    if (!overview || busyRoutineId !== null) return;
    busyRoutineId = routineId;
    try {
      const outcome = await queueFoodCommand(
        completeRoutine({ householdId: overview.householdId, routineId, dueOn })
      );
      if (outcome === 'synced') await invalidateAll();
      else queued = true;
    } finally {
      busyRoutineId = null;
    }
  }

  // ── Modo fixture (demo sin base de datos): las tareas de la maqueta se
  // marcan SOLO en memoria local. Nada entra en la outbox: el comando
  // routine_occurrence no existe en el servidor y dejaba un rechazo permanente
  // (UX-P1-2 / H-01 / F-02). ─────────────────────────────────────────────────
  let tasks = $state(untrack(() => (data.today?.tasks ?? []).map((task) => ({ ...task }))));
  let completeCount = $derived(tasks.filter((task) => task.done).length);

  function toggleTask(taskId: string): void {
    if (!canToggle) return;
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (task) task.done = !task.done;
  }
</script>

<svelte:head><title>Hoy · Casa Clara</title></svelte:head>

<div class="page-wrap today-page">
  {#if overview}
    <PageHeader
      eyebrow={overview.dateLabel}
      title={`${overview.greeting}, ${context.user.name}`}
      description="Lo importante de hoy, sin ruido."
    />

    {#await OutboxTriage then Triage}<Triage householdId={overview.householdId} />{/await}

    {#if queued}
      <p class="success-message" role="status">Cambio guardado en este dispositivo, pendiente de sincronizar.</p>
    {/if}

    {#if overview.decisions.length > 0}
      <section class="card" aria-labelledby="decisions-title">
        <div class="section-heading">
          <div><p class="eyebrow">Pendientes de ti</p><h2 id="decisions-title">Necesita tu decisión</h2></div>
          <span class="status-chip warning">{overview.decisions.length} {overview.decisions.length === 1 ? 'asunto' : 'asuntos'}</span>
        </div>
        <div class="ledger-list">
          {#each overview.decisions as item (item.key)}
            <div>
              <span>
                <strong>{item.title}</strong>
                <small>{item.detail}</small>
              </span>
              <a class="button secondary small-button" href={item.href}>{item.cta}</a>
            </div>
          {/each}
        </div>
      </section>
    {/if}

    <section class="content-grid" aria-label="Menú y rutinas de hoy">
      <article class="card" aria-labelledby="today-menu-title">
        <div class="section-heading">
          <div><p class="eyebrow">Menú</p><h2 id="today-menu-title">Hoy comemos</h2></div>
          {#if context.capabilities.includes('menu.read')}
            <a href={`/h/${overview.householdId}/menu`}>Ver la semana →</a>
          {/if}
        </div>
        {#if overview.menu.length > 0}
          <div class="ledger-list">
            {#each overview.menu as slot (slot.id)}
              <div>
                <span>
                  <strong>{slot.dish || 'Sin plato asignado'}</strong>
                  <small>{slot.mealLabel} · {slot.groupName}{slot.notes ? ` · ${slot.notes}` : ''}</small>
                </span>
                {#if slot.dish}
                  <span class="status-chip {slot.confirmed ? 'success' : 'warning'}">
                    {slot.confirmed ? 'Confirmado' : 'Sin confirmar'}
                  </span>
                {/if}
              </div>
            {/each}
          </div>
        {:else}
          <p class="audit-note">No hay huecos de menú asignados para hoy.</p>
        {/if}
      </article>

      <article class="card" id="rutinas-de-hoy" aria-labelledby="today-routines-title">
        <div class="section-heading">
          <div><p class="eyebrow">Rutinas</p><h2 id="today-routines-title">Vencen hoy</h2></div>
          <a href={`/h/${overview.householdId}/routines`}>Todas →</a>
        </div>
        {#if overview.routines.length > 0}
          <div class="ledger-list">
            {#each overview.routines as routine (routine.id)}
              <div>
                <span>
                  <strong>{routine.title}</strong>
                  <small>{routine.dueLabel}{routine.details ? ` · ${routine.details}` : ''}</small>
                </span>
                {#if routine.completedCurrent}
                  <span class="status-chip success">Hecha</span>
                {:else if canToggle}
                  <button
                    class="button secondary small-button"
                    type="button"
                    disabled={busyRoutineId !== null}
                    onclick={() => void markRoutineDone(routine.id, routine.nextDueOn)}
                  >Marcar hecha</button>
                {/if}
              </div>
            {/each}
          </div>
        {:else}
          <p class="audit-note">Ninguna rutina vence hoy.</p>
        {/if}
        {#if !canToggle && overview.routines.length > 0}
          <p class="card-footnote">Tu acceso permite consultar el día, pero no marcar rutinas.</p>
        {/if}
      </article>
    </section>
  {:else if data.today}
    <PageHeader eyebrow={data.today.dateLabel} title={`${data.today.greeting}, ${context.user.name}`} description="Lo importante de hoy, sin ruido." />

    {#await OutboxTriage then Triage}<Triage householdId={context.household.id} />{/await}

    <section class="hero-grid" aria-label="Resumen del día">
      <article class="card task-card">
        <div class="section-heading">
          <div><p class="eyebrow">Rutina de hoy</p><h2>{completeCount} de {tasks.length} completadas</h2></div>
          <span class="progress-ring" style={`--progress: ${(completeCount / tasks.length) * 360}deg`} aria-hidden="true"><i>{completeCount}/{tasks.length}</i></span>
        </div>
        <div class="task-list">
          {#each tasks as task}
            <button
              class="task-row"
              class:done={task.done}
              type="button"
              disabled={!canToggle}
              aria-pressed={task.done}
              onclick={() => toggleTask(task.id)}
            >
              <span class="task-check" aria-hidden="true">{task.done ? '✓' : ''}</span>
              <span class="task-time">{task.time}</span>
              <span class="task-copy"><strong>{task.title}</strong><small>{task.area}</small></span>
            </button>
          {/each}
        </div>
        {#if !canToggle}<p class="card-footnote">Tu acceso permite consultar el día, pero no marcar rutinas.</p>{/if}
      </article>

      <div class="today-side">
        <article class="card menu-card">
          <div class="section-heading"><div><p class="eyebrow">Menú</p><h2>Hoy comemos</h2></div>{#if context.capabilities.includes('menu.read')}<a href={`/h/${context.household.id}/menu`}>Ver semana →</a>{/if}</div>
          <div class="meal-list">
            {#each data.today.menu as meal}
              <div><time>{meal.time}</time><span><small>{meal.label}</small><strong>{meal.dish}</strong></span></div>
            {/each}
          </div>
        </article>

        <article class="card agenda-card">
          <div class="section-heading"><div><p class="eyebrow">Agenda</p><h2>Después</h2></div></div>
          {#each data.today.agenda as event}
            <div class="agenda-row"><time>{event.time}</time><span><strong>{event.title}</strong><small>{event.meta}</small></span></div>
          {/each}
        </article>
      </div>
    </section>

    <aside class="day-note"><span aria-hidden="true">✦</span><div><strong>Nota de la casa</strong><p>{data.today.note}</p></div></aside>
  {/if}
</div>
