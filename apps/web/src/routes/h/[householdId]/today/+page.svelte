<script lang="ts">
  import { untrack } from 'svelte';
  // El triaje arrastra los descriptores de todos los dominios: se carga como
  // chunk aparte (mismo mecanismo que WikiEditor) para respetar el presupuesto
  // de JavaScript inicial de Hoy.
  const OutboxTriage = import('$lib/components/OutboxTriage.svelte').then((module) => module.default);
  // La agenda real del día también va en chunk aparte (solo pesa cuando hay eventos).
  const TodayAgenda = import('$lib/components/TodayAgenda.svelte').then((module) => module.default);
  // Los atajos que resuelven aquí mismo (confirmar la comida, aceptar la
  // jornada) arrastran los comandos de comida y empleo: otro chunk aparte.
  const InlineAction = import('$lib/components/TodayInlineAction.svelte').then((module) => module.default);
  import PageHeader from '$lib/components/PageHeader.svelte';
  import ActionStatus from '$lib/components/ActionStatus.svelte';
  import type { Capability } from '$lib/auth/capabilities';
  import { useAppContext } from '$lib/auth/context';
  import { OptimisticActions } from '$lib/offline/optimistic';
  import { nextRoutineDue } from '$lib/food/dates';
  import { completeRoutine } from '$lib/food/routine-complete';
  import type { TodayRoutineView } from '$lib/server/today.server';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const context = useAppContext();
  const canToggle = context.capabilities.includes('routine.toggle');
  const canConfirmMenu = context.capabilities.includes('menu.write');

  // P2-15 (revisión UX v3): a quien tiene un acceso reducido (apoyo, acceso
  // puntual) ninguna pantalla le contaba qué incluye. Una línea en Hoy lo dice.
  const reducedAccess = !context.capabilities.includes('settlement.read');
  const ACCESS_PARTS: ReadonlyArray<[Capability, string]> = [
    ['menu.read', 'el menú'],
    ['routine.read', 'las rutinas'],
    ['calendar.read', 'el calendario'],
    ['contact.read', 'los contactos'],
    ['content.read', 'la guía de la casa']
  ];
  const accessSummary = ACCESS_PARTS.filter(([capability]) => context.capabilities.includes(capability))
    .map(([, label]) => label)
    .concat('las emergencias')
    .join(', ')
    .replace(/, ([^,]*)$/, ' y $1');

  const overview = $derived(data.overview);

  const DUE_LABEL = new Intl.DateTimeFormat('es-ES', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

  // ── Modo real (Postgres bajo RLS): «Marcar hecha» OPTIMISTA con el patrón
  // wiki. El chip «Hecha ✓ · próxima el X» se pinta al instante y la fila NO
  // desaparece en seco: queda atenuada y tachada con su chip (P3), aunque los
  // datos frescos ya no la lista como pendiente. Guard POR RUTINA: las demás
  // filas siguen accionables sin esperar. ─────────────────────────────────────
  const optimistic = new OptimisticActions({ householdId: context.household.id, invalidateToken: 'cc:today' });
  const actionStatus = optimistic.status;
  $effect(() => optimistic.start());

  // Asuntos ya resueltos DESDE Hoy (Ola D-5): la clave pasa a chip al instante
  // y vuelve atrás sola si el servidor rechaza el cambio.
  let resolvedInline = $state<Record<string, string>>({});

  type DoneRoutine = { id: string; title: string; details: string; chip: string };
  let doneRoutines = $state<Record<string, DoneRoutine>>({});
  let completingIds = $state<Record<string, true>>({});

  // Fila viva mientras el load la traiga; al desaparecer del overview, la
  // versión «hecha» local la mantiene visible (atenuada) el resto de la visita.
  const shownRoutines = $derived.by(() => {
    const fresh = overview?.routines ?? [];
    const freshIds = new Set(fresh.map((routine) => routine.id));
    const ghosts = Object.values(doneRoutines).filter((routine) => !freshIds.has(routine.id));
    return { fresh, ghosts };
  });

  function markRoutineDone(routine: TodayRoutineView): void {
    if (!overview || completingIds[routine.id] || doneRoutines[routine.id]) return;
    completingIds[routine.id] = true;
    const predictedDue = nextRoutineDue(routine.nextDueOn, routine.frequency, routine.intervalCount);
    const entry: DoneRoutine = {
      id: routine.id,
      title: routine.title,
      details: routine.details,
      chip: `Hecha ✓ · próxima el ${DUE_LABEL.format(new Date(`${predictedDue}T00:00:00Z`))}`
    };
    void optimistic
      .run(completeRoutine({ householdId: overview.householdId, routineId: routine.id, dueOn: routine.nextDueOn }), {
        apply: () => {
          doneRoutines[routine.id] = entry;
        },
        revert: () => {
          delete doneRoutines[routine.id];
          delete completingIds[routine.id];
        },
        settle: () => {
          delete completingIds[routine.id];
        }
      })
      .catch(() => {
        delete completingIds[routine.id];
      });
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
  <!-- Acceso fijo a Emergencias desde Hoy (P3 de la re-auditoría UX v2: en
       móvil «Ayuda» pasó a vivir dentro de «Más» y perdió su tap directo). -->
  {#snippet emergencyShortcut()}
    <a class="button secondary today-emergency-link" href={`/h/${context.household.id}/emergency`}>
      <span aria-hidden="true">+</span> Emergencias
    </a>
  {/snippet}
  {#snippet accessNote()}
    {#if reducedAccess}
      <p class="audit-note">Tu acceso incluye {accessSummary}. El resto de la casa lo lleva la familia.</p>
    {/if}
  {/snippet}
  {#if overview}
    <PageHeader
      eyebrow={overview.dateLabel}
      title={`${overview.greeting}, ${context.user.name}`}
      description="Lo importante de hoy, sin ruido."
      actions={emergencyShortcut}
    />
    {@render accessNote()}

    {#await OutboxTriage then Triage}<Triage householdId={overview.householdId} />{/await}

    <ActionStatus status={actionStatus} />

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
              <span class="inline-actions">
                {#if resolvedInline[item.key]}
                  <span class="status-chip success">{resolvedInline[item.key]}</span>
                {:else if item.inline}
                  {@const inline = item.inline}
                  {#await InlineAction then Action}
                    <Action
                      householdId={overview.householdId}
                      action={inline}
                      label="Aceptar"
                      {optimistic}
                      onApply={() => (resolvedInline[item.key] = 'Aceptada ✓')}
                      onRevert={() => delete resolvedInline[item.key]}
                    />
                  {/await}
                {/if}
                <a class="button secondary small-button" href={item.href}>{item.cta}</a>
              </span>
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
                  <span class="inline-actions">
                    <!-- P2-8: a quien no puede confirmar (p. ej. la empleada) el
                         chip no le finge una tarea suya pendiente. -->
                    {#if slot.confirmed || resolvedInline[`menu-${slot.id}`]}
                      <span class="status-chip success">Confirmado</span>
                    {:else}
                      <span class="status-chip warning">
                        {canConfirmMenu ? 'Sin confirmar' : 'Pendiente de la familia'}
                      </span>
                      {#if canConfirmMenu && slot.contentHash}
                        <!-- Ola D-5: se confirma aquí mismo; «Ver la semana»
                             sigue arriba para lo demás. -->
                        {#await InlineAction then Action}
                          <Action
                            householdId={overview.householdId}
                            action={{ kind: 'confirm_menu', slotId: slot.id, contentHash: slot.contentHash }}
                            label="Confirmar"
                            {optimistic}
                            onApply={() => (resolvedInline[`menu-${slot.id}`] = 'Confirmado')}
                            onRevert={() => delete resolvedInline[`menu-${slot.id}`]}
                          />
                        {/await}
                      {/if}
                    {/if}
                  </span>
                {/if}
              </div>
            {/each}
          </div>
        {:else}
          <p class="audit-note">Hoy no hay nada planificado en el menú.</p>
        {/if}
      </article>

      <article class="card" id="rutinas-de-hoy" aria-labelledby="today-routines-title">
        <div class="section-heading">
          <div><p class="eyebrow">Rutinas</p><h2 id="today-routines-title">Vencen hoy</h2></div>
          <a href={`/h/${overview.householdId}/routines`}>Todas →</a>
        </div>
        {#if shownRoutines.fresh.length > 0 || shownRoutines.ghosts.length > 0}
          <div class="ledger-list">
            {#each shownRoutines.fresh as routine (routine.id)}
              <div class:routine-done={doneRoutines[routine.id]}>
                <span>
                  <strong>{routine.title}</strong>
                  <small>{routine.dueLabel}{routine.details ? ` · ${routine.details}` : ''}</small>
                </span>
                {#if doneRoutines[routine.id]}
                  <span class="status-chip success" role="status">{doneRoutines[routine.id].chip}</span>
                {:else if routine.completedCurrent}
                  <span class="status-chip success">Hecha</span>
                {:else if canToggle}
                  <button
                    class="button secondary small-button"
                    type="button"
                    disabled={completingIds[routine.id]}
                    onclick={() => markRoutineDone(routine)}
                  >Marcar hecha</button>
                {/if}
              </div>
            {/each}
            {#each shownRoutines.ghosts as routine (routine.id)}
              <div class="routine-done">
                <span>
                  <strong>{routine.title}</strong>
                  <small>Hoy{routine.details ? ` · ${routine.details}` : ''}</small>
                </span>
                <span class="status-chip success" role="status">{routine.chip}</span>
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

      {#if overview.agenda.length > 0}
        <!-- Agenda real del día (calendarios enlazados, Ola E): chunk lazy
             como el triaje para no romper el presupuesto de Hoy. Sin eventos
             hoy, el bloque no ocupa sitio. -->
        {#await TodayAgenda then Agenda}
          <Agenda
            householdId={overview.householdId}
            agenda={overview.agenda}
            showLink={context.capabilities.includes('calendar.read')}
          />
        {/await}
      {/if}
    </section>
  {:else if data.today}
    <PageHeader eyebrow={data.today.dateLabel} title={`${data.today.greeting}, ${context.user.name}`} description="Lo importante de hoy, sin ruido." actions={emergencyShortcut} />
    {@render accessNote()}

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
