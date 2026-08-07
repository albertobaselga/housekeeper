<script lang="ts">
  import { untrack } from 'svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import { useAppContext } from '$lib/auth/context';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const context = useAppContext();
  let selectedId = $state<string>(untrack(() => data.recipes.recipes[0]?.id ?? ''));
  let servings = $state(4);
  let selected = $derived(data.recipes.recipes.find((recipe) => recipe.id === selectedId) ?? data.recipes.recipes[0]);
</script>

<svelte:head><title>Recetas · Casa Clara</title></svelte:head>

<div class="page-wrap">
  <PageHeader eyebrow={`${data.recipes.recipes.length} recetas probadas`} title="Recetario" description="Cantidades fáciles de adaptar y advertencias a la vista." />

  <div class="recipe-layout">
    <div class="recipe-gallery">
      {#each data.recipes.recipes as recipe}
        <button type="button" class="recipe-card" class:active={recipe.id === selectedId} onclick={() => { selectedId = recipe.id; servings = recipe.servings; }}>
          <span class={`recipe-visual ${recipe.tone}`} aria-hidden="true"><i>◇</i></span>
          <span class="recipe-copy"><small>{recipe.time} · {recipe.servings} raciones</small><strong>{recipe.title}</strong><span>{recipe.tags.join(' · ')}</span></span>
        </button>
      {/each}
    </div>

    {#if selected}
      <article class="card recipe-detail">
        <p class="eyebrow">Receta seleccionada</p><h2>{selected.title}</h2>
        <div class="serving-control"><span>Raciones</span><button type="button" aria-label="Quitar una ración" onclick={() => servings = Math.max(1, servings - 1)}>−</button><strong>{servings}</strong><button type="button" aria-label="Añadir una ración" onclick={() => servings += 1}>+</button></div>
        <h3>Ingredientes</h3>
        <ul class="ingredient-list">
          {#each selected.ingredients as ingredient}<li><span>{ingredient}</span><small>× {(servings / selected.servings).toLocaleString('es-ES', { maximumFractionDigits: 2 })}</small></li>{/each}
        </ul>
        {#if context.capabilities.includes('content.write')}<button class="button secondary full" type="button">Editar receta</button>{/if}
      </article>
    {/if}
  </div>
</div>
