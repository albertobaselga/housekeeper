<script lang="ts">
  import { untrack } from 'svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import ActionStatus from '$lib/components/ActionStatus.svelte';
  import { useAppContext } from '$lib/auth/context';
  import { OptimisticActions } from '$lib/offline/optimistic';
  import { formatQuantityEs, scaleQuantity } from '$lib/food/quantities';
  import {
    setFoodArchived,
    setRecipeArchived,
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
  /** Tamaño del paquete con el que se compra («500» + «g»); opcional. */
  let foodPackageSize = $state('');
  let foodPackageUnit = $state('');

  function editFood(id: string): void {
    const food = foodById(id);
    if (!food) return;
    foodId = food.id;
    foodName = food.name;
    foodSection = food.section;
    foodAllergens = [...food.allergenCodes];
    foodReviewed = food.reviewed;
    foodPackageSize = food.packaging ? formatQuantityEs(food.packaging.size) : '';
    foodPackageUnit = food.packaging?.unit ?? '';
  }

  function resetFoodForm(): void {
    foodId = '';
    foodName = '';
    foodSection = 'despensa';
    foodAllergens = [];
    foodReviewed = false;
    foodPackageSize = '';
    foodPackageUnit = '';
  }

  function submitFood(event: SubmitEvent): void {
    event.preventDefault();
    if (!catalog || !foodName.trim()) return;
    // Media medida no sirve: o se fijan cantidad y unidad, o no hay paquete.
    const packaging =
      foodPackageSize.trim() && foodPackageUnit.trim()
        ? { size: foodPackageSize, unit: foodPackageUnit }
        : undefined;
    void dispatch(
      upsertFood({
        householdId: catalog.householdId,
        foodId: foodId || undefined,
        name: foodName,
        shoppingSection: foodSection,
        allergenCodes: foodAllergens,
        reviewed: foodReviewed,
        packaging
      })
    ).then(resetFoodForm);
  }

  // ── Archivado discreto (familia) ──────────────────────────────────────────
  // Nada se borra: archivar retira de la lista y siempre se puede recuperar
  // desde «Archivados». Confirmación ligera: el primer tap arma, el segundo
  // archiva (mismo patrón que el borrado de plantillas del menú).
  let archiveArmedId = $state<string | null>(null);

  function archiveFood(id: string, archived: boolean): void {
    if (!catalog) return;
    archiveArmedId = null;
    if (foodId === id) resetFoodForm();
    void dispatch(setFoodArchived({ householdId: catalog.householdId, foodId: id, archived }));
  }

  function archiveRecipe(pageId: string, archived: boolean): void {
    if (!catalog) return;
    archiveArmedId = null;
    void dispatch(setRecipeArchived({ householdId: catalog.householdId, pageId, archived }));
  }

  // ── Catálogo: comensales con flags de alérgenos ────────────────────────────
  // P1-7 · alta progresiva: primero SOLO el nombre. Las restricciones viven
  // detrás de «¿Tiene alergias o restricciones?» y la matriz de 14 alérgenos
  // solo aparece si alguien la abre. Editar a quien ya tiene restricciones la
  // abre sola, para que no queden escondidas.
  let dinerId = $state('');
  let dinerName = $state('');
  let dinerNotes = $state('');
  let dinerSeverity = $state<Record<string, '' | AllergenSeverity>>({});
  /** Nota por alérgeno del comensal («solo trazas», «lleva epinefrina»…). */
  let dinerFlagNotes = $state<Record<string, string>>({});
  let dinerAllergensOpen = $state(false);

  const dinerFlagCount = $derived(
    Object.values(dinerSeverity).filter((severity) => severity === 'high' || severity === 'medium').length
  );

  function editDiner(id: string): void {
    const diner = catalog?.diners.find((candidate) => candidate.id === id);
    if (!diner) return;
    dinerId = diner.id;
    dinerName = diner.name;
    dinerNotes = diner.notes;
    dinerSeverity = Object.fromEntries(diner.flags.map((flag) => [flag.allergenCode, flag.severity]));
    dinerFlagNotes = Object.fromEntries(diner.flags.map((flag) => [flag.allergenCode, flag.note]));
    dinerAllergensOpen = diner.flags.length > 0 || diner.notes.trim().length > 0;
  }

  function resetDinerForm(): void {
    dinerId = '';
    dinerName = '';
    dinerNotes = '';
    dinerSeverity = {};
    dinerFlagNotes = {};
    dinerAllergensOpen = false;
  }

  function submitDiner(event: SubmitEvent): void {
    event.preventDefault();
    if (!catalog || !dinerName.trim()) return;
    const flags = Object.entries(dinerSeverity)
      .filter((entry): entry is [string, AllergenSeverity] => entry[1] === 'high' || entry[1] === 'medium')
      .map(([allergenCode, severity]) => ({
        allergenCode,
        severity,
        note: dinerFlagNotes[allergenCode] ?? ''
      }));
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

<div class="page-wrap">
  {#if catalog}
    <PageHeader
      eyebrow={`${catalog.recipes.length} recetas del hogar`}
      title="Recetario"
      description="Fichas de receta guardadas en la guía de la casa, con alérgenos y raciones exactas."
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
              {#if catalog.canWrite}
                {#if archiveArmedId === `recipe:${entry.pageId}`}
                  <button class="button secondary small-button" type="button" disabled={busy} onclick={() => archiveRecipe(entry.pageId, true)}>
                    Sí, archivar «{entry.title}»
                  </button>
                  <button class="button secondary small-button" type="button" onclick={() => (archiveArmedId = null)}>Cancelar</button>
                {:else}
                  <button class="archive-link" type="button" onclick={() => (archiveArmedId = `recipe:${entry.pageId}`)}>Archivar</button>
                {/if}
              {/if}
            </li>
          {:else}
            <li><p class="audit-note">Aún no hay recetas. <a href={`/h/${context.household.id}/wiki`}>Escribe la primera en la guía de la casa →</a></p></li>
          {/each}
        </ul>

        {#if catalog.archivedRecipes.length}
          <details class="archived-block">
            <summary>Recetas archivadas ({catalog.archivedRecipes.length})</summary>
            <p class="audit-note">La nota de la guía sigue donde estaba; solo se retiró la ficha del recetario.</p>
            <ul class="wiki-recent">
              {#each catalog.archivedRecipes as entry (entry.pageId)}
                <li>
                  <div class="wiki-node-row">
                    <span><strong>{entry.title}</strong></span>
                    {#if catalog.canWrite}
                      <button class="button secondary small-button" type="button" disabled={busy} onclick={() => archiveRecipe(entry.pageId, false)}>
                        Recuperar
                      </button>
                    {/if}
                  </div>
                </li>
              {/each}
            </ul>
          </details>
        {/if}

        {#if recipe}
          <article class="recipe-detail" aria-labelledby="recipe-title">
            <div class="section-heading">
              <div><p class="eyebrow">Receta seleccionada</p><h2 id="recipe-title">{recipe.title}</h2></div>
              <a href={`/h/${context.household.id}/wiki/${recipe.slug}`}>Ver la nota en la guía →</a>
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
                    <input type="number" inputmode="numeric" enterkeyhint="next" min="1" max="50" bind:value={draftServings} required />
                  </label>
                  <label>Tiempo (minutos)
                    <input type="number" inputmode="numeric" enterkeyhint="next" min="1" max="1440" bind:value={draftMinutes} />
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
                        <input type="text" inputmode="decimal" autocomplete="off" enterkeyhint="next" bind:value={row.quantity} placeholder="1,5" required />
                      </label>
                      <label>Unidad
                        <input type="text" autocomplete="off" enterkeyhint="done" bind:value={row.unit} maxlength="30" required />
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
                      {#if food.packaging}· se compra de {formatQuantityEs(food.packaging.size)} {food.packaging.unit}{/if}
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
                    {#if archiveArmedId === `food:${food.id}`}
                      <button class="button secondary small-button" type="button" disabled={busy} onclick={() => archiveFood(food.id, true)}>
                        Sí, archivar «{food.name}»
                      </button>
                      <button class="button secondary small-button" type="button" onclick={() => (archiveArmedId = null)}>Cancelar</button>
                    {:else}
                      <button class="archive-link" type="button" onclick={() => (archiveArmedId = `food:${food.id}`)}>Archivar</button>
                    {/if}
                  {/if}
                </div>
              </li>
            {:else}
              <li><p class="audit-note">Todavía no hay alimentos en el catálogo.</p></li>
            {/each}
          </ul>

          {#if catalog.archivedFoods.length}
            <details class="archived-block">
              <summary>Alimentos archivados ({catalog.archivedFoods.length})</summary>
              <p class="audit-note">Las recetas que ya lo usaban lo siguen pidiendo en la compra; solo deja de ofrecerse para lo nuevo.</p>
              <ul class="wiki-recent">
                {#each catalog.archivedFoods as food (food.id)}
                  <li>
                    <div class="wiki-node-row">
                      <span><strong>{food.name}</strong></span>
                      {#if catalog.canWrite}
                        <button class="button secondary small-button" type="button" disabled={busy} onclick={() => archiveFood(food.id, false)}>
                          Recuperar
                        </button>
                      {/if}
                    </div>
                  </li>
                {/each}
              </ul>
            </details>
          {/if}

          {#if catalog.canWrite}
            <form class="action-form" onsubmit={submitFood}>
              <h3>{foodId ? 'Editar alimento' : 'Nuevo alimento'}</h3>
              <label>Nombre
                <input type="text" autocomplete="off" enterkeyhint="next" bind:value={foodName} maxlength="120" required />
              </label>
              <label>Sección de compra
                <input type="text" autocomplete="off" enterkeyhint="next" bind:value={foodSection} maxlength="60" required />
              </label>
              <!-- P2-4: con el tamaño del paquete, la compra dice cuántos hay
                   que llevar («350 g → 1 paquete de 500 g»). Sin él, la lista
                   muestra la cantidad exacta y no se inventa nada. -->
              <label>¿En qué tamaño se compra? (opcional)
                <input
                  type="text"
                  inputmode="decimal"
                  autocomplete="off"
                  enterkeyhint="next"
                  bind:value={foodPackageSize}
                  placeholder="500"
                />
              </label>
              <label>Unidad del paquete
                <input
                  type="text"
                  autocomplete="off"
                  enterkeyhint="done"
                  bind:value={foodPackageUnit}
                  maxlength="30"
                  placeholder="g"
                />
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
                        {diner.flags
                          .map(
                            (flag) =>
                              `${flag.allergenName} (${flag.severity === 'high' ? 'no puede tomarlo' : 'mejor evitarlo'})` +
                              (flag.note.trim() ? ` — ${flag.note.trim()}` : '')
                          )
                          .join(', ')}
                      {:else}
                        Sin restricciones
                      {/if}
                      {#if diner.notes.trim()}· {diner.notes.trim()}{/if}
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
              <h3>{dinerId ? 'Editar comensal' : 'Apuntar quién come en casa'}</h3>
              <label>Nombre
                <input
                  type="text"
                  autocomplete="off"
                  enterkeyhint="done"
                  bind:value={dinerName}
                  maxlength="120"
                  required
                  placeholder="Leo"
                />
              </label>
              <!-- P1-7: el alta normal es solo el nombre. La matriz de 14
                   alérgenos es una decisión demasiado grande para «apuntar que
                   Leo no toma leche», así que solo aparece si se abre. -->
              <!-- `open` de una sola dirección + `ontoggle` en vez de
                   `bind:open`: el binding genérico de propiedad de Svelte es
                   runtime compartido y entraba en el bundle inicial de Hoy
                   (presupuesto ≤ 120 kB) para una pantalla que Hoy no abre. -->
              <details
                class="diner-allergens"
                open={dinerAllergensOpen}
                ontoggle={(event) => (dinerAllergensOpen = event.currentTarget.open)}
              >
                <summary>
                  ¿Tiene alergias o restricciones?
                  {#if dinerFlagCount > 0}
                    <span class="status-chip warning">{dinerFlagCount} {dinerFlagCount === 1 ? 'apuntada' : 'apuntadas'}</span>
                  {:else}
                    <small>Opcional. Si no las tiene, no hace falta abrir esto.</small>
                  {/if}
                </summary>
                <fieldset class="inline-check-group">
                  <legend>Qué evita y con cuánta gravedad</legend>
                  {#each catalog.allergens as allergen (allergen.code)}
                    <div class="diner-allergen-row">
                      <label class="inline-check">
                        {allergen.name}
                        <select bind:value={dinerSeverity[allergen.code]}>
                          <option value="">No la evita</option>
                          <option value="medium">Mejor evitarlo</option>
                          <option value="high">No puede tomarlo</option>
                        </select>
                      </label>
                      {#if dinerSeverity[allergen.code] === 'high' || dinerSeverity[allergen.code] === 'medium'}
                        <label class="diner-allergen-note">
                          Nota sobre {allergen.name.toLocaleLowerCase('es')}
                          <input
                            type="text"
                            autocomplete="off"
                            enterkeyhint="next"
                            bind:value={dinerFlagNotes[allergen.code]}
                            maxlength="200"
                            placeholder="Solo las trazas le sientan mal"
                          />
                        </label>
                      {/if}
                    </div>
                  {/each}
                </fieldset>
                <label>Otra cosa que convenga saber
                  <input type="text" autocomplete="off" enterkeyhint="done" bind:value={dinerNotes} maxlength="500" />
                </label>
              </details>
              <div class="menu-slot-actions">
                <button class="button primary" type="submit" disabled={busy}>{dinerId ? 'Guardar comensal' : 'Apuntar comensal'}</button>
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

<style>
  /* Alta progresiva de comensal (P1-7): el desplegable es una decisión, no un
     bloque de formulario más. Cerrado ocupa una línea; abierto, la matriz. */
  .diner-allergens {
    border: 1px solid var(--line);
    border-radius: var(--r-md);
    padding: var(--space-2) var(--space-3);
    background: var(--surface);
  }
  .diner-allergens > summary {
    cursor: pointer;
    font-weight: 700;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
  }
  .diner-allergens > summary small {
    font-weight: 400;
    color: var(--ink-soft);
  }
  .diner-allergen-row {
    display: grid;
    gap: var(--space-1);
  }
  .diner-allergen-note {
    padding-left: var(--space-4);
    font-size: var(--text-meta);
    color: var(--ink-soft);
  }

  /* Archivar es una acción discreta: un enlace pequeño, no un botón que
     compita con «Editar». Lo archivado vive en una lista plegada. */
  .archive-link {
    min-height: 2.75rem;
    border: 0;
    background: none;
    padding: var(--space-1) 0;
    color: var(--ink-soft);
    font-size: var(--text-micro);
    text-decoration: underline;
    cursor: pointer;
  }
  .archived-block {
    margin-top: var(--space-3);
  }
  .archived-block > summary {
    cursor: pointer;
    color: var(--ink-soft);
    font-size: var(--text-meta);
  }
</style>
