<script lang="ts">
  import { untrack } from 'svelte';
  // El triaje arrastra los descriptores de todos los dominios: se carga como
  // chunk aparte (mismo mecanismo que WikiEditor) para respetar el presupuesto
  // de JavaScript inicial de Hoy.
  const OutboxTriage = import('$lib/components/OutboxTriage.svelte').then((module) => module.default);
  // La agenda real del día también va en chunk aparte (solo pesa cuando hay eventos).
  const TodayAgenda = import('$lib/components/TodayAgenda.svelte').then((module) => module.default);
  // «Esta semana» (E5.3): lo que viene en los próximos días. No es accionable y
  // solo pesa cuando hay algo que enseñar, así que también va aparte.
  const TodayWeek = import('$lib/components/TodayWeek.svelte').then((module) => module.default);
  // Lo ya hecho hoy, con el gesto de deshacer (E5.1): plegado, al fondo y en su
  // propio chunk. Deshacer necesita JavaScript de todos modos.
  const TodayDone = import('$lib/components/TodayDone.svelte').then((module) => module.default);
  // Los atajos que resuelven aquí mismo (confirmar la comida, aceptar la
  // jornada) arrastran los comandos de comida y empleo: otro chunk aparte.
  const InlineAction = import('$lib/components/TodayInlineAction.svelte').then((module) => module.default);
  import PageHeader from '$lib/components/PageHeader.svelte';
  import ActionStatus from '$lib/components/ActionStatus.svelte';
  import type { Capability } from '$lib/auth/capabilities';
  import { useAppContext } from '$lib/auth/context';
  import { OptimisticActions } from '$lib/offline/optimistic';
  import { completeRoutine, uncompleteRoutine } from '$lib/food/routine-complete';
  import type { TodayRoutineRow } from '$lib/server/today.server';
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

  // ── Modo real (Postgres bajo RLS): «Marcar hecha» OPTIMISTA con el patrón
  // wiki. El chip «Hecha ✓ · próxima el X» se pinta al instante y la fila NO
  // desaparece en seco: queda atenuada y tachada con su chip (P3). El chip lo
  // escribe el SERVIDOR (`row.doneChip`): predecirlo aquí costaba importar la
  // aritmética de recurrencia y un `Intl.DateTimeFormat` al arranque de Hoy.
  // Guard POR FILA: las demás siguen accionables sin esperar. ────────────────
  const optimistic = new OptimisticActions({ householdId: context.household.id, invalidateToken: 'cc:today' });
  const actionStatus = optimistic.status;
  $effect(() => optimistic.start());

  // Asuntos ya resueltos DESDE Hoy (Ola D-5): la clave pasa a chip al instante
  // y vuelve atrás sola si el servidor rechaza el cambio.
  let resolvedInline = $state<Record<string, string>>({});

  // Filas marcadas en esta visita (clave de fila → chip) y filas cuyo marcado
  // se está deshaciendo. Las dos se vacían solas cuando llega el load fresco.
  let markedHere = $state<Record<string, string>>({});
  let undoneHere = $state<Record<string, true>>({});
  let busyRows = $state<Record<string, true>>({});

  function markRoutineDone(row: TodayRoutineRow): void {
    if (!overview || busyRows[row.key] || markedHere[row.key]) return;
    busyRows[row.key] = true;
    void optimistic
      .run(completeRoutine({ householdId: overview.householdId, routineId: row.routineId, dueOn: row.dueOn }), {
        apply: () => {
          markedHere[row.key] = row.doneChip;
          delete undoneHere[row.key];
        },
        revert: () => {
          delete markedHere[row.key];
          delete busyRows[row.key];
        },
        settle: () => {
          delete busyRows[row.key];
        }
      })
      .catch(() => {
        delete busyRows[row.key];
      });
  }

  /**
   * Deshacer un marcado hecho por error (E5.1), desde el mismo sitio donde se
   * marcó. No pide motivo: es un error de dedo, no una corrección contable. El
   * servidor anota el completado como anulado y devuelve la rutina al día que
   * le tocaba, así que basta con recargar.
   */
  function undoRoutineDone(row: { key: string; routineId: string; dueOn: string }): void {
    if (!overview || busyRows[row.key]) return;
    busyRows[row.key] = true;
    void optimistic
      .run(uncompleteRoutine({ householdId: overview.householdId, routineId: row.routineId, dueOn: row.dueOn }), {
        apply: () => {
          undoneHere[row.key] = true;
          delete markedHere[row.key];
        },
        revert: () => {
          delete undoneHere[row.key];
          delete busyRows[row.key];
        },
        settle: () => {
          delete busyRows[row.key];
        }
      })
      .catch(() => {
        delete busyRows[row.key];
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

<div class="page-wrap today-page">
  <!-- Acceso fijo a Emergencias desde Hoy (P3 de la re-auditoría UX v2: en
       móvil «Ayuda» pasó a vivir dentro de «Más» y perdió su tap directo).
       Sigue estando, sigue yendo a la misma ruta y sigue funcionando sin red;
       lo que cambia es DÓNDE: una acción que se usa menos de una vez al mes no
       abre la pantalla con una banda completa de 42 px por delante de todo lo
       que sí se hace a diario. Va al final, como fila. -->
  {#snippet emergencyShortcut()}
    <a class="button secondary small-button today-emergency-link" href={`/h/${context.household.id}/emergency`}>
      Emergencias
    </a>
  {/snippet}
  {#snippet accessNote()}
    {#if reducedAccess}
      <p class="audit-note">Tu acceso incluye {accessSummary}. El resto de la casa lo lleva la familia.</p>
    {/if}
  {/snippet}
  {#if overview}
    <!-- El `h1` sigue siendo único y descriptivo: cambia su texto, no su papel.
         Antes decía «Buenas noches, Ana» a 32 px en dos líneas —74 px de saludo
         a quien abre esta pantalla todos los días— con un eyebrow y una
         descripción encima y debajo. Ahora dice en una línea de 24 px qué día
         es y cuánto queda. El nombre del hogar sobrevive aquí, y solo aquí,
         como línea de apoyo de 13 px: es lo que quería decir 0fdf873 con la
         cabecera fija, a un octavo del coste. -->
    <PageHeader eyebrow={overview.dateLabel} title={overview.stateLabel} support={context.household.name} />
    {@render accessNote()}

    {#await OutboxTriage then Triage}<Triage householdId={overview.householdId} />{/await}

    <ActionStatus status={actionStatus} />

    {#if overview.decisions.length > 0}
      <section class="card" aria-labelledby="decisions-title">
        <div class="section-heading">
          <!-- El título lo escribe el servidor (`decisionsTitleFor`): el bloque
               lleva decisiones y también novedades, y llamar «decisión» a
               enterarse de algo pediría una aprobación que aquí no se pide. -->
          <div><p class="eyebrow">Pendientes de ti</p><h2 id="decisions-title">{overview.decisionsTitle}</h2></div>
          <span class="status-chip warning">{overview.decisionsCount}</span>
        </div>
        <!-- Cuando hay algo esperando una decisión, ESA es la lista principal
             de Hoy: es lo que la pantalla ha venido a resolver. Si no la hay,
             lo son las rutinas del día. -->
        <div class="ledger-list" data-lista="principal">
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

    <!-- Las rutinas van primero y el menú detrás: lo primero de la pantalla es
         lo que se hace, no lo que se lee. -->
    <section class="content-grid" aria-label="Rutinas y menú de hoy">
      <!-- `data-lista="principal"` no es un truco de test: es la pantalla
           diciendo cuál es su lista principal. Si una pantalla no sabe decirlo,
           ese es el hallazgo. Aquí es el primer bloque de rutinas: lo que se ha
           venido a hacer. -->
      {#snippet routineRows(rows: TodayRoutineRow[], principal = false)}
        <div class="ledger-list" data-lista={principal ? 'principal' : undefined}>
          {#each rows as row (row.key)}
            <div class:routine-done={markedHere[row.key]}>
              <span>
                <!-- El detalle se abre al tocar el TÍTULO, y solo si lo tiene
                     (E5.2): `<details>` nativo, cero bytes de JavaScript para
                     enseñar un texto que ya viajó con la página. Sin detalle es
                     un <strong> y no finge que se pulsa. -->
                {#if row.details}
                  <details class="routine-detail"><summary>{row.title}</summary><p>{row.details}</p></details>
                {:else}
                  <strong>{row.title}</strong>
                {/if}
                <!-- Vacío en las de hoy (es hoy, siempre); `small:empty` lo
                     esconde sin gastar un bloque condicional en el móvil. -->
                <small>{row.note}</small>
              </span>
              {#if markedHere[row.key]}
                <span class="inline-actions">
                  <span class="status-chip success" role="status">{markedHere[row.key]}</span>
                  <button
                    class="button secondary small-button"
                    type="button"
                    disabled={busyRows[row.key]}
                    onclick={() => undoRoutineDone(row)}
                  >Deshacer</button>
                </span>
              {:else if canToggle}
                <button
                  class="button secondary small-button"
                  type="button"
                  disabled={busyRows[row.key]}
                  onclick={() => markRoutineDone(row)}
                >Marcar hecha</button>
              {/if}
            </div>
          {/each}
        </div>
      {/snippet}

      <article class="card" id="rutinas-de-hoy" aria-labelledby="today-routines-title">
        <div class="section-heading">
          <div><p class="eyebrow">Rutinas</p><h2 id="today-routines-title">Lo que toca hoy</h2></div>
          <a href={`/h/${overview.householdId}/routines`}>Todas →</a>
        </div>
        <!-- El chip es CUENTA, no nota: nunca porcentaje ni racha (AC-26).
             Las cadenas vacías las esconde `:empty` en CSS: un bloque
             condicional menos por cada texto que a veces no toca. -->
        <p class="status-chip" role="status">{overview.routines.countChip}</p>

        <!-- Los bloques («Se quedó pendiente», «Hoy» y el corte de seis) los
             arma el servidor: cada `{#each}` de más aquí son bytes en el móvil. -->
        {#each overview.routines.blocks as block, index (block.key)}
          {#if block.folded}
            <details><summary>{block.heading}</summary>{@render routineRows(block.rows)}</details>
          {:else}
            {#if block.heading}<h3 class="routine-block">{block.heading}</h3>{/if}
            {@render routineRows(block.rows, index === 0 && overview.decisions.length === 0)}
          {/if}
        {/each}

        <p class="audit-note">{overview.routines.emptyNote}</p>

        <!-- Lo ya hecho y «Esta semana» (E5.1 y E5.3) van en chunks aparte,
             como la agenda: medido, no cabían en el presupuesto de arranque, y
             la propia enmienda deja esa salida («cabe en el presupuesto o va en
             carga diferida; se mide, no se supone»). Cada componente decide si
             tiene algo que enseñar; ese condicional no pesa aquí. -->
        {#await TodayDone then Done}
          <Done
            view={overview.routines}
            marked={markedHere}
            undone={undoneHere}
            busy={busyRows}
            onUndo={undoRoutineDone}
          />
        {/await}
        {#await TodayWeek then Week}<Week view={overview.routines} />{/await}

        {#if !canToggle && overview.routines.anyToday}
          <p class="card-footnote">Tu acceso permite consultar el día, pero no marcar rutinas.</p>
        {/if}
      </article>

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

    <div class="today-emergency-row">{@render emergencyShortcut()}</div>
  {:else if data.today}
    <PageHeader
      eyebrow={data.today.dateLabel}
      title={`${completeCount} de ${tasks.length} hechas hoy`}
      support={context.household.name}
    />
    {@render accessNote()}

    {#await OutboxTriage then Triage}<Triage householdId={context.household.id} />{/await}

    <section class="hero-grid" aria-label="Resumen del día">
      <article class="card task-card">
        <div class="section-heading">
          <!-- El anillo que iba aquí se rellenaba en proporción a lo hecho:
               un porcentaje dibujado. Fuera por el AC-26 revisado, que no
               admite indicadores de cumplimiento en NINGUNA vista, tampoco en
               la maqueta. La cuenta se dice con palabras, en el titular. -->
          <div><p class="eyebrow">Rutina de hoy</p><h2>Lo que toca hoy</h2></div>
        </div>
        <div class="task-list" data-lista="principal">
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

    <div class="today-emergency-row">{@render emergencyShortcut()}</div>
  {/if}
</div>

<style>
  /* Emergencias cierra la pantalla en vez de abrirla: a la derecha, como una
     acción de fila, sin la banda completa que le robaba 42 px a lo de hoy. */
  .today-emergency-row { display: flex; justify-content: flex-end; }
</style>
