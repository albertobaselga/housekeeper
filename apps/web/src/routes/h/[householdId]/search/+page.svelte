<script lang="ts">
  import PageHeader from '$lib/components/PageHeader.svelte';
  import { useAppContext } from '$lib/auth/context';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const context = useAppContext();
</script>

<svelte:head><title>Buscar · Casa Clara</title></svelte:head>

<div class="page-wrap search-page">
  <PageHeader eyebrow="Buscador global" title="¿Qué necesitas encontrar?" description="Wiki, recetas y contactos en una sola búsqueda." />

  <form class="search-form" method="GET">
    <label class="sr-only" for="global-query">Buscar en toda la casa</label>
    <span aria-hidden="true">⌕</span>
    <input id="global-query" name="q" type="search" value={data.search.query} placeholder="Prueba «lavadora» o «pediatra»" />
    <button class="button primary" type="submit">Buscar</button>
  </form>

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
</div>
