<script lang="ts">
  import { untrack } from 'svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import ActionStatus from '$lib/components/ActionStatus.svelte';
  import { useAppContext } from '$lib/auth/context';
  import { OptimisticActions } from '$lib/offline/optimistic';
  import { formatQuantityEs, scaleQuantity } from '$lib/food/quantities';
  import {
    setRecipeDetails,
    upsertDiner,
    upsertFood,
    type AllergenSeverity,
    type IngredientScaling
  } from '$lib/food/commands';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const context = useAppContext();

  const catalog = $derived(data.catalog);
  const recipe = $derived(data.recipe);
  const base = $derived(`/h/${context.household.id}/recipes`);

  // Las acciones de escritura solo existen sobre datos reales de Postgres; en
  // modo fixture (demo sin base de datos) la página es de solo lectura.
  // Patrón wiki: `invalidate('cc:recipes')` selectivo y nota veraz unificada.
  const optimistic = new OptimisticActions({ householdId: context.household.id, invalidateToken: 'cc:recipes' });
  const actionStatus = optimistic.status;
  $effect(() => optimistic.start());

  let busy = $state(false);

  async function dispatch(envelope: Parameters<typeof optimistic.run>[0]): Promise<void> {
    busy = true;
    try {
      await optimistic.run(envelope);
    } finally {
      busy = false;
    }
  }

  // ── Escalado en cliente (AC-22): lineal recalcula, fijo queda con nota ─────
  let servings = $state(0);
  $effect(() => {
    servings = recipe?.baseServings ?? 0;
  });

  // ── Edición de ingredientes (familia) vía recipe.set_details ───────────────
  interface IngredientDraft {
    foodId: string;
    quantity: string;
    unit: string;
    scaling: IngredientScaling;
  }
  let editingRecipe = $state(false);
  let draftServings = $state(4);
  let draftMinutes = $state<number | null>(null);
  let draftIngredients = $state<IngredientDraft[]>([]);

  function openRecipeEditor(): void {
    if (!recipe) return;
    editingRecipe = true;
    draftServings = recipe.baseServings;
    draftMinutes = recipe.timeMinutes;
    draftIngredients = recipe.ingredients.map((ingredient) => ({
      foodId: ingredient.foodId,
      quantity: formatQuantityEs(ingredient.quantity),
      unit: ingredient.unit,
      scaling: ingredient.scaling
    }));
    if (draftIngredients.length === 0) addIngredientRow();
  }

  function addIngredientRow(): void {
    draftIngredients = [...draftIngredients, { foodId: '', quantity: '', unit: '', scaling: 'linear' }];
  }

  function removeIngredientRow(index: number): void {
    draftIngredients = draftIngredients.filter((_, candidate) => candidate !== index);
  }

  function foodById(foodId: string) {
    return catalog?.foods.find((food) => food.id === foodId);
  }

  const draftHasUnreviewed = $derived(draftIngredients.some((row) => row.foodId && foodById(row.foodId)?.reviewed === false));

  function submitRecipeDetails(event: SubmitEvent): void {
    event.preventDefault();
    if (!catalog || !recipe) return;
    const ingredients = draftIngredients.filter((row) => row.foodId && row.quantity.trim() && row.unit.trim());
    if (ingredients.length === 0) return;
    void dispatch(
      setRecipeDetails({
        householdId: catalog.householdId,
        pageId: recipe.pageId,
        baseServings: draftServings,
        timeMinutes: draftMinutes ?? undefined,
        ingredients
      })
    ).then(() => {
      editingRecipe = false;
    });
  }

  // ── Catálogo: alta/edición de alimentos con sus 14 alérgenos ───────────────
  let foodId = $state('');
  let foodName = $state('');
  let foodSection = $state('despensa');
  let foodAllergens = $state<string[]>([]);
  let foodReviewed = $state(false);

  function editFood(id: string): void {
    const food = foodById(id);
    if (!food) return;
    foodId = food.id;
    foodName = food.name;
    foodSection = food.section;
    foodAllergens = [...food.allergenCodes];
    foodReviewed = food.reviewed;
  }

  function resetFoodForm(): void {
    foodId = '';
    foodName = '';
    foodSection = 'despensa';
    foodAllergens = [];
    foodReviewed = false;
  }

  function submitFood(event: SubmitEvent): void {
    event.preventDefault();
    if (!catalog || !foodName.trim()) return;
    void dispatch(
      upsertFood({
        householdId: catalog.householdId,
        foodId: foodId || undefined,
        name: foodName,
        shoppingSection: foodSection,
        allergenCodes: foodAllergens,
        reviewed: foodReviewed
      })
    ).then(resetFoodForm);
  }

  // ── Catálogo: comensales con flags de alérgenos ────────────────────────────
  let dinerId = $state('');
  let dinerName = $state('');
  let dinerNotes = $state('');
  let dinerSeverity = $state<Record<string, '' | AllergenSeverity>>({});

  function editDiner(id: string): void {
    const diner = catalog?.diners.find((candidate) => candidate.id === id);
    if (!diner) return;
    dinerId = diner.id;
    dinerName = diner.name;
    dinerNotes = diner.notes;
    dinerSeverity = Object.fromEntries(diner.flags.map((flag) => [flag.allergenCode, flag.severity]));
  }

  function resetDinerForm(): void {
    dinerId = '';
    dinerName = '';
    dinerNotes = '';
    dinerSeverity = {};
  }

  function submitDiner(event: SubmitEvent): void {
    event.preventDefault();
    if (!catalog || !dinerName.trim()) return;
    const flags = Object.entries(dinerSeverity)
      .filter((entry): entry is [string, AllergenSeverity] => entry[1] === 'high' || entry[1] === 'medium')
      .map(([allergenCode, severity]) => ({ allergenCode, severity }));
    void dispatch(
      upsertDiner({
        householdId: catalog.householdId,
        dinerId: dinerId || undefined,
        name: dinerName,
        notes: dinerNotes,
        flags
      })
    ).then(resetDinerForm);
  }

  // Modo fixture (sin base de datos): lectura pura del recetario de demo.
  let selectedId = $state<string>(untrack(() => data.recipes?.recipes[0]?.id ?? ''));
  let fixtureServings = $state(4);
  let selected = $derived(data.recipes ? (data.recipes.recipes.find((entry) => entry.id === selectedId) ?? data.recipes.recipes[0]) : undefined);
