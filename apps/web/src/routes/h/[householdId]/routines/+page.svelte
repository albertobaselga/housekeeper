<script lang="ts">
  import { untrack } from 'svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import ActionStatus from '$lib/components/ActionStatus.svelte';
  import { useAppContext } from '$lib/auth/context';
  import { queueOutbox } from '$lib/offline/idb';
  import { createCommandEnvelope, createOutboxRecord } from '$lib/offline/schema';
  import { refreshSyncStatus } from '$lib/offline/sync';
  import { OptimisticActions } from '$lib/offline/optimistic';
  import { cadencePhrase, spanishDateLabel } from '@casa-clara/domain';
  import {
    CADENCE_CHOICES,
    INTERVAL_UNIT_VALUES,
    SEASONS,
    WEEKDAY_BUTTONS,
    cadenceFormIsComplete,
    cadenceSummary,
    emptyCadenceForm,
    formFromSchedule,
    groupByCadence,
    intervalUnitLabel,
    intervalUnitMax,
    scheduleFromForm,
    type CadenceChoice,
    type CadenceForm,
    type IntervalUnit
  } from '$lib/food/cadence';
  import { completeRoutine, upsertRoutine, type RoutineAudience } from '$lib/food/commands';
  import type { RoutineView } from '$lib/server/food.server';
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

  // Hoy lo manda el servidor ya en la zona del hogar: el navegador no tiene por
  // qué acertar con la zona ni cargar un Intl para averiguarla.
  const todayISO = $derived(data.live?.todayISO ?? '');

  // La lista se agrupa por clase de ritmo, con los MISMOS cinco títulos que las
  // opciones del formulario. Con veinte rutinas, una lista plana es sopa.
  const routineGroups = $derived(groupByCadence(data.live?.routines ?? []));

  // Patrón wiki replicado (P2-1): pintado optimista inmediato, invalidate
  // selectivo ('cc:routines') tras el ACK y reversión ante rejected/conflict.
  const optimistic = new OptimisticActions({ householdId: context.household.id, invalidateToken: 'cc:routines' });
  const actionStatus = optimistic.status;
  $effect(() => optimistic.start());

  // «Marcar hecha» optimista. La fecha prometida por el chip la calcula el
  // servidor (`nextAfterActionOn`) con el mismo motor que confirmará el ACK: el
  // navegador ya no rehace la aritmética de recurrencia por su cuenta.
  // El guard es POR RUTINA: otras filas siguen accionables (taps encadenables).
  let completingIds = $state<Record<string, true>>({});
  let completedFeedback = $state<Record<string, string>>({});

  function complete(routine: RoutineView): void {
    const dueOn = routine.actionableDueOn;
    if (!live || dueOn === null || completingIds[routine.id]) return;
    completingIds[routine.id] = true;
    const chip = routine.nextAfterActionOn
      ? `Hecha ✓ · próxima el ${spanishDateLabel(routine.nextAfterActionOn, { weekday: false })}`
      : 'Hecha ✓';
    void optimistic
      .run(completeRoutine({ householdId: live.householdId, routineId: routine.id, dueOn }), {
        apply: () => {
          completedFeedback[routine.id] = chip;
        },
        revert: () => {
          delete completedFeedback[routine.id];
          delete completingIds[routine.id];
        },
        settle: () => {
          // Los datos frescos ya traen la nueva ocurrencia: la fila vuelve a ser
          // accionable para la SIGUIENTE.
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
  // Valor INICIAL a propósito: a partir de aquí el formulario es del usuario y
  // una recarga de datos no puede pisarle lo que está escribiendo.
  let cadence = $state<CadenceForm>(untrack(() => emptyCadenceForm(data.live?.todayISO ?? '')));
  // La próxima ocurrencia de la rutina que se está editando, para que la frase
  // de vuelta la diga sin recalcularla en el navegador.
  let editingNextOn = $state<string | null>(null);
  let formBusy = $state(false);

  const cadenceReady = $derived(cadenceFormIsComplete(cadence));
  // En «Cada cierto tiempo» la fecha que se escribe ES, por construcción, la
  // próxima ocurrencia; en las demás ramas la frase o no la necesita o la sabe
  // ya el servidor.
  const phraseNextOn = $derived(cadence.choice === 'interval' ? cadence.anchorOn : editingNextOn);
  const cadenceSentence = $derived(
    cadenceReady
      ? cadencePhrase(scheduleFromForm(cadence), { nextOccurrence: phraseNextOn })
      : cadence.choice === 'weekdays'
        ? 'Marca al menos un día.'
        : 'Marca al menos una temporada.'
  );

  function setChoice(choice: CadenceChoice): void {
    // Estrenar clase de ritmo estrena la fecha visible: el ancla de la regla
    // anterior puede ser de hace años, y «¿Cuándo toca la próxima vez?» no
    // puede enseñar una fecha pasada.
    if (choice === 'interval' && cadence.choice !== 'interval' && cadence.anchorOn < todayISO) {
      cadence.anchorOn = todayISO;
      cadence.monthDay = null;
    }
    cadence.choice = choice;
  }

  function toggleWeekday(iso: number): void {
    cadence.weekdays = cadence.weekdays.includes(iso)
      ? cadence.weekdays.filter((day) => day !== iso)
      : [...cadence.weekdays, iso];
  }

  function toggleSeason(month: number): void {
    cadence.months = cadence.months.includes(month)
      ? cadence.months.filter((candidate) => candidate !== month)
      : [...cadence.months, month];
  }

  function setIntervalUnit(unit: IntervalUnit): void {
    cadence.intervalUnit = unit;
    // El tope es el de la base: cambiar de unidad no puede dejar una cifra que
    // la CHECK `routines_pattern_shape` rechazaría.
    cadence.intervalCount = Math.min(Math.max(cadence.intervalCount, 1), intervalUnitMax(unit));
    cadence.monthDay = null;
  }

  function editRoutineForm(id: string): void {
    const routine = live?.routines.find((candidate) => candidate.id === id);
    if (!routine) return;
    routineId = routine.id;
    routineTitle = routine.title;
    routineDetails = routine.details;
    routineAudience = routine.audience;
    editingNextOn = routine.nextOccurrenceOn;
    cadence = formFromSchedule(routine.schedule, {
      todayISO,
      nextOccurrenceOn: routine.nextOccurrenceOn
    });
  }

  function resetRoutineForm(): void {
    routineId = '';
    routineTitle = '';
    routineDetails = '';
    routineAudience = 'all';
    editingNextOn = null;
    cadence = emptyCadenceForm(todayISO);
  }

  function submitRoutine(event: SubmitEvent): void {
    event.preventDefault();
    if (!live || !routineTitle.trim() || !cadenceReady || formBusy) return;
    formBusy = true;
    void optimistic
      .run(
        upsertRoutine({
          householdId: live.householdId,
          routineId: routineId || undefined,
          title: routineTitle,
          details: routineDetails,
          audience: routineAudience,
          schedule: scheduleFromForm(cadence)
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
    <!-- El h1 dice el estado, no la sección: la sección ya la dice la pestaña
         activa de la barra inferior. La descripción («sin porcentajes ni
         histórico de cumplimiento») era copy de bienvenida en cada visita y se
         muda al estado vacío, que es donde una explicación hace falta. -->
    <PageHeader eyebrow="Orden cotidiano" title={`Rutinas · ${live.routines.length}`} />

    <ActionStatus status={actionStatus} />

    <section class="card" aria-labelledby="routines-title">
      <h2 id="routines-title" class="sr-only">Rutinas de la casa</h2>
      {#each routineGroups as group, index (group.choice)}
        <h3 class="rotulo">{group.title} · {group.items.length}</h3>
        <!-- Título, ritmo y detalle son TRES cosas, no una frase corrida de
             10,88 px: el nombre a 16 px como en cualquier otra fila del
             producto, el ritmo a 13 debajo y el detalle plegado. -->
        <ul class="fila-lista routine-list" data-lista={index === 0 ? 'principal' : undefined}>
          {#each group.items as routine (routine.id)}
            {@const overdue = routine.nextOccurrenceOn !== null && routine.nextOccurrenceOn < todayISO}
            <li class="fila-accion">
              <span class="fila-cuerpo">
                <strong>{routine.title}</strong>
                <small class:is-now={overdue}>
                  {AUDIENCE_LABEL[routine.audience]} · {cadenceSummary(routine.schedule, routine.nextOccurrenceOn, todayISO)}
                </small>
                {#if routine.details}
                  <details class="routine-detail"><summary>Cómo se hace</summary><p>{routine.details}</p></details>
                {/if}
              </span>
              <span class="fila-fin">
                {#if completedFeedback[routine.id]}
                  <span class="status-chip success" role="status">{completedFeedback[routine.id]}</span>
                {:else if routine.completedToday}
                  <span class="status-chip success">Hecha</span>
                {:else if canToggle && routine.actionableDueOn}
                  <!-- Una rutina sin cadencia confirmada no se puede completar:
                       el servidor la rechaza con `routine_has_no_schedule` y
                       aquí, sencillamente, no hay botón que la ofrezca. -->
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
                  <!-- «Editar» nombra a su sujeto para el lector de pantalla:
                       en una lista de veinte, «Editar» a secas no dice cuál. -->
                  <a
                    class="button secondary small-button"
                    href="#routine-form-title"
                    aria-label={`${routine.schedule === null ? 'Ponerle día a' : 'Editar'} ${routine.title}`}
                    onclick={() => editRoutineForm(routine.id)}
                  >
                    {routine.schedule === null ? 'Ponerle día' : 'Editar'}
                  </a>
                {/if}
              </span>
            </li>
          {/each}
        </ul>
      {:else}
        <div class="empty-state">
          <span aria-hidden="true">✓</span>
          <h3>Todavía no hay rutinas para ti</h3>
          <p>
            Aquí va lo que se repite en casa, cada una con su ritmo. No se puntúa a nadie:
            ni porcentajes ni histórico de cumplimiento, solo qué toca y cuándo.
          </p>
        </div>
      {/each}
    </section>

    {#if live.canWrite}
      <section class="card" aria-labelledby="routine-form-title">
        <div class="section-heading"><div><p class="eyebrow">Organizar</p><h2 id="routine-form-title">{routineId ? 'Editar rutina' : 'Nueva rutina'}</h2></div></div>
        <form class="action-form" onsubmit={submitRoutine}>
          <label>Título
            <input type="text" autocomplete="off" enterkeyhint="next" bind:value={routineTitle} maxlength="160" required />
          </label>
          <label>Detalles
            <textarea rows="2" autocomplete="off" bind:value={routineDetails} maxlength="1000"></textarea>
          </label>
          <label>¿Quién la hace?
            <select bind:value={routineAudience}>
              <option value="all">Toda la casa</option>
              <option value="family">Familia</option>
              <option value="employee">Empleada</option>
            </select>
          </label>
          <!-- §4.1: UNA sola pregunta con revelado progresivo. En cualquier
               momento hay exactamente un subcontrol visible, y debajo la frase
               de vuelta, que es el antídoto contra la jerga: nadie tiene que
               descifrar los controles, lee la frase. -->
          <fieldset class="cadence-fieldset">
            <legend>¿Cuándo toca?</legend>
            <div class="cadence-options">
              {#each CADENCE_CHOICES as option (option.value)}
                <label class="cadence-option">
                  <input
                    type="radio"
                    name="cadence-choice"
                    value={option.value}
                    checked={cadence.choice === option.value}
                    onchange={() => setChoice(option.value)}
                  />
                  <span>{option.label}</span>
                </label>
              {/each}
            </div>

            {#if cadence.choice === 'weekdays'}
              <fieldset class="cadence-sub">
                <legend>Marca los días que toca.</legend>
                <div class="day-buttons">
                  {#each WEEKDAY_BUTTONS as day (day.iso)}
                    <button
                      type="button"
                      aria-pressed={cadence.weekdays.includes(day.iso)}
                      aria-label={day.name}
                      onclick={() => toggleWeekday(day.iso)}
                    >
                      <span aria-hidden="true">{day.initial}</span>
                    </button>
                  {/each}
                </div>
              </fieldset>
            {:else if cadence.choice === 'interval'}
              <div class="repeat-phrase">
                <span aria-hidden="true">cada</span>
                <input
                  type="number"
                  inputmode="numeric"
                  enterkeyhint="next"
                  min="1"
                  max={intervalUnitMax(cadence.intervalUnit)}
                  bind:value={cadence.intervalCount}
                  aria-label="Se repite cada cuántas"
                  required
                />
                <select
                  value={cadence.intervalUnit}
                  onchange={(event) => setIntervalUnit(event.currentTarget.value as IntervalUnit)}
                  aria-label="Unidad de repetición"
                >
                  {#each INTERVAL_UNIT_VALUES as unit (unit)}
                    <option value={unit}>{intervalUnitLabel(unit, cadence.intervalCount)}</option>
                  {/each}
                </select>
              </div>
              <label>¿Cuándo toca la próxima vez?
                <input
                  type="date"
                  bind:value={cadence.anchorOn}
                  onchange={() => (cadence.monthDay = null)}
                  required
                />
              </label>
            {:else if cadence.choice === 'season'}
              <fieldset class="cadence-sub">
                <legend>Te avisará el primer día de cada temporada que marques.</legend>
                <div class="season-buttons">
                  {#each SEASONS as season (season.key)}
                    <button
                      type="button"
                      aria-pressed={cadence.months.includes(season.month)}
                      onclick={() => toggleSeason(season.month)}
                    >
                      {season.label}
                    </button>
                  {/each}
                </div>
              </fieldset>
            {:else if cadence.choice === 'unset'}
              <p class="cadence-help">Quedará apuntada en esta página. No aparecerá en Hoy hasta que le pongáis día.</p>
            {/if}

            <p class="cadence-phrase" aria-live="polite">{cadenceSentence}</p>
          </fieldset>
          <div class="menu-slot-actions">
            <button class="button primary" type="submit" disabled={formBusy || !cadenceReady}>{routineId ? 'Guardar rutina' : 'Crear rutina'}</button>
            {#if routineId}<button class="button secondary" type="button" onclick={resetRoutineForm}>Cancelar edición</button>{/if}
          </div>
        </form>
      </section>
    {/if}
  {:else if data.routines}
    <PageHeader eyebrow="Orden cotidiano" title={`Rutinas · ${done} de ${total} hechas`} />
    <!-- Aquí había una barra de progreso con su porcentaje. Se retiró: el AC-26
         revisado prohíbe cualquier indicador de cumplimiento «en ninguna
         vista», y la maqueta ES una vista —de hecho es la que ven las suites
         sin base de datos y quien entra a mirar la aplicación—. Queda la
         CUENTA, el mismo trato que recibe Hoy con datos reales (`countChip`):
         decir cuántas quedan ayuda a organizarse; decir qué porcentaje se
         cumple es puntuar a quien las hace. -->
    <div class="routine-columns" data-lista="principal">
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

<style>
  /* El detalle de la rutina va plegado: en la lista manda el nombre. */
  .routine-list .routine-detail > summary { min-height: var(--row-data); font-size: var(--text-meta); font-weight: 400; }

  .cadence-fieldset { display: grid; gap: var(--space-2); margin: 0; border: 0; padding: 0; min-width: 0; }
  .cadence-fieldset > legend { padding: 0; color: var(--ink-soft); font-size: var(--text-meta); font-weight: 700; }
  .cadence-options { display: grid; }
  .cadence-option { display: flex; align-items: center; gap: var(--space-2); min-height: var(--row-data); font-size: var(--text-strong); }
  .cadence-option > input { width: 1.25rem; height: 1.25rem; flex: none; accent-color: var(--primary); }

  .cadence-sub { display: grid; gap: var(--space-2); margin: 0; border: 0; padding: 0; min-width: 0; }
  .cadence-sub > legend { padding: 0; color: var(--ink-soft); font-size: var(--text-meta); }

  /* `flex-wrap` y `min-width: 0`: a 320 px los siete días pasan a dos filas en
     vez de desbordar la tarjeta (mobile-overflow mide esta página). */
  .day-buttons, .season-buttons { display: flex; flex-wrap: wrap; gap: var(--space-2); min-width: 0; }
  .day-buttons > button, .season-buttons > button {
    min-width: 2.75rem;
    min-height: 2.75rem;
    border: 1px solid var(--line-strong);
    border-radius: var(--r-md);
    background: var(--surface);
    color: var(--ink);
    font-size: var(--text-strong);
    font-weight: 700;
    /* Mata el retardo de doble toque en móvil. */
    touch-action: manipulation;
    cursor: pointer;
  }
  .season-buttons > button { flex: 1 1 6rem; font-weight: 500; }
  .day-buttons > button[aria-pressed='true'], .season-buttons > button[aria-pressed='true'] {
    border-color: var(--primary);
    background: var(--primary-soft);
    color: var(--primary);
  }

  .cadence-help { color: var(--ink-soft); font-size: var(--text-body); line-height: var(--lh-loose); }

  /* La frase de vuelta se lee antes que los controles: es lo que confirma en
     lengua de casa lo que se acaba de marcar. */
  .cadence-phrase { font-size: var(--text-strong); font-weight: 500; line-height: var(--lh-base); }
</style>
