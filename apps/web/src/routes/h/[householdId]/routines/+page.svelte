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
    <PageHeader eyebrow="Orden cotidiano" title="Rutinas" description="Cada rutina con su ritmo; sin porcentajes ni histórico de cumplimiento." />

    <ActionStatus status={actionStatus} />

    <section class="card" aria-labelledby="routines-title">
      <div class="section-heading"><div><p class="eyebrow">Visibles para tu rol</p><h2 id="routines-title">Rutinas de la casa</h2></div></div>
      {#each routineGroups as group (group.choice)}
        <h3 class="cadence-group">{group.title} · {group.items.length}</h3>
        <ul class="wiki-recent">
          {#each group.items as routine (routine.id)}
            <li>
              <div class="wiki-node-row">
                <span>
                  <strong>{routine.title}</strong>
                  <small>{AUDIENCE_LABEL[routine.audience]} · {cadenceSummary(routine.schedule, routine.nextOccurrenceOn)}</small>
                  {#if routine.details}<small>{routine.details}</small>{/if}
                </span>
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
                  <!-- «Editar» es enlace de texto al final de la fila: a 390 px
                       dos botones y un chip no caben en `.wiki-node-row`. -->
                  <a class="row-edit" href="#routine-form-title" onclick={() => editRoutineForm(routine.id)}>
                    {routine.schedule === null ? 'Ponerle día' : 'Editar'}
                  </a>
                {/if}
              </div>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="audit-note">No hay rutinas visibles para tu rol en este hogar.</p>
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

<style>
  /* Encabezado de grupo de la lista: los mismos cinco títulos del formulario,
     con la cuenta al lado. Es un rótulo de orden, no una sección con peso. */
  .cadence-group {
    margin-top: .9rem;
    color: var(--ink-soft);
    font-size: .74rem;
    font-weight: 750;
    letter-spacing: .04em;
    text-transform: uppercase;
  }
  .cadence-group:first-of-type { margin-top: 0; }

  /* «Editar» / «Ponerle día»: enlace de texto al final de la fila, para que a
     390 px el botón de acción se quede solo. */
  .row-edit { margin-left: auto; font-size: .8rem; font-weight: 650; white-space: nowrap; }

  .cadence-fieldset { display: grid; gap: .55rem; margin: 0; border: 0; padding: 0; min-width: 0; }
  .cadence-fieldset > legend { padding: 0; color: var(--ink-soft); font-size: .72rem; font-weight: 700; }
  .cadence-options { display: grid; gap: .35rem; }
  .cadence-option { display: flex; align-items: center; gap: .5rem; min-height: 2rem; }
  .cadence-option > input { width: auto; flex: none; }

  .cadence-sub { display: grid; gap: .4rem; margin: 0; border: 0; padding: 0; min-width: 0; }
  .cadence-sub > legend { padding: 0; color: var(--ink-soft); font-size: .74rem; }

  /* `flex-wrap` y `min-width: 0`: a 320 px los siete días pasan a dos filas en
     vez de desbordar la tarjeta (mobile-overflow mide esta página). */
  .day-buttons, .season-buttons { display: flex; flex-wrap: wrap; gap: .35rem; min-width: 0; }
  .day-buttons > button, .season-buttons > button {
    min-width: 2.75rem;
    min-height: 2.75rem;
    border: 1px solid var(--line-strong);
    border-radius: .6rem;
    background: var(--surface);
    color: var(--ink);
    font-weight: 700;
    /* Mata el retardo de doble toque en móvil. */
    touch-action: manipulation;
    cursor: pointer;
  }
  .season-buttons > button { flex: 1 1 6rem; font-weight: 600; }
  .day-buttons > button[aria-pressed='true'], .season-buttons > button[aria-pressed='true'] {
    border-color: var(--primary);
    background: var(--primary-soft);
    color: var(--primary);
  }

  .cadence-help { color: var(--ink-soft); font-size: .8rem; line-height: 1.45; }

  /* La frase de vuelta se lee antes que los controles: es lo que confirma en
     lengua de casa lo que se acaba de marcar. */
  .cadence-phrase { font-size: 1.02rem; font-weight: 600; line-height: 1.5; }
</style>
