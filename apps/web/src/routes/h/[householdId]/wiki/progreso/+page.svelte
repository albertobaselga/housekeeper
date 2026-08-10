<script lang="ts">
  import PageHeader from '$lib/components/PageHeader.svelte';
  import { useAppContext } from '$lib/auth/context';
  import type { PageData } from './$types';

  /*
   * AVANCE DE LA GUÍA.
   *
   * Dos lecturas de la misma pantalla, deliberadamente asimétricas:
   *
   *  · Para quien lee: SU avance con detalle —qué le falta y qué ha cambiado—,
   *    porque es suyo.
   *  · Para quien administra: cuántas notas lleva cada persona en cada apartado,
   *    y nada más. Ni qué nota abrió, ni cuándo, ni cuánto tardó. Eso no es una
   *    decisión de esta pantalla: la base de datos no guarda ninguna fecha, así
   *    que no existe consulta que pueda enseñarla.
   */

  let { data }: { data: PageData } = $props();
  const context = useAppContext();

  const base = $derived(`/h/${context.household.id}/wiki`);
  const progress = $derived(data.progress);
  const outline = $derived(progress.outline);
  const summary = $derived(outline.summary);
  const pending = $derived(outline.order.filter((note) => note.state === 'pending'));
  const changed = $derived(outline.order.filter((note) => note.state === 'changed'));

  function percent(read: number, total: number): number {
    return total === 0 ? 0 : Math.round((read / total) * 100);
  }
</script>

<svelte:head><title>Avance de la guía · Casa Clara</title></svelte:head>

<div class="page-wrap">
  <PageHeader
    eyebrow="Guía de la casa"
    title="Cómo va la lectura"
    description="La guía se consulta cuando hace falta, pero conviene habérsela leído entera al menos una vez."
  />

  <p class="audit-note wiki-meta"><a href={base}>← Guía de la casa</a></p>

  <!-- 1 · Lo propio, siempre. -->
  <section class="card" aria-labelledby="mio-title">
    <div class="section-heading">
      <div>
        <h2 id="mio-title">Tu lectura</h2>
        <p class="audit-note">
          {#if summary.total === 0}
            Todavía no hay notas publicadas en la guía.
          {:else if summary.complete}
            Te has leído la guía entera: {summary.total} notas.
          {:else}
            Llevas {summary.read} de {summary.total} notas.
          {/if}
        </p>
      </div>
      {#if summary.nextSlug}
        <a class="button primary" href={`${base}/libro/${summary.nextSlug}`}>
          {summary.read === 0 ? 'Empezar a leer' : 'Seguir leyendo'}
        </a>
      {/if}
    </div>

    <div
      class="book-progress-bar"
      role="progressbar"
      aria-label="Notas leídas"
      aria-valuenow={summary.read}
      aria-valuemin="0"
      aria-valuemax={summary.total}
    >
      <span style={`width: ${percent(summary.read, summary.total)}%`}></span>
    </div>

    <ul class="guide-chapter-list">
      {#each outline.chapters as chapter (chapter.id)}
        <li>
          <span class="guide-chapter-name">{chapter.name}</span>
          <span class="guide-chapter-count" class:done={chapter.read === chapter.total}>
            {chapter.read} de {chapter.total}
          </span>
        </li>
      {/each}
    </ul>
  </section>

  {#if pending.length > 0}
    <section class="card" aria-labelledby="pendientes-title">
      <div class="section-heading"><div><h2 id="pendientes-title">Te faltan estas</h2></div></div>
      <ul class="wiki-recent">
        {#each pending.slice(0, 12) as note (note.id)}
          <li><a href={`${base}/libro/${note.slug}`}>{note.title}</a></li>
        {/each}
      </ul>
      {#if pending.length > 12}
        <p class="audit-note">Y {pending.length - 12} más.</p>
      {/if}
    </section>
  {/if}

  {#if changed.length > 0}
    <section class="card" aria-labelledby="cambiadas-title">
      <div class="section-heading">
        <div>
          <h2 id="cambiadas-title">Han cambiado desde que las leíste</h2>
          <p class="audit-note">
            Solo aparecen aquí cuando cambian las palabras. Corregir una coma o poner algo en
            negrita no te obliga a releer nada.
          </p>
        </div>
      </div>
      <ul class="wiki-recent">
        {#each changed as note (note.id)}
          <li><a href={`${base}/libro/${note.slug}`}>{note.title}</a></li>
        {/each}
      </ul>
    </section>
  {/if}

  <!-- 2 · La casa, solo para quien administra: cuentas, nunca rastro. -->
  {#if progress.household}
    <section class="card" aria-labelledby="casa-title">
      <div class="section-heading">
        <div>
          <h2 id="casa-title">Quién se ha leído la guía</h2>
          <p class="audit-note">
            Esto es TODO lo que la aplicación guarda: cuántas notas lleva cada persona en cada
            apartado. No hay horas, ni fechas, ni qué nota abrió cada día; la base de datos no
            tiene dónde apuntarlo.
          </p>
        </div>
      </div>

      {#if progress.household.length === 0}
        <p class="audit-note">Todavía no hay nadie más con acceso a la guía.</p>
      {:else}
        <div class="guide-people">
          {#each progress.household as person (person.membershipId)}
            <article class="guide-person">
              <div class="wiki-node-row">
                <strong>{person.name}</strong>
                <small>{person.roleLabel}</small>
                {#if person.complete}
                  <span class="status-chip success">Guía leída</span>
                {:else}
                  <span class="status-chip warning">Le faltan {person.total - person.read}</span>
                {/if}
              </div>
              <div
                class="book-progress-bar"
                role="progressbar"
                aria-label={`Notas leídas por ${person.name}`}
                aria-valuenow={person.read}
                aria-valuemin="0"
                aria-valuemax={person.total}
              >
                <span style={`width: ${percent(person.read, person.total)}%`}></span>
              </div>
              <ul class="guide-chapter-list">
                {#each person.chapters as chapter (chapter.spaceId)}
                  <li>
                    <span class="guide-chapter-name">{chapter.name}</span>
                    <span class="guide-chapter-count" class:done={chapter.read === chapter.total}>
                      {chapter.read} de {chapter.total}
                    </span>
                  </li>
                {/each}
              </ul>
            </article>
          {/each}
        </div>
      {/if}
    </section>
  {/if}
</div>
