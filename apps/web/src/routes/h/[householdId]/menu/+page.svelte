<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import { useAppContext } from '$lib/auth/context';
  import { activeMenuDayIndex, addDays, dayLabel, weekLabel } from '$lib/food/dates';
  import { formatQuantityEs } from '$lib/food/quantities';
  import {
    addShoppingItem,
    clearMenuSlot,
    confirmMenuSlot,
    duplicateMenuWeek,
    queueFoodCommand,
    setMenuSlot,
    setShoppingChecked,
    upsertMenuGroup,
    type MealSlot
  } from '$lib/food/commands';
  import { queueCommand } from '$lib/offline/queue-command';
  import type { MenuSlotView } from '$lib/server/food.server';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const context = useAppContext();
  const canWriteFixture = context.capabilities.includes('menu.write');

  const week = $derived(data.week);
  const shopping = $derived(data.shopping);
  const base = $derived(`/h/${context.household.id}/menu`);

  const MEALS: readonly MealSlot[] = ['desayuno', 'almuerzo', 'comida', 'merienda', 'cena'];
  const MEAL_LABEL: Record<MealSlot, string> = {
    desayuno: 'Desayuno',
    almuerzo: 'Almuerzo',
    comida: 'Comida',
    merienda: 'Merienda',
    cena: 'Cena'
  };

  // Las acciones de escritura solo existen sobre datos reales de Postgres; en
  // modo fixture (demo sin base de datos) la página es de solo lectura.
  let queued = $state(false);
  let busy = $state(false);
  let tab = $state<'menu' | 'compra'>('menu');

  // Día activo: por defecto hoy (si cae en la semana visible); la navegación
  // de semanas arrastra el día seleccionado vía `?day=` y el click en una
  // pestaña lo fija localmente para la semana en pantalla.
  let dayOverride = $state<string | null>(null);
  const selectedDay = $derived.by(() => {
    if (!week) return 0;
    if (dayOverride) {
      const index = week.days.indexOf(dayOverride);
      if (index >= 0) return index;
    }
    return activeMenuDayIndex(week.days, data.day, data.today);
  });
  const selectedDate = $derived(week ? week.days[selectedDay]! : null);

  async function dispatch(
    envelope: Parameters<typeof queueFoodCommand>[0]
  ): Promise<Awaited<ReturnType<typeof queueFoodCommand>>> {
    busy = true;
    try {
      const outcome = await queueFoodCommand(envelope);
      if (outcome === 'synced') await invalidateAll();
      else queued = true;
      return outcome;
    } finally {
      busy = false;
    }
  }

  const slotByKey = $derived(new Map((week?.slots ?? []).map((slot) => [`${slot.groupId}:${slot.onDate}:${slot.meal}`, slot])));

  function slotFor(groupId: string, onDate: string, meal: MealSlot): MenuSlotView | undefined {
    return slotByKey.get(`${groupId}:${onDate}:${meal}`);
  }

  // ── Editor de hueco (asignar receta o texto) ───────────────────────────────
  let editorKey = $state<string | null>(null);
  let editorMode = $state<'recipe' | 'text'>('recipe');
  let editorRecipeId = $state('');
  let editorText = $state('');
  let editorNotes = $state('');
  let editorServings = $state<number | null>(null);
  let editorAcknowledge = $state(false);

  function openEditor(groupId: string, onDate: string, meal: MealSlot): void {
    const slot = slotFor(groupId, onDate, meal);
    editorKey = `${groupId}:${onDate}:${meal}`;
    editorMode = slot && !slot.recipe && slot.freeText ? 'text' : 'recipe';
    editorRecipeId = slot?.recipe?.pageId ?? '';
    editorText = slot?.freeText ?? '';
    editorNotes = slot?.notes ?? '';
    editorServings = slot?.servingsOverride ?? null;
    editorAcknowledge = false;
  }

  const editorParts = $derived(editorKey ? editorKey.split(':') : null);
  const editorGroup = $derived(editorParts ? week?.groups.find((group) => group.id === editorParts[0]) : undefined);
  const editorRecipe = $derived(week?.recipeOptions.find((option) => option.pageId === editorRecipeId));
  /** Alérgenos de la receta elegida que chocan con los flags del grupo (AC-21). */
  const editorConflicts = $derived.by(() => {
    if (editorMode !== 'recipe' || !editorRecipe || !editorGroup) return [];
    const flagged = new Map<string, string[]>();
    for (const diner of editorGroup.diners) {
      for (const flag of diner.flags) {
        const names = flagged.get(flag.allergenCode) ?? [];
        names.push(diner.name);
        flagged.set(flag.allergenCode, names);
      }
    }
    return editorRecipe.allergens
      .filter((allergen) => flagged.has(allergen.code))
      .map((allergen) => ({ ...allergen, diners: flagged.get(allergen.code)! }));
  });

  function submitEditor(event: SubmitEvent): void {
    event.preventDefault();
    if (!week || !editorParts) return;
    if (editorMode === 'recipe' && !editorRecipeId) return;
    if (editorMode === 'text' && !editorText.trim()) return;
    if (editorConflicts.length > 0 && !editorAcknowledge) return;
    const servings = editorServings;
    void dispatch(
      setMenuSlot({
        householdId: week.householdId,
        groupId: editorParts[0]!,
        onDate: editorParts[1]!,
        meal: editorParts[2] as MealSlot,
        recipePageId: editorMode === 'recipe' ? editorRecipeId : undefined,
        freeText: editorMode === 'text' ? editorText : undefined,
        notes: editorNotes,
        servingsOverride: servings !== null && Number.isInteger(servings) && servings > 0 ? servings : undefined,
        acknowledgeAllergens: editorConflicts.length > 0 ? editorAcknowledge : undefined
      })
    ).then(() => {
      editorKey = null;
    });
  }

  function confirmSlot(slot: MenuSlotView): void {
    if (!week) return;
    void dispatch(confirmMenuSlot({ householdId: week.householdId, slotId: slot.id, contentHash: slot.contentHash }));
  }

  function clearSlot(slot: MenuSlotView): void {
    if (!week) return;
    void dispatch(clearMenuSlot({ householdId: week.householdId, slotId: slot.id }));
  }

  // Confirmación visible del duplicado: qué semana se copió y adónde, con
  // enlace directo para comprobarlo sin navegar a ciegas. La semana destino es
  // elegible (P3 week_overlap): por defecto la siguiente; una fecha a menos de
  // 7 días produce el rechazo real del servidor y su mensaje veraz.
  let duplicated = $state<{ from: string; to: string; day: string } | null>(null);
  let duplicateTarget = $state('');
  let duplicateError = $state<string | null>(null);
  const duplicateDefault = $derived(week ? addDays(week.weekStartsOn, 7) : '');

  async function duplicateWeek(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!week) return;
    const from = week.weekStartsOn;
    const to = duplicateTarget || duplicateDefault;
    const dayDiff = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
    const day = addDays(selectedDate ?? from, dayDiff);
    duplicated = null;
    duplicateError = null;
    busy = true;
    try {
      const result = await queueCommand(
        duplicateMenuWeek({ householdId: week.householdId, fromWeekStartsOn: from, toWeekStartsOn: to })
      );
      if (result.outcome === 'synced') {
        await invalidateAll();
        duplicated = { from, to, day };
      } else if (result.outcome === 'queued') {
        queued = true;
      } else {
        // Rechazo/conflicto real del servidor (p. ej. week_overlap), sin
        // prometer reenvío: mensaje traducido del diccionario compartido.
        duplicateError = result.message;
      }
    } finally {
      busy = false;
    }
  }

  $effect(() => {
    // El aviso de copia pertenece a la semana de origen: al navegar, fuera.
    if (duplicated && week && week.weekStartsOn !== duplicated.from) duplicated = null;
    if (week) {
      duplicateTarget = addDays(week.weekStartsOn, 7);
      duplicateError = null;
    }
  });

  // ── Nuevo grupo de comensales ──────────────────────────────────────────────
  let newGroupName = $state('');
  let newGroupDiners = $state<string[]>([]);

  function submitNewGroup(event: SubmitEvent): void {
    event.preventDefault();
    if (!week || !newGroupName.trim()) return;
    void dispatch(
      upsertMenuGroup({ householdId: week.householdId, name: newGroupName, dinerIds: newGroupDiners })
    ).then(() => {
      newGroupName = '';
      newGroupDiners = [];
    });
  }

  // ── Lista de la compra (AC-24) ─────────────────────────────────────────────
  let itemFoodId = $state('');
  let itemName = $state('');
  let itemQuantity = $state('');
  let itemUnit = $state('');
  let itemSection = $state('');

  function submitShoppingItem(event: SubmitEvent): void {
    event.preventDefault();
    if (!shopping) return;
    if (!itemFoodId && !itemName.trim()) return;
    const food = shopping.foods.find((candidate) => candidate.id === itemFoodId);
    void dispatch(
      addShoppingItem({
        householdId: shopping.householdId,
        foodId: itemFoodId || undefined,
        customName: itemFoodId ? undefined : itemName,
        quantity: itemQuantity,
        unit: itemUnit,
        section: itemSection || food?.section,
        weekStartsOn: shopping.weekStartsOn
      })
    ).then(() => {
      itemFoodId = '';
      itemName = '';
      itemQuantity = '';
      itemUnit = '';
      itemSection = '';
    });
  }

  function toggleChecked(itemId: string, checked: boolean): void {
    if (!shopping) return;
    void dispatch(setShoppingChecked({ householdId: shopping.householdId, itemId, checked: !checked }));
  }

  // Modo fixture (sin base de datos): lectura pura del menú de demostración.
  let selected = $state(4);
