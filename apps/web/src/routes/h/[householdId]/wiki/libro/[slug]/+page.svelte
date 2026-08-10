<script lang="ts">
  import { tick } from 'svelte';
  import { goto } from '$app/navigation';
  import WikiMarkdown from '$lib/components/wiki/WikiMarkdown.svelte';
  import { useAppContext } from '$lib/auth/context';
  import { flushGuideReads, markGuideNoteRead } from '$lib/guide/mark-read';
  import { DwellClock, MIN_DWELL_MS, countsAsRead } from '$lib/guide/reading';
  import type { GuideNoteReadState } from '$lib/server/wiki.server';
  import type { PageData } from './$types';

  /*
   * MODO LIBRO — la Guía leída de un tirón.
   *
   * Cada nota es una URL propia (`/wiki/libro/<slug>`), no un panel dentro de
   * una sola página: así el botón de atrás del navegador, compartir un enlace y
   * recargar hacen lo que se espera, y el servidor decide siempre qué se ve.
   *
   * «Pasar de página marca la anterior como leída», con las dos condiciones que
   * explica $lib/guide/reading.ts: haber visto el final del texto y un mínimo de
   * permanencia. Si no se cumplen, la navegación funciona igual —consultar
   * siempre se puede— pero no se apunta nada, y la pantalla lo dice.
   */

  let { data }: { data: PageData } = $props();
  const context = useAppContext();

  const base = $derived(`/h/${context.household.id}/wiki`);
  const book = $derived(data.book);
  const note = $derived(book.note);
  const outline = $derived(book.outline);

  let heading = $state<HTMLElement | null>(null);
  let endMarker = $state<HTMLElement | null>(null);
  let reachedEnd = $state(false);
  let dwellDone = $state(false);
  let clock = new DwellClock();
  /** Estado que la pantalla enseña, adelantándose al servidor al marcar. */
  let localState = $state<GuideNoteReadState | null>(null);
  let savedOffline = $state(false);

  const shownState = $derived(localState ?? note.state);
  const readCount = $derived(
    outline.summary.read + (shownState !== 'pending' && note.state === 'pending' ? 1 : 0)
  );
  const percent = $derived(
    outline.summary.total === 0 ? 0 : Math.round((readCount / outline.summary.total) * 100)
  );

  // Nota nueva: cronómetro a cero, final por ver y foco en el título para que
  // el teclado y el lector de pantalla empiecen donde empieza el texto.
  $effect(() => {
    const id = note.id;
    void id;
    reachedEnd = false;
    dwellDone = false;
    savedOffline = false;
    localState = null;
    clock = new DwellClock();
    clock.start();
    void tick().then(() => heading?.focus());
    // Un latido corto mientras no se cumple la permanencia: solo sirve para que
    // el aviso de abajo diga la verdad en cuanto se cumple.
    const beat = setInterval(() => {
      if (clock.elapsedMs >= MIN_DWELL_MS) {
        dwellDone = true;
        clearInterval(beat);
      }
    }, 250);
    return () => clearInterval(beat);
  });

  // El final del texto a la vista es la señal de «lo he recorrido». En una nota
  // más corta que la ventana se cumple sola, que es lo correcto.
  $effect(() => {
    const target = endMarker;
    if (!target || typeof IntersectionObserver === 'undefined') {
      reachedEnd = true;
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) reachedEnd = true;
      },
      { rootMargin: '0px 0px -8% 0px' }
    );
    observer.observe(target);
    return () => observer.disconnect();
  });

  // El tiempo solo cuenta con la pestaña a la vista: dejarla abierta e irse no
  // es leer.
  $effect(() => {
    if (typeof document === 'undefined') return;
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') clock.start();
      else clock.pause();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  });

  // Lo que quedó sin enviar por falta de red se manda al recuperarla.
  $effect(() => {
    if (typeof window === 'undefined') return;
    const householdId = context.household.id;
    const onOnline = (): void => void flushGuideReads(householdId);
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  });

  const eligible = $derived(countsAsRead({ dwellMs: dwellDone ? MIN_DWELL_MS : 0, reachedEnd }));

  async function recordRead(): Promise<void> {
    if (!countsAsRead({ dwellMs: clock.elapsedMs, reachedEnd })) return;
    if (shownState === 'read') return;
    localState = 'read';
    savedOffline = !(await markGuideNoteRead(context.household.id, note.id));
  }

  async function turnForward(): Promise<void> {
    const target = book.next;
    await recordRead();
    if (target) await goto(`${base}/libro/${target.slug}`);
    else await goto(`${base}/progreso`);
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target as HTMLElement | null;
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      void turnForward();
    } else if (event.key === 'ArrowLeft' && book.previous) {
      event.preventDefault();
      void goto(`${base}/libro/${book.previous.slug}`);
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="page-wrap book-wrap">
  <nav class="book-topbar" aria-label="Salir del modo libro">
    <a href={base}>← Guía de la casa</a>
    <a href={`${base}/${note.slug}`}>Ver la nota suelta</a>
  </nav>

  <div class="book-progress">
    <div
      class="book-progress-bar"
      role="progressbar"
      aria-label="Avance de la lectura"
      aria-valuenow={readCount}
      aria-valuemin="0"
      aria-valuemax={outline.summary.total}
    >
      <span style={`width: ${percent}%`}></span>
    </div>
    <p class="audit-note">
      Nota {note.order} de {outline.summary.total} · has leído {readCount}
      {#if outline.summary.changed > 0}· {outline.summary.changed} han cambiado desde que las leíste{/if}
    </p>
  </div>

  <article class="card book-page">
    <p class="eyebrow">{note.chapterName}</p>
    <h1 bind:this={heading} tabindex="-1">{note.title}</h1>

    {#if shownState === 'read'}
      <p class="book-flag success"><span aria-hidden="true">✓</span> Leída</p>
    {:else if shownState === 'changed'}
      <p class="book-flag warning">
        <span aria-hidden="true">↻</span> La leíste, pero el texto ha cambiado desde entonces.
      </p>
    {/if}

    <WikiMarkdown blocks={data.blocks} />

    <div class="book-end" bind:this={endMarker}>
      <p class="audit-note">
        {#if savedOffline}
          Sin conexión: se ha guardado en este dispositivo y se apuntará al volver la red.
        {:else if shownState !== 'pending'}
          Fin de la nota.
        {:else if eligible}
          Al pasar de página se marcará como leída.
        {:else}
          Se marcará como leída cuando llegues aquí y pases de página.
        {/if}
      </p>
    </div>
  </article>

  <nav class="book-nav" aria-label="Pasar de página">
    {#if book.previous}
      <a class="button secondary" href={`${base}/libro/${book.previous.slug}`} data-sveltekit-preload-data="hover">
        <span aria-hidden="true">←</span> Anterior
      </a>
    {:else}
      <span class="book-nav-placeholder"></span>
    {/if}

    {#if book.next}
      <button class="button primary" type="button" onclick={() => void turnForward()}>
        Siguiente <span aria-hidden="true">→</span>
      </button>
    {:else}
      <button class="button primary" type="button" onclick={() => void turnForward()}>
        He terminado la guía
      </button>
    {/if}
  </nav>

  <details class="card book-index">
    <summary>Índice de la guía ({outline.chapters.length} apartados, {outline.summary.total} notas)</summary>
    <ol class="book-chapters">
      {#each outline.chapters as chapter (chapter.id)}
        <li>
          <p class="book-chapter-title">
            <strong>{chapter.name}</strong>
            <small>{chapter.read} de {chapter.total}</small>
          </p>
          <ul class="book-chapter-notes">
            {#each chapter.notes as entry (entry.id)}
              <li class:current={entry.id === note.id}>
                <a href={`${base}/libro/${entry.slug}`}>
                  <span class="book-mark" aria-hidden="true">
                    {entry.state === 'read' ? '✓' : entry.state === 'changed' ? '↻' : '·'}
                  </span>
                  {entry.title}
                  <span class="sr-only">
                    {entry.state === 'read' ? ' (leída)' : entry.state === 'changed' ? ' (cambió desde que la leíste)' : ' (pendiente)'}
                  </span>
                </a>
              </li>
            {/each}
          </ul>
        </li>
      {/each}
    </ol>
  </details>
</div>
