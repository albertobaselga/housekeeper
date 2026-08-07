<script lang="ts">
  import { untrack } from 'svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import { useAppContext } from '$lib/auth/context';
  import { createOutboxRecord } from '$lib/offline/schema';
  import { queueOutbox } from '$lib/offline/idb';
  import { refreshSyncStatus } from '$lib/offline/sync';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const context = useAppContext();
  const canToggle = context.capabilities.includes('routine.toggle');
  let tasks = $state(untrack(() => data.today.tasks.map((task) => ({ ...task }))));
  let completeCount = $derived(tasks.filter((task) => task.done).length);

  async function toggleTask(taskId: string): Promise<void> {
    if (!canToggle) return;
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (!task) return;
    task.done = !task.done;
    const id = crypto.randomUUID();
    await queueOutbox(createOutboxRecord({
      id,
      idempotencyKey: id,
      householdId: context.household.id,
      operation: 'routine.toggle',
      payload: { taskId, done: task.done }
    }));
    await refreshSyncStatus();
  }
</script>

<svelte:head><title>Hoy · Casa Clara</title></svelte:head>

<div class="page-wrap today-page">
  <PageHeader eyebrow={data.today.dateLabel} title={`${data.today.greeting}, ${context.user.name}`} description="Lo importante de hoy, sin ruido." />

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
            onclick={() => void toggleTask(task.id)}
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
</div>
