<script lang="ts">
  import PageHeader from '$lib/components/PageHeader.svelte';
  import ActionStatus from '$lib/components/ActionStatus.svelte';
  import { useAppContext } from '$lib/auth/context';
  import { upsertCalendarSource } from '$lib/calendar/commands';
  import {
    buildCalendarDays,
    buildCalendarYear,
    calendarNotices,
    monthGridRange,
    nextOccurrenceAfter,
    type CalendarDay,
    type CalendarRoutineItem,
    type CalendarScope,
    type CalendarWindow
  } from '$lib/calendar/view';
  import { addDays, mondayOf } from '$lib/food/dates';
  import { completeRoutine } from '$lib/food/routine-complete';
  import { OptimisticActions } from '$lib/offline/optimistic';
  import type { CalendarSourceView } from '$lib/server/calendar.server';
  import type { PageData } from './$types';

  /**
   * Calendario unificado: rutinas y eventos, en semana, mes y año (E1), con el
   * pasado consultable por hechos y autoría (E2).
   *
   * El alcance y el día son ESTADO DEL NAVEGADOR, no de la URL, y las
   * ocurrencias se expanden aquí a partir de las reglas que trajo el servidor.
   * Por eso cambiar de semana, de mes o de año es instantáneo y funciona sin
   * red. Cuando la vista se sale de la ventana descargada —la rejilla de seis
   * semanas del mes servido— se pide al servidor la nueva ventana si hay
   * conexión, y si no la hay se pinta lo que SÍ se puede calcular (las rutinas)
   * diciendo con todas las letras qué falta: los eventos del calendario
   * enlazado y quién marcó cada cosa.
   *
   * Rutina y evento se distinguen por TRES señales simultáneas y ninguna es el
   * color: bloques separados y etiquetados dentro del día, la forma (la rutina
   * lleva casilla, el evento lleva hora) y la segunda línea. En las rejillas de
   * mes y año las marcas de densidad tienen forma distinta —cuadrado la rutina,
   * círculo el evento— y son decoración: la cuenta va en el nombre accesible.
   *
   * Aquí no se calcula ningún porcentaje, racha, media ni comparativa, y no se
   * colorea nada por rendimiento (E2 / AC-26 revisado): lo vigila
   * `tests/calendar-no-metrics.test.ts`.
   */

  let { data }: { data: PageData } = $props();
  const context = useAppContext();

  const live = $derived(data.live);
  const canToggle = context.capabilities.includes('routine.toggle');

  // ── Etiquetas (Intl nativo: no pesa en el paquete) ─────────────────────────
  const WEEKDAY_INITIALS = ['L', 'M', 'X', 'J', 'V', 'S', 'D'] as const;
  const WEEKDAY_NAMES = [
    'lunes',
    'martes',
    'miércoles',
    'jueves',
    'viernes',
    'sábado',
    'domingo'
  ] as const;
  const MONTH_NAMES = [
    'enero',
    'febrero',
    'marzo',
    'abril',
    'mayo',
    'junio',
    'julio',
    'agosto',
    'septiembre',
    'octubre',
    'noviembre',
    'diciembre'
  ] as const;

  const dayNumber = (dateISO: string): number => Number(dateISO.slice(8, 10));
  const monthNumber = (dateISO: string): number => Number(dateISO.slice(5, 7));
  const yearNumber = (dateISO: string): number => Number(dateISO.slice(0, 4));
  /** ISO 1..7 sin `Date` en hora local: la cadena ya es un día de calendario. */
  function weekdayIndex(dateISO: string): number {
    return (new Date(`${dateISO}T00:00:00Z`).getUTCDay() + 6) % 7;
  }
  const weekdayName = (dateISO: string): string => WEEKDAY_NAMES[weekdayIndex(dateISO)];
  const monthName = (dateISO: string): string => MONTH_NAMES[monthNumber(dateISO) - 1];
  const pad2 = (value: number): string => String(value).padStart(2, '0');

  /** «miércoles 13», la forma corta que usan la tira y la rejilla. */
  const shortDay = (dateISO: string): string => `${weekdayName(dateISO)} ${dayNumber(dateISO)}`;

  /** «Hoy, miércoles 13» · «mañana, jueves 14» · «viernes 15 de agosto». */
  function dayHeading(dateISO: string, todayISO: string): string {
    if (dateISO === todayISO) return `Hoy, ${shortDay(dateISO)}`;
    if (dateISO === addDays(todayISO, 1)) return `mañana, ${shortDay(dateISO)}`;
    return `${shortDay(dateISO)} de ${monthName(dateISO)}`;
  }

  const plural = (count: number, one: string, many: string): string =>
    `${count} ${count === 1 ? one : many}`;

  /** Nombre accesible de un día con sus cuentas exactas, nunca solo un punto. */
  function dayCountLabel(day: CalendarDay): string {
    const parts: string[] = [];
    if (day.routines.length > 0) parts.push(plural(day.routines.length, 'rutina', 'rutinas'));
    if (day.events.length > 0) parts.push(plural(day.events.length, 'evento', 'eventos'));
    const tail = parts.length === 0 ? 'sin nada previsto' : parts.join(' y ');
    return `${shortDay(day.dateISO)} de ${monthName(day.dateISO)}, ${tail}`;
  }

  // ── Alcance y día: estado del navegador, sembrado por la URL ───────────────
  let override = $state<{ scope: CalendarScope; anchorISO: string } | null>(null);
  const scope = $derived(override?.scope ?? live?.scope ?? 'semana');
  const anchorISO = $derived(override?.anchorISO ?? live?.anchorISO ?? live?.todayISO ?? '');
  const todayISO = $derived(live?.todayISO ?? '');

  let online = $state(true);
  $effect(() => {
    const sync = (): void => {
      online = navigator.onLine;
    };
    sync();
    window.addEventListener('online', sync);
    window.addEventListener('offline', sync);
    return () => {
      window.removeEventListener('online', sync);
      window.removeEventListener('offline', sync);
    };
  });

  /**
   * La ventana descargada (eventos y autoría). Nace de la carga del servidor y
   * a partir de ahí la trae el endpoint `…/calendar/ventana`, NUNCA una
   * navegación: si la red está caída, `goto` acaba en una navegación completa,
   * el service worker no tiene esa URL guardada y quien miraba el calendario
   * aparece en la página de «sin conexión» habiendo perdido hasta las rutinas
   * que su navegador ya tenía calculadas.
   */
  let fetched = $state<CalendarWindow | null>(null);
  const windowData = $derived<CalendarWindow>(
    fetched ?? {
      windowFromISO: live?.windowFromISO ?? '',
      windowToISO: live?.windowToISO ?? '',
      events: live?.events ?? [],
      completions: live?.completions ?? [],
      eventDaysYear: live?.eventDaysYear ?? 0,
      eventDaysISO: live?.eventDaysISO ?? []
    }
  );

  /**
   * Pide la ventana de un día. Si falla —sin red, o el servidor no puede leer—
   * NO pasa nada visible: las rutinas ya están pintadas y la banda de «fuera de
   * lo descargado» dice lo que no se sabe.
   */
  let windowRequest = 0;
  async function loadWindow(anchor: string): Promise<void> {
    if (!live) return;
    // Tres toques seguidos en «Mes siguiente» lanzan tres peticiones y no tienen
    // por qué volver en orden: solo manda la última pedida.
    windowRequest += 1;
    const mine = windowRequest;
    try {
      const response = await fetch(
        `/h/${live.householdId}/calendar/ventana?d=${encodeURIComponent(anchor)}`,
        { headers: { accept: 'application/json' } }
      );
      if (!response.ok) return;
      const payload = (await response.json()) as CalendarWindow;
      if (mine === windowRequest) fetched = payload;
    } catch {
      // Sin red: lo calculado en el navegador sigue en pie, y con su aviso.
    }
  }

  /**
   * Cambia lo que se ve. Pinta primero —el cálculo es local e inmediato— y solo
   * después, si la vista se sale de lo descargado, pide la ventana nueva.
   */
  function show(nextScope: CalendarScope, nextAnchor: string): void {
    override = { scope: nextScope, anchorISO: nextAnchor };
    const needsWindow = monthGridRange(nextAnchor).fromISO !== windowData.windowFromISO;
    const needsYear = nextScope === 'ano' && yearNumber(nextAnchor) !== windowData.eventDaysYear;
    if (needsWindow || needsYear) void loadWindow(nextAnchor);
  }

  /**
   * Objetos y no tuplas a propósito: `{#each … as [valor, etiqueta]}` compila a
   * `to_array` del runtime compartido de Svelte, y ese ayudante acaba en el
   * trozo común que también descarga Hoy —donde el presupuesto va justo—.
   * Costaba 215 bytes de arranque de Hoy por dos listas de tres elementos.
   */
  const SCOPE_OPTIONS = [
    { value: 'semana', label: 'Semana' },
    { value: 'mes', label: 'Mes' },
    { value: 'ano', label: 'Año' }
  ] as const;
  const FILTER_OPTIONS = [
    { value: 'todo', label: 'Todo' },
    { value: 'rutinas', label: 'Rutinas' },
    { value: 'eventos', label: 'Eventos' }
  ] as const;

  const STEP_LABEL: Record<CalendarScope, { back: string; forward: string }> = {
    semana: { back: 'Semana anterior', forward: 'Semana siguiente' },
    mes: { back: 'Mes anterior', forward: 'Mes siguiente' },
    ano: { back: 'Año anterior', forward: 'Año siguiente' }
  };

  function step(direction: -1 | 1): void {
    if (scope === 'semana') {
      show('semana', addDays(anchorISO, 7 * direction));
      return;
    }
    if (scope === 'mes') {
      const index = yearNumber(anchorISO) * 12 + (monthNumber(anchorISO) - 1) + direction;
      show('mes', `${Math.floor(index / 12)}-${pad2((index % 12) + 1)}-01`);
      return;
    }
    show('ano', `${yearNumber(anchorISO) + direction}-01-01`);
  }

  // ── Filtro: estado local, sin ida al servidor (offline los enlaces caerían) ─
  let filter = $state<'todo' | 'rutinas' | 'eventos'>('todo');
  const showRoutines = $derived(filter !== 'eventos');
  const showEvents = $derived(filter !== 'rutinas');

  // ── Expansión de las reglas ────────────────────────────────────────────────
  const weekStart = $derived(anchorISO ? mondayOf(anchorISO) : '');
  const grid = $derived(anchorISO ? monthGridRange(anchorISO) : { fromISO: '', toISO: '' });

  function daysBetweenRange(fromISO: string, toISO: string): CalendarDay[] {
    if (!live || !fromISO) return [];
    return buildCalendarDays({
      // Las REGLAS vienen de la carga de la página; lo que hubo que descargar
      // —eventos y autoría— de la ventana vigente, que puede ser otra.
      routines: live.routines,
      completions: windowData.completions,
      events: windowData.events,
      fromISO,
      toISO,
      todayISO: live.todayISO,
      knownFromISO: windowData.windowFromISO,
      knownToISO: windowData.windowToISO
    });
  }

  const weekDaysView = $derived(
    scope === 'semana' ? daysBetweenRange(weekStart, addDays(weekStart, 6)) : []
  );
  const monthDaysView = $derived(
    scope === 'mes' ? daysBetweenRange(grid.fromISO, grid.toISO) : []
  );
  const monthWeeks = $derived(
    Array.from({ length: Math.ceil(monthDaysView.length / 7) }, (_, index) =>
      monthDaysView.slice(index * 7, index * 7 + 7)
    )
  );
  const yearMonths = $derived(
    scope === 'ano' && live
      ? buildCalendarYear(yearNumber(anchorISO), live.routines, windowData.eventDaysISO)
      : []
  );

  /** El día cuyo detalle se enseña bajo la rejilla del mes. */
  let pickedDay = $state<string | null>(null);
  const selectedDayISO = $derived(
    pickedDay && pickedDay >= grid.fromISO && pickedDay <= grid.toISO
      ? pickedDay
      : monthDaysView.some((day) => day.isToday)
        ? todayISO
        : `${anchorISO.slice(0, 7)}-01`
  );
  const selectedDay = $derived(monthDaysView.find((day) => day.dateISO === selectedDayISO) ?? null);

  // ── Bandas honestas ────────────────────────────────────────────────────────
  const shownFromISO = $derived(
    scope === 'semana' ? weekStart : scope === 'mes' ? grid.fromISO : `${yearNumber(anchorISO)}-01-01`
  );
  const shownToISO = $derived(
    scope === 'semana'
      ? addDays(weekStart, 6)
      : scope === 'mes'
        ? grid.toISO
        : `${yearNumber(anchorISO)}-12-31`
  );
  /** ¿Lo que se está mirando cae fuera de lo que se descargó? */
  const outsideWindow = $derived(
    !!live &&
      scope !== 'ano' &&
      (shownFromISO < windowData.windowFromISO || shownToISO > windowData.windowToISO)
  );
  const yearOutsideWindow = $derived(
    !!live && scope === 'ano' && yearNumber(anchorISO) !== windowData.eventDaysYear
  );
  const notices = $derived(
    live
      ? calendarNotices({
          online,
          outsideWindow: outsideWindow || yearOutsideWindow,
          loadedAtLabel: live.loadedAtLabel
        })
      : []
  );

  /** «Semana del 10 al 16 de agosto», y «del 31 de agosto al 6 de septiembre». */
  function weekLabel(mondayISO: string): string {
    const sunday = addDays(mondayISO, 6);
    const head =
      monthNumber(mondayISO) === monthNumber(sunday)
        ? `${dayNumber(mondayISO)}`
        : `${dayNumber(mondayISO)} de ${monthName(mondayISO)}`;
    return `Semana del ${head} al ${dayNumber(sunday)} de ${monthName(sunday)}`;
  }

  const periodLabel = $derived(
    scope === 'semana'
      ? weekLabel(weekStart)
      : scope === 'mes'
        ? `${MONTH_NAMES[monthNumber(anchorISO) - 1]} de ${yearNumber(anchorISO)}`
        : String(yearNumber(anchorISO))
  );

  // ── Marcar hecha (solo hoy y lo atrasado) ──────────────────────────────────
  const optimistic = new OptimisticActions({
    householdId: context.household.id,
    invalidateToken: 'cc:calendar'
  });
  const actionStatus = optimistic.status;
  $effect(() => optimistic.start());

  let completing = $state<Record<string, true>>({});
  let completedChip = $state<Record<string, string>>({});

  const occurrenceKey = (item: CalendarRoutineItem): string => `${item.routineId} ${item.dueOn}`;

  function markDone(item: CalendarRoutineItem): void {
    if (!live) return;
    const key = occurrenceKey(item);
    if (completing[key] || completedChip[key]) return;
    const routine = live.routines.find((candidate) => candidate.id === item.routineId);
    const next = routine ? nextOccurrenceAfter(routine.rule, item.dueOn) : null;
    completing[key] = true;
    void optimistic
      .run(completeRoutine({ householdId: live.householdId, routineId: item.routineId, dueOn: item.dueOn }), {
        apply: () => {
          completedChip[key] = next
            ? `Hecha ✓ · próxima el ${dayNumber(next)} de ${monthName(next)}`
            : 'Hecha ✓';
        },
        revert: () => {
          delete completedChip[key];
          delete completing[key];
        },
        settle: () => {
          delete completing[key];
          // La ventana vigente puede no ser la que sirvió la página: se refresca
          // ella, no `data`, para que el hecho recién anotado salga con su
          // autoría en el día que se esté mirando.
          void loadWindow(anchorISO);
        }
      })
      .then((outcome) => {
        // Sin red la próxima fecha aún no está confirmada por nadie: el chip no
        // puede prometerla (§4.3).
        if (outcome === 'queued') completedChip[key] = 'Guardada sin conexión · se enviará al volver.';
      })
      .catch(() => {
        delete completing[key];
      });
  }

  /** Segunda línea de una ocurrencia: hechos, nunca notas. */
  function occurrenceLine(item: CalendarRoutineItem): string {
    if (item.state === 'done') {
      const late =
        item.doneLateDays !== null && item.doneLateDays > 0
          ? `, ${plural(item.doneLateDays, 'día después', 'días después')}`
          : '';
      return `Hecha · la marcó ${item.doneBy ?? 'alguien de la casa'}${late} · ${item.audienceLabel}`;
    }
    if (item.state === 'missed') return `Sin marcar · ${item.cadence} · ${item.audienceLabel}`;
    if (item.state === 'unknown') return `${item.cadence} · ${item.audienceLabel}`;
    if (item.state === 'upcoming') return `Toca este día · ${item.audienceLabel}`;
    return `${item.cadence} · ${item.audienceLabel}`;
  }

  // ── Modo real: enlazar/editar calendarios (solo administración) ────────────
  let busy = $state(false);
  let editorOpen = $state(false);
  let editingId = $state<string | null>(null);
  let draftLabel = $state('');
  let draftUrl = $state('');

  function openNew(): void {
    editingId = null;
    draftLabel = '';
    draftUrl = '';
    editorOpen = true;
  }

  function openEdit(source: CalendarSourceView): void {
    editingId = source.id;
    draftLabel = source.label;
    draftUrl = source.url;
    editorOpen = true;
  }

  async function dispatch(envelope: Parameters<typeof optimistic.run>[0]): Promise<string> {
    busy = true;
    try {
      return await optimistic.run(envelope);
    } finally {
      busy = false;
    }
  }

  async function submitSource(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!live || !draftLabel.trim() || !draftUrl.trim()) return;
    const outcome = await dispatch(
      upsertCalendarSource({
        householdId: live.householdId,
        sourceId: editingId ?? undefined,
        label: draftLabel,
        url: draftUrl,
        enabled: true
      })
    );
    if (outcome === 'synced' || outcome === 'queued') editorOpen = false;
  }

  function setEnabled(source: CalendarSourceView, enabled: boolean): void {
    if (!live) return;
    void dispatch(
      upsertCalendarSource({
        householdId: live.householdId,
        sourceId: source.id,
        label: source.label,
        url: source.url,
        enabled
      })
    );
  }

  /** Estado de una fuente en lenguaje llano, sin tecnicismos de sincronización. */
  function sourceStatus(source: CalendarSourceView): { text: string; tone: 'success' | 'warning' } {
    if (!source.enabled) return { text: 'En pausa: no se muestra', tone: 'warning' };
    if (source.lastError) return { text: 'No se pudo leer la última vez', tone: 'warning' };
    if (source.lastSyncLabel) return { text: `Al día (leído el ${source.lastSyncLabel})`, tone: 'success' };
    return { text: 'Pendiente de la primera lectura', tone: 'warning' };
  }
