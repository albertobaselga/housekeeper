<script lang="ts">
  import { invalidate } from '$app/navigation';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import { useAppContext } from '$lib/auth/context';
  import { upsertCalendarSource } from '$lib/calendar/commands';
  import { queueCommand, type QueueCommandResult } from '$lib/offline/queue-command';
  import type { CalendarSourceView } from '$lib/server/calendar.server';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const context = useAppContext();

  const live = $derived(data.live);
  const hasEvents = $derived((live?.days ?? []).some((day) => day.events.length > 0));

  // ── Modo real: enlazar/editar calendarios (solo administración) ────────────
  let busy = $state(false);
  let feedback = $state<QueueCommandResult | null>(null);
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

  async function dispatch(envelope: Parameters<typeof queueCommand>[0]): Promise<QueueCommandResult> {
    busy = true;
    try {
      const result = await queueCommand(envelope);
      feedback = result;
      if (result.outcome === 'synced') await invalidate('cc:calendar');
      return result;
    } finally {
      busy = false;
    }
  }

  async function submitSource(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!live || !draftLabel.trim() || !draftUrl.trim()) return;
    const result = await dispatch(
      upsertCalendarSource({
        householdId: live.householdId,
        sourceId: editingId ?? undefined,
        label: draftLabel,
        url: draftUrl,
        enabled: true
      })
    );
    if (result.outcome === 'synced' || result.outcome === 'queued') editorOpen = false;
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

<svelte:head><title>Calendario · Casa Clara</title></svelte:head>

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
      eyebrow={live.monthLabel}
      title="Calendario"
      description="Los próximos días del hogar, con los eventos de los calendarios que la familia ha enlazado."
      {actions}
    />

    {#if feedback}
      <p
        class={feedback.outcome === 'synced' ? 'success-message' : feedback.outcome === 'queued' ? 'queued-note' : 'form-error'}
        role="status"
      >{feedback.message}</p>
    {/if}

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

    {#if hasEvents}
      <section aria-label="Agenda de los próximos días">
        {#each live.days as day (day.dateISO)}
          <article class="card" aria-labelledby={`day-${day.dateISO}`}>
            <div class="section-heading">
              <div>
                <p class="eyebrow">{day.isToday ? 'Hoy' : 'Próximamente'}</p>
                <h2 id={`day-${day.dateISO}`}>{day.label}</h2>
              </div>
            </div>
            <div class="ledger-list">
              {#each day.events as event (event.id)}
                <div>
                  <span>
                    <strong>{event.title}</strong>
                    <small>
                      {event.timeLabel}{event.endLabel ? `–${event.endLabel}` : ''}
                      · {event.sourceLabel}{event.location ? ` · ${event.location}` : ''}
                    </small>
                  </span>
                </div>
              {/each}
            </div>
          </article>
        {/each}
      </section>
    {:else if live.canManage && live.sources.length === 0}
      <section class="empty-state">
        <span aria-hidden="true">▦</span>
        <h2>Ningún calendario enlazado todavía</h2>
        <p>
          Enlaza el calendario de la familia, del cole o del trabajo y sus eventos aparecerán aquí y en «Hoy» para
          todos los que ven el calendario.
        </p>
        <button class="button primary" type="button" onclick={openNew}>Enlazar un calendario</button>
      </section>
    {:else if live.canManage}
      <section class="empty-state">
        <span aria-hidden="true">▦</span>
        <h2>Nada previsto en los próximos 30 días</h2>
        <p>Los calendarios enlazados no traen eventos próximos ahora mismo.</p>
      </section>
    {:else}
      <section class="empty-state">
        <span aria-hidden="true">▦</span>
        <h2>Nada previsto en los próximos días</h2>
        <p>Si falta un calendario por enlazar, pídeselo a la familia: ellos gestionan el calendario compartido.</p>
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

    <!-- Demo sin base de datos: banda honesta, sin tecnicismos. -->
    <p class="demo-note" role="note">Contenido de demostración: estos eventos no son de tu hogar.</p>

    <div class="calendar-layout">
      <section class="card mini-calendar" aria-label={data.calendar.month}>
        <header><button type="button" aria-label="Mes anterior">←</button><h2>{data.calendar.month}</h2><button type="button" aria-label="Mes siguiente">→</button></header>
        <div class="calendar-grid week-labels" aria-hidden="true">{#each ['L', 'M', 'X', 'J', 'V', 'S', 'D'] as day}<span>{day}</span>{/each}</div>
        <div class="calendar-grid dates">
          {#each Array(35) as _, index}
            {@const date = index - 4}
            <button type="button" class:muted={date < 1 || date > 31} class:today={date === 7} tabindex={date < 1 || date > 31 ? -1 : 0}>{date < 1 ? 31 + date : date > 31 ? date - 31 : date}</button>
          {/each}
        </div>
      </section>

      <section class="card event-list"><div class="section-heading"><div><p class="eyebrow">Próximamente</p><h2>Agenda compartida</h2></div></div>
        {#each data.calendar.events as event}
          <article><span class={`event-dot ${event.tone}`} aria-hidden="true"></span><time><strong>{event.date}</strong><span>{event.time}</span></time><div><strong>{event.title}</strong><small>{event.audience}</small></div></article>
        {/each}
      </section>
    </div>
  {/if}
</div>