</script>

<svelte:head><title>Recetas · Casa Clara</title></svelte:head>

<div class="page-wrap">
  {#if catalog}
    <PageHeader
      eyebrow={`${catalog.recipes.length} recetas del hogar`}
      title="Recetario"
      description="Datos estructurados sobre páginas de la wiki, con alérgenos y escalado exacto."
    />

    <ActionStatus status={actionStatus} />

    <div class="content-grid">
      <section class="card" aria-labelledby="recipes-title">
        <div class="section-heading"><div><p class="eyebrow">Recetas</p><h2 id="recipes-title">Recetas del hogar</h2></div></div>
        <ul class="wiki-recent">
          {#each catalog.recipes as entry (entry.pageId)}
            <li>
              <a href={`${base}?receta=${entry.pageId}`}>
                <strong>{entry.title}</strong>
                <small>
                  {entry.baseServings} raciones{entry.timeMinutes ? ` · ${entry.timeMinutes} min` : ''} · {entry.ingredientCount} ingredientes
                  {#if entry.allergens.length}· {entry.allergens.map((allergen) => allergen.name).join(', ')}{/if}
                </small>
              </a>
              {#if entry.hasUnreviewedFood}<span class="status-chip warning">Alimento sin revisar</span>{/if}
            </li>
          {:else}
            <li><p class="audit-note">Todavía no hay recetas con datos estructurados.</p></li>
          {/each}
        </ul>

        {#if recipe}
          <article class="recipe-detail" aria-labelledby="recipe-title">
            <div class="section-heading">
              <div><p class="eyebrow">Receta seleccionada</p><h2 id="recipe-title">{recipe.title}</h2></div>
              <a href={`/h/${context.household.id}/wiki/${recipe.slug}`}>Ver página wiki →</a>
            </div>
            {#if recipe.allergens.length}
              <p class="queued-note">Alérgenos: {recipe.allergens.map((allergen) => allergen.name).join(', ')}</p>
            {/if}
            <div class="serving-control">
              <span>Raciones</span>
              <button type="button" aria-label="Quitar una ración" onclick={() => (servings = Math.max(1, servings - 1))}>−</button>
              <strong>{servings}</strong>
              <button type="button" aria-label="Añadir una ración" onclick={() => (servings += 1)}>+</button>
            </div>
            <h3>Ingredientes</h3>
            <ul class="ingredient-list">
              {#each recipe.ingredients as ingredient (ingredient.foodId)}
                <li>
                  <span>
                    {ingredient.name}
                    {#if !ingredient.reviewed}<span class="status-chip warning">Sin revisar</span>{/if}
                  </span>
                  <small>
                    {#if ingredient.scaling === 'linear'}
                      {formatQuantityEs(scaleQuantity(ingredient.quantity, servings, recipe.baseServings) ?? ingredient.quantity)} {ingredient.unit}
                    {:else}
                      {formatQuantityEs(ingredient.quantity)} {ingredient.unit} · fija, no escala
                    {/if}
                    {#if ingredient.allergenNames.length}· {ingredient.allergenNames.join(', ')}{/if}
                  </small>
                </li>
              {/each}
            </ul>

            {#if recipe.canWrite}
              {#if !editingRecipe}
                <button class="button secondary full" type="button" disabled={busy} onclick={openRecipeEditor}>Editar ingredientes</button>
              {:else}
                <form class="action-form" onsubmit={submitRecipeDetails}>
                  <label>Raciones base
                    <input type="number" min="1" max="50" bind:value={draftServings} required />
                  </label>
                  <label>Tiempo (minutos)
                    <input type="number" min="1" max="1440" bind:value={draftMinutes} />
                  </label>
                  {#each draftIngredients as row, index (index)}
                    <div class="ingredient-editor-row">
                      <label>Alimento
                        <select bind:value={row.foodId} required>
                          <option value="" disabled>Elige un alimento</option>
                          {#each catalog.foods as food (food.id)}
                            <option value={food.id}>{food.name}{food.reviewed ? '' : ' · sin revisar'}</option>
                          {/each}
                        </select>
                      </label>
                      <label>Cantidad
                        <input type="text" inputmode="decimal" bind:value={row.quantity} placeholder="1,5" required />
                      </label>
                      <label>Unidad
                        <input type="text" bind:value={row.unit} maxlength="30" required />
                      </label>
                      <label>Escalado
                        <select bind:value={row.scaling}>
                          <option value="linear">Lineal</option>
                          <option value="fixed">Fijo (no escala)</option>
                        </select>
                      </label>
                      <button class="button secondary small-button" type="button" onclick={() => removeIngredientRow(index)}>Quitar</button>
                    </div>
                  {/each}
                  <button class="button secondary" type="button" onclick={addIngredientRow}>Añadir ingrediente</button>
                  {#if draftHasUnreviewed}
                    <p class="queued-note" role="alert">
                      Atención: hay algún alimento con alérgenos sin revisar. Mientras no se revise,
                      el menú bloqueará la asignación de esta receta.
                    </p>
                  {/if}
                  <div class="menu-slot-actions">
                    <button class="button primary" type="submit" disabled={busy}>Guardar receta</button>
                    <button class="button secondary" type="button" onclick={() => (editingRecipe = false)}>Cancelar</button>
                  </div>
                </form>
              {/if}
            {/if}
          </article>
        {/if}
      </section>

      <aside class="stack">
        <section class="card" aria-labelledby="foods-title">
          <div class="section-heading"><div><p class="eyebrow">Catálogo</p><h2 id="foods-title">Alimentos y alérgenos</h2></div></div>
          <ul class="wiki-recent">
            {#each catalog.foods as food (food.id)}
              <li>
                <div class="wiki-node-row">
                  <span>
                    <strong>{food.name}</strong>
                    <small>
                      {food.section}
                      {#if food.allergenCodes.length}· {food.allergenCodes.join(', ')}{/if}
                    </small>
                  </span>
                  {#if food.reviewed}
                    <span class="status-chip success">Revisado</span>
                  {:else}
                    <span class="status-chip warning">Sin revisar</span>
                  {/if}
                  {#if catalog.canWrite}
                    <button class="button secondary small-button" type="button" onclick={() => editFood(food.id)}>Editar</button>
                  {/if}
                </div>
              </li>
            {:else}
              <li><p class="audit-note">Todavía no hay alimentos en el catálogo.</p></li>
            {/each}
          </ul>

          {#if catalog.canWrite}
            <form class="action-form" onsubmit={submitFood}>
              <h3>{foodId ? 'Editar alimento' : 'Nuevo alimento'}</h3>
              <label>Nombre
                <input type="text" bind:value={foodName} maxlength="120" required />
              </label>
              <label>Sección de compra
                <input type="text" bind:value={foodSection} maxlength="60" required />
              </label>
              <fieldset class="inline-check-group">
                <legend>Alérgenos de declaración obligatoria (UE)</legend>
                {#each catalog.allergens as allergen (allergen.code)}
                  <label class="inline-check">
                    <input type="checkbox" value={allergen.code} bind:group={foodAllergens} />
                    {allergen.name}
                  </label>
                {/each}
              </fieldset>
              <label class="inline-check">
                <input type="checkbox" bind:checked={foodReviewed} />
                Alérgenos revisados (sin revisar, el menú bloquea sus recetas)
              </label>
              <div class="menu-slot-actions">
                <button class="button primary" type="submit" disabled={busy}>{foodId ? 'Guardar alimento' : 'Crear alimento'}</button>
                {#if foodId}<button class="button secondary" type="button" onclick={resetFoodForm}>Cancelar edición</button>{/if}
              </div>
            </form>
          {/if}
        </section>

        <section class="card" aria-labelledby="diners-title">
          <div class="section-heading"><div><p class="eyebrow">Catálogo</p><h2 id="diners-title">Comensales y restricciones</h2></div></div>
          <ul class="wiki-recent">
            {#each catalog.diners as diner (diner.id)}
              <li>
                <div class="wiki-node-row">
                  <span>
                    <strong>{diner.name}</strong>
                    <small>
                      {#if diner.flags.length}
                        {diner.flags.map((flag) => `${flag.allergenName} (${flag.severity === 'high' ? 'alta' : 'media'})`).join(', ')}
                      {:else}
                        Sin restricciones
                      {/if}
                    </small>
                  </span>
                  {#if catalog.canWrite}
                    <button class="button secondary small-button" type="button" onclick={() => editDiner(diner.id)}>Editar</button>
                  {/if}
                </div>
              </li>
            {:else}
              <li><p class="audit-note">Todavía no hay comensales.</p></li>
            {/each}
          </ul>

          {#if catalog.canWrite}
            <form class="action-form" onsubmit={submitDiner}>
              <h3>{dinerId ? 'Editar comensal' : 'Nuevo comensal'}</h3>
              <label>Nombre
                <input type="text" bind:value={dinerName} maxlength="120" required />
              </label>
              <label>Notas
                <input type="text" bind:value={dinerNotes} maxlength="500" />
              </label>
              <fieldset class="inline-check-group">
                <legend>Restricciones por alérgeno</legend>
                {#each catalog.allergens as allergen (allergen.code)}
                  <label class="inline-check">
                    {allergen.name}
                    <select bind:value={dinerSeverity[allergen.code]}>
                      <option value="">Sin restricción</option>
                      <option value="medium">Media</option>
                      <option value="high">Alta</option>
                    </select>
                  </label>
                {/each}
              </fieldset>
              <div class="menu-slot-actions">
                <button class="button primary" type="submit" disabled={busy}>{dinerId ? 'Guardar comensal' : 'Crear comensal'}</button>
                {#if dinerId}<button class="button secondary" type="button" onclick={resetDinerForm}>Cancelar edición</button>{/if}
              </div>
            </form>
          {/if}
        </section>
      </aside>
    </div>
  {:else if data.recipes}
    <PageHeader eyebrow={`${data.recipes.recipes.length} recetas probadas`} title="Recetario" description="Cantidades fáciles de adaptar y advertencias a la vista." />

    <div class="recipe-layout">
      <div class="recipe-gallery">
        {#each data.recipes.recipes as fixtureRecipe}
          <button type="button" class="recipe-card" class:active={fixtureRecipe.id === selectedId} onclick={() => { selectedId = fixtureRecipe.id; fixtureServings = fixtureRecipe.servings; }}>
            <span class={`recipe-visual ${fixtureRecipe.tone}`} aria-hidden="true"><i>◇</i></span>
            <span class="recipe-copy"><small>{fixtureRecipe.time} · {fixtureRecipe.servings} raciones</small><strong>{fixtureRecipe.title}</strong><span>{fixtureRecipe.tags.join(' · ')}</span></span>
          </button>
        {/each}
      </div>

      {#if selected}
        <article class="card recipe-detail">
          <p class="eyebrow">Receta seleccionada</p><h2>{selected.title}</h2>
          <div class="serving-control"><span>Raciones</span><button type="button" aria-label="Quitar una ración" onclick={() => fixtureServings = Math.max(1, fixtureServings - 1)}>−</button><strong>{fixtureServings}</strong><button type="button" aria-label="Añadir una ración" onclick={() => fixtureServings += 1}>+</button></div>
          <h3>Ingredientes</h3>
          <ul class="ingredient-list">
            {#each selected.ingredients as ingredient}<li><span>{ingredient}</span><small>× {(fixtureServings / selected.servings).toLocaleString('es-ES', { maximumFractionDigits: 2 })}</small></li>{/each}
          </ul>
          {#if context.capabilities.includes('content.write')}<button class="button secondary full" type="button">Editar receta</button>{/if}
        </article>
      {/if}
    </div>
  {/if}
</div>
