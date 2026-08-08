<script lang="ts">
  import { onMount } from 'svelte';
  import { browser } from '$app/environment';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import { useAppContext } from '$lib/auth/context';
  import { readCriticalSnapshot } from '$lib/offline/idb';
  import { searchOffline, type OfflineSearchResult } from '$lib/search/offline';
  import { highlightSegments } from '$lib/wiki/highlight';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const context = useAppContext();

  const live = $derived(data.live);
  const liveTotal = $derived(live ? live.wiki.length + live.contacts.length : 0);

  // Modo sin conexión: resultados desde el CriticalSnapshot de IndexedDB.
  // Online la página funciona exactamente igual (formulario GET sin tocar).
  let offline = $state<{ query: string; results: OfflineSearchResult[] } | null>(null);

  async function runOfflineSearch(query: string): Promise<void> {
    let results: OfflineSearchResult[] = [];
    if (query) {
      try {
        results = searchOffline(query, await readCriticalSnapshot(context.household.id));
      } catch {
        results = [];
      }
    }
    offline = { query, results };
  }

  function handleSubmit(event: SubmitEvent): void {
    if (!browser || navigator.onLine !== false) return;
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    const query = String(form.get('q') ?? '').trim();
    if (query) void runOfflineSearch(query);
    else offline = null;
  }

  onMount(() => {
    // SSR sin datos vivos y sin red: el snapshot local sustituye a la fixture.
    const query = (live?.query ?? data.search?.query ?? '').trim();
    if (navigator.onLine === false && query && !live) void runOfflineSearch(query);
  });

  function telHref(phone: string): string {
    return `tel:${phone.replace(/[^+\d]/g, '')}`;
  }
</script>

{#snippet marked(text: string, query: string)}
  {#each highlightSegments(text, query) as segment}
    {#if segment.hit}<mark>{segment.text}</mark>{:else}{segment.text}{/if}
  {/each}
{/snippet}

<svelte:head><title>Buscar · Casa Clara</title></svelte:head>

<div class="page-wrap search-page">
  <PageHeader eyebrow="Buscador global" title="¿Qué necesitas encontrar?" description="La guía de la casa, las recetas y los contactos en una sola búsqueda." />

  <form class="search-form" method="GET" onsubmit={handleSubmit}>
    <label class="sr-only" for="global-query">Buscar en toda la casa</label>
    <span aria-hidden="true">⌕</span>
    <input id="global-query" name="q" type="search" autocomplete="off" enterkeyhint="search" value={offline?.query ?? live?.query ?? data.search?.query ?? ''} placeholder="Prueba «lavadora» o «pediatra»" />
    <button class="button primary" type="submit">Buscar</button>
  </form>

  {#if offline}
    <p class="audit-note" role="status">Sin conexión · Resultados guardados en este dispositivo</p>
    {#if offline.results.length}
      <section class="search-results" aria-labelledby="offline-results-title">
        <h2 id="offline-results-title">{offline.results.length} resultado{offline.results.length === 1 ? '' : 's'} guardado{offline.results.length === 1 ? '' : 's'}</h2>
        {#each offline.results as result (result.kind + result.id)}
          {#if result.kind === 'contact' && result.phone}
            <a href={telHref(result.phone)} class="contact-result">
              <span class="result-type">Contacto</span>
              <span>
                <strong>{@render marked(result.title, offline.query)}</strong>
                <small>{result.detail} · {result.phone}</small>
              </span>
              <span class="button secondary small-button">Llamar</span>
            </a>
          {:else}
            <a href={`/h/${context.household.id}/wiki`}>
              <span class="result-type">Guía</span>
              <span>
                <strong>{@render marked(result.title, offline.query)}</strong>
                <small>{result.detail} · {@render marked(result.excerpt, offline.query)}</small>
              </span>
              <span aria-hidden="true">→</span>
            </a>
          {/if}
        {/each}
      </section>
    {:else}
      <section class="empty-state">
        <span aria-hidden="true">⌕</span>
        <h2>No aparece “{offline.query}” en lo guardado</h2>
        <p>Sin conexión solo buscamos en lo que está guardado en este dispositivo. Vuelve a intentarlo cuando haya cobertura.</p>
      </section>
    {/if}
  {:else if live}
    {#if liveTotal > 0}
      <section class="search-results" aria-labelledby="results-title">
        <h2 id="results-title">{liveTotal} resultado{liveTotal === 1 ? '' : 's'}</h2>

        {#if live.wiki.length}
          <h3>Guía de la casa</h3>
          {#each live.wiki as result (result.id)}
            <a href={`/h/${context.household.id}/wiki/${result.slug}`}>
              <span class="result-type">Guía</span>
              <span>
                <strong>{@render marked(result.title, live.query)}</strong>
                <small>{result.spaceName}{result.status === 'draft' ? ' · sin publicar' : ''} · {@render marked(result.excerpt, live.query)}</small>
              </span>
              <span aria-hidden="true">→</span>
            </a>
          {/each}
        {/if}

        {#if live.contacts.length}
          <h3>Contactos</h3>
          {#each live.contacts as contact (contact.id)}
            <a href={telHref(contact.phone)} class="contact-result">
              <span class="result-type">Contacto</span>
              <span>
                <strong>{@render marked(contact.name, live.query)}</strong>
                <small>{@render marked(contact.role, live.query)} · {contact.phone}</small>
              </span>
              <span class="button secondary small-button">Llamar</span>
            </a>
          {/each}
        {/if}
      </section>
    {:else}
      <section class="empty-state">
        <span aria-hidden="true">⌕</span>
        <h2>No aparece “{live.query}”</h2>
        <p>Hemos apuntado esta búsqueda para que alguien escriba la respuesta en la guía. Prueba con menos palabras o con el nombre del aparato, receta o persona.</p>
      </section>
    {/if}
  {:else if data.search}
    {#if !data.search.query}
      <section class="suggestions" aria-labelledby="suggestions-title"><h2 id="suggestions-title">Búsquedas sugeridas</h2><div>{#each data.search.suggested as term}<a href={`?q=${encodeURIComponent(term)}`}>{term}</a>{/each}</div></section>
    {:else if data.search.results.length}
      <section class="search-results" aria-labelledby="results-title">
        <h2 id="results-title">{data.search.results.length} resultado{data.search.results.length === 1 ? '' : 's'}</h2>
        {#each data.search.results as result}
          <a href={`/h/${context.household.id}/${result.href}`}><span class="result-type">{result.type}</span><span><strong>{result.title}</strong><small>{result.description}</small></span><span aria-hidden="true">→</span></a>
        {/each}
      </section>
    {:else}
      <section class="empty-state"><span aria-hidden="true">⌕</span><h2>No aparece “{data.search.query}”</h2><p>Prueba con menos palabras o busca el nombre del aparato, receta o persona.</p></section>
    {/if}
  {/if}
</div>