</script>

<svelte:head><title>Menú · Casa Clara</title></svelte:head>

<div class="page-wrap">
  {#if week}
    {#snippet weekActions()}
      {#if week.canWrite}
        <form class="duplicate-week-form" onsubmit={duplicateWeek}>
          <label>Copiar esta semana al lunes
            <input type="date" bind:value={duplicateTarget} required enterkeyhint="done" />
          </label>
          <button class="button secondary" type="submit" disabled={busy}>
            {duplicateTarget === duplicateDefault ? 'Duplicar en la semana siguiente' : 'Duplicar en esa semana'}
          </button>
        </form>
      {/if}
    {/snippet}
    <PageHeader
      eyebrow={`Semana del ${weekLabel(week.weekStartsOn)}`}
      title="Menú de la casa"
      description="Cinco franjas por grupo de comensales, con las restricciones a la vista."
      actions={weekActions}
    />

    {#if queued}<p class="success-message" role="status">Cambio guardado en la outbox local, pendiente de sincronizar.</p>{/if}
    {#if duplicated}
      <p class="success-message" role="status">
        Semana del {weekLabel(duplicated.from)} copiada a la del {weekLabel(duplicated.to)}.
        <a href={`${base}?week=${duplicated.to}&day=${duplicated.day}`}>Ver la semana del {weekLabel(duplicated.to)} →</a>
      </p>
    {/if}
    {#if duplicateError}
      <p class="form-error" role="alert">{duplicateError}</p>
    {/if}

    <nav class="week-nav" aria-label="Cambiar de semana">
      <a class="button secondary" href={`${base}?week=${addDays(week.weekStartsOn, -7)}&day=${addDays(selectedDate ?? week.weekStartsOn, -7)}`}>← Semana anterior</a>
      <a class="button secondary" href={`${base}?week=${addDays(week.weekStartsOn, 7)}&day=${addDays(selectedDate ?? week.weekStartsOn, 7)}`}>Semana siguiente →</a>
    </nav>

    <div class="space-tabs" role="list" aria-label="Secciones del menú">
      <button type="button" class:active={tab === 'menu'} onclick={() => (tab = 'menu')}>Menú semanal</button>
      <button type="button" class:active={tab === 'compra'} onclick={() => (tab = 'compra')}>Lista de la compra</button>
      <a class="tab-link" href={`/h/${context.household.id}/recipes`}>Recetas</a>
    </div>

    {#if tab === 'menu'}
      <div class="day-tabs" role="tablist" aria-label="Días de la semana">
        {#each week.days as day, index (day)}
          {@const label = dayLabel(day)}
          <button type="button" role="tab" aria-selected={selectedDay === index} class:active={selectedDay === index} onclick={() => (dayOverride = day)}>
            <span>{label.day}</span><strong>{label.date}</strong>
          </button>
        {/each}
      </div>

      {#each week.groups as group (group.id)}
        {@const day = week.days[selectedDay]!}
        <section class="card menu-group-card" aria-label={`Grupo ${group.name}`}>
          <div class="section-heading">
            <div>
              <p class="eyebrow">Grupo de comensales</p>
              <h2>{group.name}</h2>
            </div>
            <p class="audit-note">
              {#each group.diners as diner, index (diner.id)}{index > 0 ? ', ' : ''}{diner.name}{#if diner.flags.length}
                <span class="status-chip warning">{diner.flags.map((flag) => flag.allergenName).join(', ')}</span>
              {/if}{:else}Sin comensales asignados{/each}
            </p>
          </div>

          {#each MEALS as meal (meal)}
            {@const slot = slotFor(group.id, day, meal)}
            <div class="menu-slot-row">
              <div class="menu-slot-copy">
                <small>{MEAL_LABEL[meal]}</small>
                {#if slot?.recipe}
                  <strong><a href={`/h/${context.household.id}/recipes?receta=${slot.recipe.pageId}`}>{slot.recipe.title}</a></strong>
                  <small>{slot.servingsOverride ?? (group.diners.length > 0 ? group.diners.length : slot.recipe.baseServings)} raciones · base {slot.recipe.baseServings}</small>
                {:else if slot}
                  <strong>{slot.freeText}</strong>
                {:else}
                  <span class="audit-note">Sin plan</span>
                {/if}
                {#if slot?.notes}<small class="menu-slot-note">{slot.notes}</small>{/if}
                {#if slot && slot.conflicts.length}
                  <p class="queued-note" role="alert">
                    Incompatibilidad de alérgenos:
                    {slot.conflicts.map((conflict) => `${conflict.allergenName} (${conflict.dinerName})`).join(', ')}
                  </p>
                {/if}
                {#if slot?.confirmation?.upToDate}
                  <span class="status-chip success">Confirmado</span>
                {:else if slot?.confirmation}
                  <span class="status-chip warning">Confirmación caducada: el contenido cambió</span>
                {/if}
              </div>
              {#if week.canWrite}
                <div class="menu-slot-actions">
                  {#if slot && !slot.confirmation?.upToDate}
                    <button class="button secondary small-button" type="button" disabled={busy} onclick={() => confirmSlot(slot)}>Confirmar</button>
                  {/if}
                  <button class="button secondary small-button" type="button" disabled={busy} onclick={() => openEditor(group.id, day, meal)}>
                    {slot ? 'Cambiar' : 'Asignar'}
                  </button>
                  {#if slot}
                    <button class="button secondary small-button" type="button" disabled={busy} onclick={() => clearSlot(slot)}>Vaciar</button>
                  {/if}
                </div>
              {/if}
            </div>

            {#if editorKey === `${group.id}:${day}:${meal}`}
              <form class="action-form menu-slot-editor" onsubmit={submitEditor}>
                <div class="space-tabs" role="list" aria-label="Tipo de plan">
                  <button type="button" class:active={editorMode === 'recipe'} onclick={() => (editorMode = 'recipe')}>Receta</button>
                  <button type="button" class:active={editorMode === 'text'} onclick={() => (editorMode = 'text')}>Texto libre</button>
                </div>
                {#if editorMode === 'recipe'}
                  <label>Receta del hogar
                    <select bind:value={editorRecipeId} required>
                      <option value="" disabled>Elige una receta</option>
                      {#each week.recipeOptions as option (option.pageId)}
                        <option value={option.pageId}>
                          {option.title}{option.allergens.length ? ` · ${option.allergens.map((a) => a.name).join(', ')}` : ''}
                        </option>
                      {/each}
                    </select>
                  </label>
                  {#if editorRecipe?.hasUnreviewedFood}
                    <p class="queued-note" role="alert">Esta receta usa algún alimento con alérgenos sin revisar.</p>
                  {/if}
                {:else}
                  <label>Plan en texto libre
                    <input type="text" autocomplete="off" enterkeyhint="next" bind:value={editorText} maxlength="300" required />
                  </label>
                {/if}
                <label>Notas
                  <input type="text" autocomplete="off" enterkeyhint="next" bind:value={editorNotes} maxlength="500" />
                </label>
                <label>Raciones (vacío = comensales del grupo)
                  <input type="number" inputmode="numeric" enterkeyhint="done" min="1" max="50" bind:value={editorServings} />
                </label>
                {#if editorConflicts.length > 0}
                  <div class="allergen-block" role="alert">
                    <strong>Bloqueado por incompatibilidad de alérgenos</strong>
                    <ul>
                      {#each editorConflicts as conflict (conflict.code)}
                        <li>{conflict.name} — afecta a {conflict.diners.join(', ')}</li>
                      {/each}
                    </ul>
                    <label class="inline-check">
                      <input type="checkbox" bind:checked={editorAcknowledge} />
                      Sé que hay una incompatibilidad y asumo la decisión
                    </label>
                  </div>
                {/if}
                <div class="menu-slot-actions">
                  <button class="button primary" type="submit" disabled={busy || (editorConflicts.length > 0 && !editorAcknowledge)}>
                    Guardar hueco
                  </button>
                  <button class="button secondary" type="button" onclick={() => (editorKey = null)}>Cancelar</button>
                </div>
              </form>
            {/if}
          {/each}
        </section>
      {:else}
        <section class="card">
          <p class="audit-note">Todavía no hay grupos de comensales en este hogar.</p>
        </section>
      {/each}

      {#if week.canWrite}
        <section class="card" aria-labelledby="new-group-title">
          <div class="section-heading"><div><p class="eyebrow">Organizar</p><h2 id="new-group-title">Nuevo grupo de comensales</h2></div></div>
          <form class="action-form" onsubmit={submitNewGroup}>
            <label>Nombre
              <input type="text" autocomplete="off" enterkeyhint="done" bind:value={newGroupName} maxlength="120" required />
            </label>
            {#if week.diners.length}
              <fieldset class="inline-check-group">
                <legend>Comensales</legend>
                {#each week.diners as diner (diner.id)}
                  <label class="inline-check">
                    <input type="checkbox" value={diner.id} bind:group={newGroupDiners} />
                    {diner.name}{#if diner.flags.length}&nbsp;· {diner.flags.map((flag) => flag.allergenName).join(', ')}{/if}
                  </label>
                {/each}
              </fieldset>
            {/if}
            <button class="button secondary" type="submit" disabled={busy}>Crear grupo</button>
          </form>
        </section>
      {/if}
    {:else if shopping}
      <section class="card" aria-labelledby="shopping-title">
        <div class="section-heading">
          <div><p class="eyebrow">Semana del {weekLabel(shopping.weekStartsOn)}</p><h2 id="shopping-title">Lista de la compra</h2></div>
        </div>
        {#each shopping.sections as section (section.section)}
          <h3 class="shopping-section-title">{section.section}</h3>
          <ul class="ingredient-list">
            {#each section.entries as entry (entry.itemId ?? `${entry.foodId}:${entry.unit}`)}
              <li class:checked={entry.checked}>
                {#if entry.kind === 'manual' && shopping.canWrite}
                  <label class="inline-check">
                    <input type="checkbox" checked={entry.checked} disabled={busy} onchange={() => toggleChecked(entry.itemId!, entry.checked)} />
                    <span>{entry.name}</span>
                  </label>
                {:else}
                  <span>{entry.name}</span>
                {/if}
                <small>
                  {#if entry.quantity}{formatQuantityEs(entry.quantity)} {entry.unit ?? ''}{/if}
                  {#if entry.includesFixed}· incluye cantidad fija sin escalar{/if}
                  {#if entry.kind === 'derived'}· del menú{/if}
                </small>
              </li>
            {/each}
          </ul>
        {:else}
          <p class="audit-note">No hay nada en la lista de esta semana todavía.</p>
        {/each}
      </section>

      {#if shopping.canWrite}
        <section class="card" aria-labelledby="shopping-add-title">
          <div class="section-heading"><div><p class="eyebrow">Añadir a mano</p><h2 id="shopping-add-title">Nuevo añadido</h2></div></div>
          <form class="action-form" onsubmit={submitShoppingItem}>
            <label>Alimento del catálogo
              <select bind:value={itemFoodId}>
                <option value="">— Nombre libre —</option>
                {#each shopping.foods as food (food.id)}
                  <option value={food.id}>{food.name}</option>
                {/each}
              </select>
            </label>
            {#if !itemFoodId}
              <label>Nombre libre
                <input type="text" autocomplete="off" enterkeyhint="next" bind:value={itemName} maxlength="120" />
              </label>
            {/if}
            <label>Cantidad
              <input type="text" inputmode="decimal" autocomplete="off" enterkeyhint="next" bind:value={itemQuantity} placeholder="1,5" />
            </label>
            <label>Unidad
              <input type="text" autocomplete="off" enterkeyhint="next" bind:value={itemUnit} maxlength="30" placeholder="kg" />
            </label>
            <label>Sección
              <input type="text" autocomplete="off" enterkeyhint="done" bind:value={itemSection} maxlength="60" placeholder="despensa" />
            </label>
            <button class="button primary" type="submit" disabled={busy}>Añadir a la compra</button>
          </form>
        </section>
      {/if}
    {/if}
  {:else if data.menu}
    {#snippet actions()}{#if canWriteFixture}<button class="button primary" type="button">Editar semana</button>{/if}{/snippet}
    <PageHeader eyebrow={data.menu.weekLabel} title="Menú de la casa" description="Una semana visible de un vistazo, con notas que importan." {actions} />

    <div class="day-tabs" role="tablist" aria-label="Días de la semana">
      {#each data.menu.days as day, index}
        <button type="button" role="tab" aria-selected={selected === index} class:active={selected === index} onclick={() => selected = index}>
          <span>{day.day}</span><strong>{day.date}</strong>
        </button>
      {/each}
    </div>

    <section class="menu-layout">
      <article class="card featured-day">
        <p class="eyebrow">{data.menu.days[selected].day} {data.menu.days[selected].date}</p>
        <h2>Comidas previstas</h2>
        <div class="meal-feature"><span>14:00</span><div><small>Comida</small><strong>{data.menu.days[selected].lunch}</strong></div></div>
        <div class="meal-feature"><span>20:30</span><div><small>Cena</small><strong>{data.menu.days[selected].dinner}</strong></div></div>
        <aside class="allergen-note"><strong>Nota de preparación</strong><p>{data.menu.days[selected].note}</p></aside>
      </article>

      <article class="card week-overview">
        <div class="section-heading"><div><p class="eyebrow">Plan semanal</p><h2>El resto de la semana</h2></div><a href={`/h/${context.household.id}/recipes`}>Recetas →</a></div>
        {#each data.menu.days as day, index}
          <button type="button" class:active={selected === index} onclick={() => selected = index}>
            <span class="date-tile"><small>{day.day}</small><strong>{day.date}</strong></span>
            <span><strong>{day.lunch}</strong><small>{day.dinner}</small></span>
            <span aria-hidden="true">›</span>
          </button>
        {/each}
      </article>
    </section>
  {/if}
</div>

<style>
  /* La pestaña «Recetas» es un enlace a su ruta propia con el mismo aspecto
     que las pestañas de sección del menú. */
  .space-tabs a.tab-link {
    flex: 0 0 auto;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: var(--surface);
    padding: 0.45rem 0.8rem;
    color: var(--ink-soft);
    font-size: 0.75rem;
    font-weight: 700;
    text-decoration: none;
    line-height: normal;
  }
</style>