</script>

{#snippet occurrenceList(day: CalendarDay)}
  <p class="block-label" id={`rutinas-${day.dateISO}`}>Rutinas</p>
  <ul class="occ-list" aria-labelledby={`rutinas-${day.dateISO}`}>
    {#each day.routines as item (occurrenceKey(item))}
      {@const key = occurrenceKey(item)}
      <li class={`occ occ-${item.state}`}>
        {#if item.canComplete && canToggle && !completedChip[key]}
          <button
            class="occ-check"
            type="button"
            disabled={completing[key]}
            aria-label={`Marcar hecha: ${item.title}`}
            onclick={() => markDone(item)}
          ><span aria-hidden="true"></span></button>
        {:else}
          <span class="occ-mark" aria-hidden="true">{item.state === 'done' || completedChip[key] ? '✓' : '·'}</span>
        {/if}
        <span class="occ-body">
          {#if item.details}
            <details class="occ-detail">
              <summary>{item.title}</summary>
              <p>{item.details}</p>
            </details>
          {:else}
            <strong>{item.title}</strong>
          {/if}
          <small>{occurrenceLine(item)}</small>
        </span>
        {#if completedChip[key]}
          <span class="status-chip success" role="status">{completedChip[key]}</span>
        {:else if item.state === 'done'}
          <span class="status-chip neutral">Hecha</span>
        {:else if item.state === 'missed'}
          <span class="status-chip neutral">Sin marcar</span>
        {/if}
      </li>
    {/each}
  </ul>
{/snippet}

{#snippet eventList(day: CalendarDay)}
  <p class="block-label" id={`eventos-${day.dateISO}`}>En el calendario</p>
  <ul class="occ-list" aria-labelledby={`eventos-${day.dateISO}`}>
    {#each day.events as event (event.id)}
      <li class="occ occ-event">
        <span class="occ-time">{event.timeLabel}{event.endLabel ? `–${event.endLabel}` : ''}</span>
        <span class="occ-body">
          <strong>{event.title}</strong>
          <small>{event.sourceLabel}{event.location ? ` · ${event.location}` : ''}</small>
        </span>
      </li>
    {/each}
  </ul>
{/snippet}

{#snippet dayCard(day: CalendarDay)}
  <article class="card day-card" id={`dia-${day.dateISO}`} aria-labelledby={`titulo-${day.dateISO}`}>
    <h3 id={`titulo-${day.dateISO}`} class:is-today={day.isToday}>{dayHeading(day.dateISO, todayISO)}</h3>
    {#if !day.known && day.dateISO < todayISO}
      <p class="audit-note">Este día está fuera de lo descargado: no se sabe qué se marcó.</p>
    {/if}
    {#if showRoutines && day.routines.length > 0}
      {@render occurrenceList(day)}
    {/if}
    {#if showEvents && day.events.length > 0}
      {@render eventList(day)}
    {:else if showEvents && !day.known}
      <p class="audit-note">Los eventos del calendario necesitan conexión.</p>
    {/if}
    {#if day.routines.length === 0 && day.events.length === 0}
      <p class="quiet-note">Nada previsto.</p>
    {:else if showRoutines && day.routines.length > 0 && day.events.length === 0 && day.known}
      <p class="quiet-note">Nada más previsto.</p>
    {/if}
  </article>
{/snippet}

<div class="page-wrap">
  {#if live}
    {#snippet actions()}
      {#if live.canManage}
        <button class="button primary" type="button" onclick={() => (editorOpen ? (editorOpen = false) : openNew())}>
          {editorOpen ? 'Cerrar el formulario' : 'Enlazar un calendario'}
        </button>
      {/if}
    {/snippet}
    <PageHeader
      eyebrow={periodLabel}
      title="Calendario"
      description="Las rutinas de la casa y los eventos de los calendarios enlazados, en la misma agenda."
      {actions}
    />

    <ActionStatus status={actionStatus} />

    {#each notices as notice (notice)}
      <p class="queued-note" role="status">{notice}</p>
    {/each}

    {#if editorOpen && live.canManage}
      <section class="card">
        <form class="action-form" onsubmit={submitSource}>
          <h3>{editingId ? 'Editar calendario enlazado' : 'Enlazar un calendario'}</h3>
          <div class="form-grid">
            <label>¿De quién es este calendario?
              <input type="text" bind:value={draftLabel} maxlength="120" required placeholder="Cole de los niños, trabajo de Marta…" autocomplete="off" enterkeyhint="next" />
            </label>
            <label>Enlace del calendario
              <input type="url" bind:value={draftUrl} maxlength="500" required placeholder="https://…" pattern="https://.*" inputmode="url" autocomplete="off" enterkeyhint="done" />
            </label>
          </div>
          <p class="audit-note">
            Pega el enlace de tu calendario (en Google Calendar o el Calendario de Apple: compartir → «dirección iCal» o
            «enlace ICS»). Los eventos aparecerán aquí en cuanto se lea por primera vez, y se actualizan solos varias
            veces al día.
          </p>
          <div class="action-row">
            <button class="button primary" type="submit" disabled={busy}>{editingId ? 'Guardar el calendario' : 'Enlazar el calendario'}</button>
          </div>
        </form>
      </section>
    {/if}

    <nav class="cal-scopes" aria-label="Cómo ver el calendario">
      {#each SCOPE_OPTIONS as option (option.value)}
        <button
          type="button"
          class="chip"
          aria-pressed={scope === option.value}
          onclick={() => show(option.value, anchorISO)}
        >{option.label}</button>
      {/each}
    </nav>

    <div class="cal-move">
      <button class="cal-step" type="button" aria-label={STEP_LABEL[scope].back} onclick={() => step(-1)}>←</button>
      <p class="cal-period" role="status">{periodLabel}</p>
      <button class="cal-step" type="button" aria-label={STEP_LABEL[scope].forward} onclick={() => step(1)}>→</button>
      <button class="chip" type="button" onclick={() => show(scope, todayISO)}>Hoy</button>
    </div>

    <div class="cal-filters" role="group" aria-label="Qué se muestra">
      {#each FILTER_OPTIONS as option (option.value)}
        <button
          type="button"
          class="chip"
          aria-pressed={filter === option.value}
          onclick={() => (filter = option.value)}
        >{option.label}</button>
      {/each}
    </div>

    {#if scope === 'semana'}
      <section aria-labelledby="cal-week-title">
        <h2 id="cal-week-title" class="scope-title">{periodLabel}</h2>
        <div class="week-strip" role="group" aria-label={periodLabel}>
          {#each weekDaysView as day, index (day.dateISO)}
            <a
              class="week-day"
              class:is-today={day.isToday}
              href={`#dia-${day.dateISO}`}
              aria-current={day.isToday ? 'date' : undefined}
              aria-label={dayCountLabel(day)}
            >
              <span class="week-day-name" aria-hidden="true">{WEEKDAY_INITIALS[index]}</span>
              <span class="week-day-number" aria-hidden="true">{dayNumber(day.dateISO)}</span>
              <span class="marks" aria-hidden="true">
                {#if day.routines.length > 0}<i class="mark mark-routine"></i>{/if}
                {#if day.events.length > 0}<i class="mark mark-event"></i>{/if}
              </span>
            </a>
          {/each}
        </div>
        {#each weekDaysView as day (day.dateISO)}
          {@render dayCard(day)}
        {/each}
      </section>
    {:else if scope === 'mes'}
      <section aria-labelledby="cal-month-title">
        <h2 id="cal-month-title" class="scope-title">{periodLabel}</h2>
        <div class="month-scroller">
          <table class="month-grid">
            <caption class="visually-hidden">{periodLabel}: elige un día para ver su detalle.</caption>
            <thead>
              <tr>
                {#each WEEKDAY_INITIALS as initial, index (initial)}
                  <th scope="col"><abbr title={WEEKDAY_NAMES[index]}>{initial}</abbr></th>
                {/each}
              </tr>
            </thead>
            <tbody>
              {#each monthWeeks as week (week[0].dateISO)}
                <tr>
                  {#each week as day (day.dateISO)}
                    <td>
                      <button
                        type="button"
                        class="month-cell"
                        class:is-today={day.isToday}
                        class:is-outside={monthNumber(day.dateISO) !== monthNumber(anchorISO)}
                        aria-pressed={day.dateISO === selectedDayISO}
                        aria-label={dayCountLabel(day)}
                        onclick={() => (pickedDay = day.dateISO)}
                      >
                        <span class="month-cell-number" aria-hidden="true">{dayNumber(day.dateISO)}</span>
                        <span class="marks" aria-hidden="true">
                          {#if showRoutines && day.routines.length > 0}<i class="mark mark-routine"></i>{/if}
                          {#if showEvents && day.events.length > 0}<i class="mark mark-event"></i>{/if}
                        </span>
                      </button>
                    </td>
                  {/each}
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        {#if selectedDay}
          {@render dayCard(selectedDay)}
        {/if}
      </section>
    {:else}
      <section aria-labelledby="cal-year-title">
        <h2 id="cal-year-title" class="scope-title">{periodLabel}</h2>
        <p class="quiet-note">
          El año enseña lo previsto: qué días tienen algo y cuándo toca lo que pasa pocas veces. Para ver quién hizo
          qué, abre el mes.
        </p>
        <div class="year-grid">
          {#each yearMonths as month (month.month)}
            <section class="card year-month" aria-labelledby={`mes-${month.month}`}>
              <h3 id={`mes-${month.month}`}>
                <button type="button" class="link-button" onclick={() => show('mes', `${yearNumber(anchorISO)}-${pad2(month.month)}-01`)}>
                  {month.label}
                </button>
              </h3>
              <p class="quiet-note">{plural(month.busyDays, 'día con algo previsto', 'días con algo previsto')}</p>
              <div class="year-days" aria-hidden="true">
                {#each month.routineDays as hasRoutine, index (index)}
                  <span class="year-day" class:has-routine={hasRoutine} class:has-event={month.eventDays[index]}></span>
                {/each}
              </div>
              {#if month.highlights.length > 0}
                <ul class="year-highlights" aria-label={`Lo señalado de ${month.label}`}>
                  {#each month.highlights as highlight (highlight.dateISO + highlight.title)}
                    <li>
                      <span class="year-highlight-day">{highlight.day}</span>
                      <span class="occ-body">
                        <strong>{highlight.title}</strong>
                        <small>{highlight.cadence} · {highlight.audienceLabel}</small>
                      </span>
                    </li>
                  {/each}
                </ul>
              {/if}
            </section>
          {/each}
        </div>
      </section>
    {/if}

    {#if live.canManage && live.sources.length === 0}
      <section class="card">
        <h2>Ningún calendario enlazado todavía</h2>
        <p class="quiet-note">
          Enlaza el calendario de la familia, del cole o del trabajo y sus eventos aparecerán aquí junto a las
          rutinas de la casa.
        </p>
        <div class="action-row">
          <button class="button primary" type="button" onclick={openNew}>Enlazar un calendario</button>
        </div>
      </section>
    {/if}

    {#if live.canManage && live.sources.length > 0}
      <section class="card" aria-labelledby="linked-calendars-title">
        <div class="section-heading">
          <div><p class="eyebrow">Gestión</p><h2 id="linked-calendars-title">Calendarios enlazados</h2></div>
        </div>
        <div class="ledger-list">
          {#each live.sources as source (source.id)}
            {@const status = sourceStatus(source)}
            <div>
              <span>
                <strong>{source.label}</strong>
                <small>
                  {status.text}{source.enabled && source.lastError ? ' · comprueba que el enlace siga siendo válido' : ''}
                </small>
              </span>
              <span class="contact-actions">
                <span class={`status-chip ${status.tone}`}>{source.enabled ? (source.lastError ? 'Con avisos' : 'Activo') : 'En pausa'}</span>
                <button class="call-button" type="button" disabled={busy} onclick={() => openEdit(source)}>Editar</button>
                <button class="call-button" type="button" disabled={busy} onclick={() => setEnabled(source, !source.enabled)}>
                  {source.enabled ? 'Dejar de mostrarlo' : 'Volver a mostrarlo'}
                </button>
              </span>
            </div>
          {/each}
        </div>
        <p class="card-footnote">
          Quitar un calendario deja de mostrar sus eventos en toda la casa; puedes volver a activarlo cuando quieras.
        </p>
      </section>
    {/if}
  {:else if data.calendar}
    {#snippet fixtureActions()}{#if context.capabilities.includes('calendar.write')}<button class="button primary" type="button">Enlazar un calendario</button>{/if}{/snippet}
    <PageHeader eyebrow={data.calendar.month} title="Calendario" description="Solo lo que afecta a la casa y a quien necesita verlo." actions={fixtureActions} />

    <!-- Demo sin base de datos: banda honesta, sin tecnicismos. La rejilla de
         maqueta con fechas inventadas se retiró: la de verdad se pinta con los
         datos del hogar, y una rejilla falsa aquí solo enseñaba a desconfiar. -->
    <p class="demo-note" role="note">Contenido de demostración: estos eventos no son de tu hogar.</p>

    <section class="card">
      <div class="section-heading"><div><p class="eyebrow">Próximamente</p><h2>Agenda compartida</h2></div></div>
      <ul class="occ-list">
        {#each data.calendar.events as event (event.title + event.date)}
          <li class="occ occ-event">
            <span class="occ-time">{event.date} · {event.time}</span>
            <span class="occ-body"><strong>{event.title}</strong><small>{event.audience}</small></span>
          </li>
        {/each}
      </ul>
    </section>
  {/if}
</div>

<style>
  /* Todo lo de esta pantalla en 390 px: ninguna celda puede crecer más que su
     columna, y la rejilla del mes se desplaza dentro de su caja antes que
     desbordar la página. */
  .cal-scopes, .cal-filters, .cal-move { display: flex; flex-wrap: wrap; align-items: center; gap: .4rem; margin-top: .9rem; }
  .cal-move { gap: .5rem; }
  .cal-period { flex: 1 1 8rem; min-width: 0; font-size: .82rem; font-weight: 750; text-align: center; }

  .chip {
    min-height: 2.4rem; padding: .4rem .8rem; border: 1px solid var(--line); border-radius: 999px;
    background: var(--surface); font-size: .76rem; font-weight: 700; touch-action: manipulation; cursor: pointer;
  }
  .chip[aria-pressed='true'] { border-color: var(--primary); background: var(--primary-soft); color: var(--primary); }
  .cal-step {
    display: grid; width: 2.75rem; height: 2.75rem; place-items: center;
    border: 1px solid var(--line); border-radius: .7rem; background: var(--surface);
    touch-action: manipulation; cursor: pointer;
  }

  .scope-title { margin: 1.1rem 0 .6rem; font-size: .95rem; }

  /* Tira de semana: la letra ENCIMA del número, nunca al lado (a 320 px cada
     celda son ~43 px y no caben en línea). Los siete días caben: no es un
     carrusel y no hay nada oculto. */
  .week-strip { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: .25rem; }
  .week-day {
    display: grid; min-width: 0; min-height: 3.4rem; align-content: center; justify-items: center; gap: .1rem;
    padding: .35rem .1rem; border: 1px solid var(--line); border-radius: .7rem;
    background: var(--surface); text-decoration: none; touch-action: manipulation;
  }
  .week-day-name { color: var(--ink-faint); font-size: .62rem; font-weight: 800; text-transform: uppercase; }
  .week-day-number { font-size: .85rem; font-weight: 750; }
  .week-day.is-today { border-color: var(--primary); background: var(--primary-soft); }

  /* Las marcas de densidad son DECORACIÓN: la cuenta exacta va en el nombre
     accesible del día. Se distinguen por forma —cuadrado la rutina, círculo el
     evento—, nunca solo por color. */
  .marks { display: flex; min-height: .42rem; gap: .16rem; }
  .mark { width: .34rem; height: .34rem; }
  .mark-routine { background: var(--primary); }
  .mark-event { border-radius: 50%; background: var(--accent); }

  .month-scroller { overflow-x: auto; }
  .month-grid { width: 100%; border-collapse: collapse; table-layout: fixed; }
  .month-grid th { padding: .3rem 0; color: var(--ink-faint); font-size: .62rem; font-weight: 800; }
  .month-grid th abbr { text-decoration: none; }
  .month-grid td { min-width: 0; padding: .08rem; }
  .month-cell {
    display: grid; width: 100%; min-height: 2.9rem; align-content: center; justify-items: center; gap: .12rem;
    padding: .25rem .1rem; border: 1px solid transparent; border-radius: .55rem;
    background: var(--surface); font-size: .78rem; touch-action: manipulation; cursor: pointer;
  }
  /* Los días del mes vecino se atenúan hasta `--ink-faint`, que es el gris más
     claro que llega al AA sobre el papel, y ni un tono más: `--line-strong` es
     un color de LÍNEA y como texto se queda en 2,2:1. Tampoco se les cambia el
     fondo, porque sobre `--canvas-deep` ese mismo gris baja a 4,1:1. Lo que de
     verdad los distingue para todo el mundo es el nombre accesible de la
     celda, que dice el día y el mes completos. */
  .month-cell.is-outside .month-cell-number { color: var(--ink-faint); font-weight: 400; }
  .month-cell.is-today { border-color: var(--primary); background: var(--primary-soft); font-weight: 800; }
  .month-cell[aria-pressed='true'] { border-color: var(--primary); box-shadow: inset 0 0 0 1px var(--primary); }

  .day-card { margin-top: .7rem; }
  .day-card h3 { font-size: .9rem; }
  .day-card h3.is-today { color: var(--primary); }
  .block-label { margin-top: .8rem; color: var(--ink-faint); font-size: .68rem; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; }

  .occ-list { display: grid; margin: .25rem 0 0; padding: 0; list-style: none; }
  .occ { display: flex; align-items: flex-start; gap: .55rem; border-top: 1px solid var(--line); padding: .6rem 0; }
  .occ-list > .occ:first-child { border-top: none; }
  .occ-body { display: grid; min-width: 0; flex: 1 1 auto; gap: .1rem; }
  .occ-body strong, .occ-detail summary { font-size: .84rem; font-weight: 750; }
  .occ-body small { color: var(--ink-soft); font-size: .72rem; }
  .occ-detail summary { cursor: pointer; }
  .occ-detail p { margin-top: .3rem; color: var(--ink-soft); font-size: .76rem; }

  /* La forma es la promesa: la rutina lleva una casilla que se puede marcar; el
     evento lleva una hora. Objetivo táctil de 44×44 en la casilla. */
  .occ-check {
    display: grid; width: 2.75rem; height: 2.75rem; flex: 0 0 auto; place-items: center;
    border: none; background: none; touch-action: manipulation; cursor: pointer;
  }
  .occ-check span { width: 1.35rem; height: 1.35rem; border: 2px solid var(--line-strong); border-radius: .4rem; }
  .occ-check:hover span { border-color: var(--primary); }
  .occ-check:disabled { opacity: .5; }
  .occ-mark { width: 2.75rem; flex: 0 0 auto; color: var(--ink-faint); text-align: center; }
  .occ-time { flex: 0 0 4.1rem; color: var(--ink); font-size: .74rem; font-weight: 750; }

  /* Lo hecho se tacha, y nada más. Atenuar la fila con `opacity` bajaba el
     contraste de su segunda línea por debajo del AA (axe lo caza a 390 px), y
     la información de que está hecha ya la dan el tachado y el chip. */
  .occ-done .occ-body strong, .occ-done .occ-detail summary { text-decoration: line-through; }
  /* «Sin marcar» es un HECHO, no una nota: tono neutro. Ni rojo ni verde
     califican a nadie en esta pantalla (E2). */
  .status-chip.neutral { border: 1px solid var(--line); background: var(--surface); color: var(--ink-soft); }

  .year-grid { display: grid; gap: .7rem; grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr)); }
  .year-month h3 { font-size: .88rem; }
  .link-button { border: none; background: none; color: var(--primary); font-weight: 800; text-decoration: underline; cursor: pointer; padding: 0; }
  .year-days { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: .14rem; margin-top: .5rem; }
  .year-day { height: .55rem; border-radius: .15rem; background: var(--canvas-deep); }
  .year-day.has-routine { background: var(--primary); }
  .year-day.has-event { border-radius: 50%; background: var(--accent); }
  .year-day.has-routine.has-event { border-radius: .15rem; background: linear-gradient(135deg, var(--primary) 50%, var(--accent) 50%); }
  .year-highlights { display: grid; margin: .55rem 0 0; padding: 0; list-style: none; }
  .year-highlights li { display: flex; align-items: flex-start; gap: .5rem; border-top: 1px solid var(--line); padding: .45rem 0; }
  .year-highlight-day { flex: 0 0 1.6rem; font-size: .78rem; font-weight: 800; text-align: right; }

  .quiet-note { margin-top: .5rem; color: var(--ink-soft); font-size: .76rem; }
  .visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }

  @media (width <= 30rem) {
    .occ-time { flex-basis: 3.4rem; }
    .year-grid { grid-template-columns: minmax(0, 1fr); }
  }
</style>
