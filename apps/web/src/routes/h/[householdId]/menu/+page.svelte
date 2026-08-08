<script lang="ts">
  import PageHeader from '$lib/components/PageHeader.svelte';
  import ActionStatus from '$lib/components/ActionStatus.svelte';
  import { useAppContext } from '$lib/auth/context';
  import { OptimisticActions } from '$lib/offline/optimistic';
  import { activeMenuDayIndex, addDays, dayLabel, isIsoDate, mondayOf, weekLabel } from '$lib/food/dates';
  import { formatQuantityEs } from '$lib/food/quantities';
  import {
    addShoppingItem,
    applyMenuTemplate,
    clearMenuSlot,
    confirmMenuSlot,
    deleteMenuTemplate,
    duplicateMenuWeek,
    saveMenuTemplate,
    setMenuSlot,
    setMenuSlotNewRecipe,
    setShoppingChecked,
    upsertMenuGroup,
    type MealSlot
  } from '$lib/food/commands';
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

  // Patrón wiki replicado (P2-1): cada acción pinta su estado optimista al
  // instante, `invalidate('cc:menu')` selectivo tras el ACK y reversión ante
  // rejected/conflict. Sin `busy` global: los taps son encadenables y cada
  // control lleva su propio guard.
  const optimistic = new OptimisticActions({ householdId: context.household.id, invalidateToken: 'cc:menu' });
  const actionStatus = optimistic.status;
  $effect(() => optimistic.start());

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

  const slotByKey = $derived(new Map((week?.slots ?? []).map((slot) => [`${slot.groupId}:${slot.onDate}:${slot.meal}`, slot])));

  function slotFor(groupId: string, onDate: string, meal: MealSlot): MenuSlotView | undefined {
    return slotByKey.get(`${groupId}:${onDate}:${meal}`);
  }

  // ── Estado optimista por hueco ─────────────────────────────────────────────
  // `null` = vaciado optimista; un borrador = asignación recién guardada que se
  // pinta YA mientras el comando viaja. Se retira al llegar los datos frescos.
  type SlotDraft =
    | { kind: 'recipe'; pageId: string; title: string; notes: string; conflicts: Array<{ name: string; diners: string[] }> }
    | { kind: 'new'; title: string; notes: string }
    | { kind: 'text'; text: string; notes: string };
  let slotDrafts = $state<Record<string, SlotDraft | null>>({});
  /** Confirmación optimista por slotId (chip «Confirmado» inmediato). */
  let confirmedSlotIds = $state<Record<string, true>>({});
  /** Guard anti doble-tap del botón «Confirmar» de cada hueco. */
  let confirmingSlotIds = $state<Record<string, true>>({});

  // ── Editor de hueco (asignar receta o texto) ───────────────────────────────
  let editorKey = $state<string | null>(null);
  let editorMode = $state<'recipe' | 'new' | 'text'>('recipe');
  let editorRecipeId = $state('');
  let editorText = $state('');
  let editorNotes = $state('');
  let editorServings = $state<number | null>(null);
  let editorAcknowledge = $state(false);
  /** «Nueva receta»: nombre y nota inicial (ingredientes en texto, pasos…). */
  let editorNewRecipeName = $state('');
  let editorNewRecipeBody = $state('');

  function openEditor(groupId: string, onDate: string, meal: MealSlot): void {
    const slot = slotFor(groupId, onDate, meal);
    editorKey = `${groupId}:${onDate}:${meal}`;
    editorMode = slot && !slot.recipe && slot.freeText ? 'text' : 'recipe';
    editorRecipeId = slot?.recipe?.pageId ?? '';
    editorText = slot?.freeText ?? '';
    editorNotes = slot?.notes ?? '';
    editorServings = slot?.servingsOverride ?? null;
    editorAcknowledge = false;
    editorNewRecipeName = '';
    editorNewRecipeBody = '';
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
    if (!week || !editorParts || !editorKey) return;
    if (editorMode === 'recipe' && !editorRecipeId) return;
    if (editorMode === 'new' && !editorNewRecipeName.trim()) return;
    if (editorMode === 'text' && !editorText.trim()) return;
    if (editorConflicts.length > 0 && !editorAcknowledge) return;
    const key = editorKey;
    const servings = editorServings;
    const servingsOverride =
      servings !== null && Number.isInteger(servings) && servings > 0 ? servings : undefined;
    const draft: SlotDraft =
      editorMode === 'recipe'
        ? {
            kind: 'recipe',
            pageId: editorRecipeId,
            title: editorRecipe?.title ?? 'Receta',
            notes: editorNotes.trim(),
            conflicts: editorConflicts.map((conflict) => ({ name: conflict.name, diners: conflict.diners }))
          }
        : editorMode === 'new'
          ? { kind: 'new', title: editorNewRecipeName.trim(), notes: editorNotes.trim() }
          : { kind: 'text', text: editorText.trim(), notes: editorNotes.trim() };
    // «Nueva receta»: UN comando atómico que crea la receta (página wiki +
    // ficha) y asigna el hueco; offline entra entero o no entra.
    const envelope =
      editorMode === 'new'
        ? setMenuSlotNewRecipe({
            householdId: week.householdId,
            groupId: editorParts[0]!,
            onDate: editorParts[1]!,
            meal: editorParts[2] as MealSlot,
            recipeTitle: editorNewRecipeName,
            recipeBody: editorNewRecipeBody,
            notes: editorNotes,
            servingsOverride
          })
        : setMenuSlot({
            householdId: week.householdId,
            groupId: editorParts[0]!,
            onDate: editorParts[1]!,
            meal: editorParts[2] as MealSlot,
            recipePageId: editorMode === 'recipe' ? editorRecipeId : undefined,
            freeText: editorMode === 'text' ? editorText : undefined,
            notes: editorNotes,
            servingsOverride,
            acknowledgeAllergens: editorConflicts.length > 0 ? editorAcknowledge : undefined
          });
    void optimistic.run(envelope, {
      apply: () => {
        slotDrafts[key] = draft;
        editorKey = null;
      },
      revert: () => {
        delete slotDrafts[key];
      },
      settle: () => {
        delete slotDrafts[key];
      }
    });
  }

  function confirmSlot(slot: MenuSlotView): void {
    if (!week || confirmingSlotIds[slot.id]) return;
    confirmingSlotIds[slot.id] = true;
    void optimistic
      .run(confirmMenuSlot({ householdId: week.householdId, slotId: slot.id, contentHash: slot.contentHash }), {
        apply: () => {
          confirmedSlotIds[slot.id] = true;
        },
        revert: () => {
          delete confirmedSlotIds[slot.id];
        },
        settle: () => {
          delete confirmedSlotIds[slot.id];
        }
      })
      .finally(() => {
        delete confirmingSlotIds[slot.id];
      });
  }

  function clearSlot(slot: MenuSlotView): void {
    if (!week) return;
    const key = `${slot.groupId}:${slot.onDate}:${slot.meal}`;
    void optimistic.run(clearMenuSlot({ householdId: week.householdId, slotId: slot.id }), {
      apply: () => {
        slotDrafts[key] = null;
      },
      revert: () => {
        delete slotDrafts[key];
      },
      settle: () => {
        delete slotDrafts[key];
      }
    });
  }

  // Confirmación visible del duplicado: qué semana se copió y adónde, con
  // enlace directo para comprobarlo sin navegar a ciegas. A diferencia del
  // resto de acciones, aquí NO se pinta antes del ACK: el resultado vive en
  // otra semana (no visible) y anunciar «copiada» sin confirmación mentiría.
  // La semana destino es elegible (P3 week_overlap): por defecto la siguiente;
  // una fecha a menos de 7 días produce el rechazo real del servidor, cuyo
  // mensaje veraz muestra la nota unificada de acciones.
  let duplicated = $state<{ from: string; to: string; day: string } | null>(null);
  let duplicating = $state(false);
  let duplicateTarget = $state('');
  const duplicateDefault = $derived(week ? addDays(week.weekStartsOn, 7) : '');

  function duplicateWeek(event: SubmitEvent): void {
    event.preventDefault();
    if (!week || duplicating) return;
    const from = week.weekStartsOn;
    const to = duplicateTarget || duplicateDefault;
    const dayDiff = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
    const day = addDays(selectedDate ?? from, dayDiff);
    duplicated = null;
    duplicating = true;
    // Un rechazo (p. ej. week_overlap) lo anuncia la nota unificada de
    // acciones con el mensaje traducido real del servidor.
    void optimistic
      .run(duplicateMenuWeek({ householdId: week.householdId, fromWeekStartsOn: from, toWeekStartsOn: to }), {
        settle: () => {
          duplicated = { from, to, day };
        }
      })
      .finally(() => {
        duplicating = false;
      });
  }

  $effect(() => {
    // El aviso de copia pertenece a la semana de origen: al navegar, fuera.
    if (duplicated && week && week.weekStartsOn !== duplicated.from) duplicated = null;
    // El aviso de plantilla aplicada pertenece a la semana donde se aplicó:
    // al navegar a otra semana, fuera.
    if (templateApplied && week && week.weekStartsOn !== templateApplied.from) templateApplied = null;
    if (week) {
      duplicateTarget = addDays(week.weekStartsOn, 7);
      applyTarget = addDays(week.weekStartsOn, 7);
    }
  });

  // ── Semanas plantilla con nombre («Semana de cole», «Semana de verano») ───
  let templateName = $state('');
  let savingTemplate = $state(false);
  let applyTemplateId = $state('');
  // Lunes destino de «Usar plantilla»: por defecto la semana siguiente, y
  // cualquier fecha elegida se normaliza a su lunes (mismo selector que el
  // duplicado). El servidor exige que la semana destino esté vacía.
  let applyTarget = $state('');
  let applying = $state(false);
  let templateApplied = $state<{ name: string; from: string; to: string } | null>(null);
  /** Confirmación ligera del borrado: primer tap arma, el segundo borra. */
  let deleteArmedId = $state<string | null>(null);
  let deletingTemplateIds = $state<Record<string, true>>({});

  const applyMonday = $derived(
    applyTarget && isIsoDate(applyTarget) ? mondayOf(applyTarget) : duplicateDefault
  );

  function submitSaveTemplate(event: SubmitEvent): void {
    event.preventDefault();
    if (!week || savingTemplate || !templateName.trim()) return;
    const name = templateName;
    savingTemplate = true;
    void optimistic
      .run(
        saveMenuTemplate({ householdId: week.householdId, name, fromWeekStartsOn: week.weekStartsOn }),
        {
          apply: () => {
            templateName = '';
          },
          revert: () => {
            templateName = name;
          }
        }
      )
      .finally(() => {
        savingTemplate = false;
      });
  }

  function submitApplyTemplate(event: SubmitEvent): void {
    event.preventDefault();
    if (!week || applying || !applyTemplateId) return;
    const template = week.templates.find((candidate) => candidate.id === applyTemplateId);
    const from = week.weekStartsOn;
    const to = applyMonday;
    templateApplied = null;
    applying = true;
    // Como en el duplicado, aquí NO se pinta antes del ACK: el resultado vive
    // en otra semana y un rechazo (week_overlap si el destino tiene contenido)
    // lo cuenta la nota unificada con el mensaje real del servidor.
    void optimistic
      .run(applyMenuTemplate({ householdId: week.householdId, templateId: applyTemplateId, toWeekStartsOn: to }), {
        settle: () => {
          templateApplied = { name: template?.name ?? 'Plantilla', from, to };
        }
      })
      .finally(() => {
        applying = false;
      });
  }

  function removeTemplate(templateId: string): void {
    if (!week || deletingTemplateIds[templateId]) return;
    deleteArmedId = null;
    deletingTemplateIds[templateId] = true;
    if (applyTemplateId === templateId) applyTemplateId = '';
    void optimistic
      .run(deleteMenuTemplate({ householdId: week.householdId, templateId }))
      .finally(() => {
        delete deletingTemplateIds[templateId];
      });
  }

  // ── Nuevo grupo de comensales ──────────────────────────────────────────────
  let newGroupName = $state('');
  let newGroupDiners = $state<string[]>([]);

  function submitNewGroup(event: SubmitEvent): void {
    event.preventDefault();
    if (!week || !newGroupName.trim()) return;
    const envelope = upsertMenuGroup({ householdId: week.householdId, name: newGroupName, dinerIds: newGroupDiners });
    void optimistic.run(envelope, {
      apply: () => {
        newGroupName = '';
        newGroupDiners = [];
      }
    });
  }

  // ── Lista de la compra (AC-24) ─────────────────────────────────────────────
  let itemFoodId = $state('');
  let itemName = $state('');
  let itemQuantity = $state('');
  let itemUnit = $state('');
  let itemSection = $state('');

  /** Marcado optimista por artículo: taps encadenables, sin bloquear nada. */
  let checkedOverrides = $state<Record<string, boolean>>({});
  /** Añadidos recién guardados que aún no llegaron del servidor. */
  type OptimisticAddition = { operationId: string; name: string; quantity: string; unit: string };
  let optimisticAdds = $state<OptimisticAddition[]>([]);
  const serverEntryNames = $derived(
    new Set((shopping?.sections ?? []).flatMap((section) => section.entries.map((entry) => entry.name)))
  );
  // Dedupe por nombre: cuando los datos frescos ya lo listan, la fila
  // optimista desaparece sin solaparse ni parpadear.
  const pendingAdds = $derived(optimisticAdds.filter((addition) => !serverEntryNames.has(addition.name)));

  function submitShoppingItem(event: SubmitEvent): void {
    event.preventDefault();
    if (!shopping) return;
    if (!itemFoodId && !itemName.trim()) return;
    const food = shopping.foods.find((candidate) => candidate.id === itemFoodId);
    const displayName = (itemFoodId ? food?.name : itemName.trim()) ?? itemName.trim();
    const envelope = addShoppingItem({
      householdId: shopping.householdId,
      foodId: itemFoodId || undefined,
      customName: itemFoodId ? undefined : itemName,
      quantity: itemQuantity,
      unit: itemUnit,
      section: itemSection || food?.section,
      weekStartsOn: shopping.weekStartsOn
    });
    const removeAddition = () => {
      optimisticAdds = optimisticAdds.filter((addition) => addition.operationId !== envelope.operationId);
    };
    void optimistic.run(envelope, {
      apply: () => {
        optimisticAdds = [
          ...optimisticAdds,
          { operationId: envelope.operationId, name: displayName, quantity: itemQuantity.trim(), unit: itemUnit.trim() }
        ];
        itemFoodId = '';
        itemName = '';
        itemQuantity = '';
        itemUnit = '';
        itemSection = '';
      },
      revert: removeAddition,
      settle: removeAddition
    });
  }

  function toggleChecked(itemId: string, checked: boolean): void {
    if (!shopping) return;
    const next = !checked;
    void optimistic.run(setShoppingChecked({ householdId: shopping.householdId, itemId, checked: next }), {
      apply: () => {
        checkedOverrides[itemId] = next;
      },
      revert: () => {
        delete checkedOverrides[itemId];
      },
      settle: () => {
        delete checkedOverrides[itemId];
      }
    });
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
            <input type="date" bind:value={duplicateTarget} placeholder={duplicateDefault} enterkeyhint="done" />
          </label>
          <button class="button secondary" type="submit" disabled={duplicating}>
            {!duplicateTarget || duplicateTarget === duplicateDefault ? 'Duplicar en la semana siguiente' : 'Duplicar en esa semana'}
          </button>
        </form>
      {/if}
    {/snippet}
    <PageHeader
      eyebrow={`Semana del ${weekLabel(week.weekStartsOn)}`}
      title="Menú de la casa"
      description="Las comidas de cada día por grupo de comensales, con las alergias a la vista."
      actions={weekActions}
    />

    <ActionStatus status={actionStatus} />
    {#if duplicated}
      <p class="success-message" role="status">
        Semana del {weekLabel(duplicated.from)} copiada a la del {weekLabel(duplicated.to)}.
        <a href={`${base}?week=${duplicated.to}&day=${duplicated.day}`}>Ver la semana del {weekLabel(duplicated.to)} →</a>
      </p>
    {/if}
    {#if templateApplied}
      <p class="success-message" role="status">
        Plantilla «{templateApplied.name}» aplicada sobre la semana del {weekLabel(templateApplied.to)}.
        <a href={`${base}?week=${templateApplied.to}`}>Ver la semana del {weekLabel(templateApplied.to)} →</a>
      </p>
    {/if}

    <nav class="week-nav" aria-label="Cambiar de semana">
      <a class="button secondary" href={`${base}?week=${addDays(week.weekStartsOn, -7)}&day=${addDays(selectedDate ?? week.weekStartsOn, -7)}`}>← Semana anterior</a>
      <a class="button secondary" href={`${base}?week=${addDays(week.weekStartsOn, 7)}&day=${addDays(selectedDate ?? week.weekStartsOn, 7)}`}>Semana siguiente →</a>
    </nav>

    <div class="space-tabs" role="list" aria-label="Secciones del menú">
      <button type="button" class:active={tab === 'menu'} onclick={() => (tab = 'menu')}>Menú semanal</button>
      <button type="button" class:active={tab === 'compra'} onclick={() => (tab = 'compra')}>Lista de la compra</button>
      <a class="tab-link" href={`/h/${context.household.id}/recipes`}>Recetas y comensales</a>
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
            {@const key = `${group.id}:${day}:${meal}`}
            {@const draftPending = key in slotDrafts}
            {@const draft = slotDrafts[key]}
            <div class="menu-slot-row">
              <div class="menu-slot-copy">
                <small>{MEAL_LABEL[meal]}</small>
                {#if draftPending}
                  {#if draft === null || draft === undefined}
                    <span class="audit-note">Sin decidir</span>
                  {:else if draft.kind === 'recipe'}
                    <strong><a href={`/h/${context.household.id}/recipes?receta=${draft.pageId}`}>{draft.title}</a></strong>
                    {#if draft.notes}<small class="menu-slot-note">{draft.notes}</small>{/if}
                    {#if draft.conflicts.length}
                      <p class="queued-note" role="alert">
                        ⚠ Este plato lleva algo que no todos pueden tomar:
                        {draft.conflicts.map((conflict) => `${conflict.name} (${conflict.diners.join(', ')})`).join(', ')}
                      </p>
                    {/if}
                  {:else if draft.kind === 'new'}
                    <strong>{draft.title}</strong>
                    <small>Receta nueva del recetario</small>
                    {#if draft.notes}<small class="menu-slot-note">{draft.notes}</small>{/if}
                  {:else}
                    <strong>{draft.text}</strong>
                    {#if draft.notes}<small class="menu-slot-note">{draft.notes}</small>{/if}
                  {/if}
                {:else if slot?.recipe}
                  <strong><a href={`/h/${context.household.id}/recipes?receta=${slot.recipe.pageId}`}>{slot.recipe.title}</a></strong>
                  <small>{slot.servingsOverride ?? (group.diners.length > 0 ? group.diners.length : slot.recipe.baseServings)} raciones (la receta original es para {slot.recipe.baseServings})</small>
                {:else if slot}
                  <strong>{slot.freeText}</strong>
                {:else}
                  <span class="audit-note">Sin decidir</span>
                {/if}
                {#if !draftPending && slot?.notes}<small class="menu-slot-note">{slot.notes}</small>{/if}
                {#if !draftPending && slot && slot.conflicts.length}
                  <p class="queued-note" role="alert">
                    ⚠ Este plato lleva algo que no todos pueden tomar:
                    {slot.conflicts.map((conflict) => `${conflict.allergenName} (${conflict.dinerName})`).join(', ')}
                  </p>
                {/if}
                {#if !draftPending && slot}
                  {#if slot.confirmation?.upToDate || confirmedSlotIds[slot.id]}
                    <span class="status-chip success">Confirmado</span>
                  {:else if slot.confirmation}
                    <span class="status-chip warning">Confirmación caducada: el contenido cambió</span>
                  {/if}
                {/if}
              </div>
              {#if week.canWrite && !draftPending}
                <div class="menu-slot-actions">
                  {#if slot && !slot.confirmation?.upToDate && !confirmedSlotIds[slot.id]}
                    <button class="button secondary small-button" type="button" disabled={confirmingSlotIds[slot.id]} onclick={() => confirmSlot(slot)}>Confirmar</button>
                  {/if}
                  <button class="button secondary small-button" type="button" onclick={() => openEditor(group.id, day, meal)}>
                    {slot ? 'Cambiar' : 'Asignar'}
                  </button>
                  {#if slot}
                    <button class="button secondary small-button" type="button" onclick={() => clearSlot(slot)}>Vaciar</button>
                  {/if}
                </div>
              {/if}
            </div>

            {#if editorKey === `${group.id}:${day}:${meal}`}
              <form class="action-form menu-slot-editor" onsubmit={submitEditor}>
                <div class="space-tabs" role="list" aria-label="Tipo de plan">
                  <button type="button" class:active={editorMode === 'recipe'} onclick={() => (editorMode = 'recipe')}>Receta</button>
                  <button type="button" class:active={editorMode === 'new'} onclick={() => (editorMode = 'new')}>Nueva receta</button>
                  <button type="button" class:active={editorMode === 'text'} onclick={() => (editorMode = 'text')}>Escribir a mano</button>
                </div>
                {#if editorMode === 'new'}
                  <label>Nombre de la receta nueva
                    <input type="text" autocomplete="off" enterkeyhint="next" bind:value={editorNewRecipeName} maxlength="200" required />
                  </label>
                  <label>Ingredientes o nota inicial (opcional)
                    <input type="text" autocomplete="off" enterkeyhint="next" bind:value={editorNewRecipeBody} maxlength="10000" />
                  </label>
                  <p class="audit-note">
                    La receta se crea en el recetario (con su página wiki) y se asigna a este hueco, todo de una vez.
                  </p>
                {:else if editorMode === 'recipe'}
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
                  <label>El plato, escrito a mano
                    <input type="text" autocomplete="off" enterkeyhint="next" bind:value={editorText} maxlength="300" required />
                  </label>
                {/if}
                <label>Notas
                  <input type="text" autocomplete="off" enterkeyhint="next" bind:value={editorNotes} maxlength="500" />
                </label>
                <label>Raciones (si lo dejas vacío: las personas del grupo)
                  <input type="number" inputmode="numeric" enterkeyhint="done" min="1" max="50" bind:value={editorServings} />
                </label>
                {#if editorConflicts.length > 0}
                  <div class="allergen-block" role="alert">
                    <strong>⚠ Este plato lleva algo que no todos pueden tomar</strong>
                    <ul>
                      {#each editorConflicts as conflict (conflict.code)}
                        <li>{conflict.name} — afecta a {conflict.diners.join(', ')}</li>
                      {/each}
                    </ul>
                    <label class="inline-check">
                      <input type="checkbox" bind:checked={editorAcknowledge} />
                      Lo sé y aun así quiero apuntarlo
                    </label>
                  </div>
                {/if}
                <div class="menu-slot-actions">
                  <button class="button primary" type="submit" disabled={editorConflicts.length > 0 && !editorAcknowledge}>
                    Guardar
                  </button>
                  <button class="button secondary" type="button" onclick={() => (editorKey = null)}>Cancelar</button>
                </div>
              </form>
            {/if}
          {/each}
        </section>
      {:else}
        <!-- P1-7 (revisión UX v3): el primer uso guiaba a un callejón sin
             salida. La guía cuenta el orden real (comensales → grupo → menú)
             y enlaza al sitio donde se hace cada paso. -->
        <section class="card" aria-labelledby="menu-first-use-title">
          <div class="section-heading">
            <div><p class="eyebrow">Primer uso</p><h2 id="menu-first-use-title">Para empezar con el menú</h2></div>
          </div>
          {#if week.canWrite}
            <p class="audit-note">
              El menú se organiza por grupos de comensales (quiénes comen juntos). Se prepara en dos pasos:
            </p>
            <ol class="first-use-steps">
              <li>
                <span>
                  <strong>1 · Apunta quién come en casa</strong>
                  <small>Con sus alergias, si las tiene. Se hace en «Recetas y comensales».</small>
                </span>
                {#if week.diners.length > 0}
                  <span class="status-chip success">Hecho · {week.diners.length} {week.diners.length === 1 ? 'persona' : 'personas'}</span>
                {:else}
                  <a class="button primary small-button" href={`/h/${context.household.id}/recipes#diners-title`}>Apuntar comensales</a>
                {/if}
              </li>
              <li>
                <span>
                  <strong>2 · Crea el grupo «Casa» con esas personas</strong>
                  <small>Con el formulario de aquí abajo. Después ya podrás planificar las comidas.</small>
                </span>
                <a class="button {week.diners.length > 0 ? 'primary' : 'secondary'} small-button" href="#new-group-title">Crear el grupo</a>
              </li>
            </ol>
          {:else}
            <p class="audit-note">
              La familia todavía no ha preparado el menú. En cuanto haya un grupo de comensales,
              aquí verás las comidas de la semana.
            </p>
          {/if}
        </section>
      {/each}

      {#if week.canWrite}
        <section class="card" aria-labelledby="templates-title">
          <div class="section-heading">
            <div><p class="eyebrow">Plantillas</p><h2 id="templates-title">Semanas plantilla</h2></div>
          </div>

          <form class="action-form" onsubmit={submitSaveTemplate}>
            <label>Guardar esta semana como plantilla
              <input
                type="text"
                autocomplete="off"
                enterkeyhint="done"
                bind:value={templateName}
                maxlength="120"
                placeholder="Semana de cole"
                required
              />
            </label>
            <button class="button secondary" type="submit" disabled={savingTemplate}>
              Guardar semana como plantilla
            </button>
          </form>

          {#if week.templates.length}
            <form class="action-form" onsubmit={submitApplyTemplate}>
              <label>Usar una plantilla
                <select bind:value={applyTemplateId} required>
                  <option value="" disabled>Elige una plantilla</option>
                  {#each week.templates as template (template.id)}
                    <option value={template.id}>{template.name}</option>
                  {/each}
                </select>
              </label>
              <label>Sobre el lunes
                <input type="date" bind:value={applyTarget} enterkeyhint="done" />
              </label>
              <p class="audit-note">
                Se copiará sobre la semana del {weekLabel(applyMonday)}. La semana debe estar vacía.
              </p>
              <button class="button primary" type="submit" disabled={applying || !applyTemplateId}>
                Usar plantilla
              </button>
            </form>

            <ul class="wiki-recent">
              {#each week.templates.filter((template) => !deletingTemplateIds[template.id]) as template (template.id)}
                <li>
                  <div class="wiki-node-row">
                    <span>
                      <strong>{template.name}</strong>
                      <small>De la semana del {weekLabel(template.sourceWeekStartsOn)}</small>
                    </span>
                    {#if deleteArmedId === template.id}
                      <button class="button secondary small-button" type="button" onclick={() => removeTemplate(template.id)}>
                        Sí, borrar «{template.name}»
                      </button>
                      <button class="button secondary small-button" type="button" onclick={() => (deleteArmedId = null)}>
                        Cancelar
                      </button>
                    {:else}
                      <button class="button secondary small-button" type="button" onclick={() => (deleteArmedId = template.id)}>
                        Borrar
                      </button>
                    {/if}
                  </div>
                </li>
              {/each}
            </ul>
          {:else}
            <p class="audit-note">Todavía no hay plantillas guardadas en este hogar.</p>
          {/if}
        </section>

        <section class="card" aria-labelledby="new-group-title">
          <div class="section-heading"><div><p class="eyebrow">Organizar</p><h2 id="new-group-title">Nuevo grupo de comensales</h2></div></div>
          {#if week.diners.length === 0}
            <!-- Atajo visible al alta real (vive en «Recetas y comensales»). -->
            <p class="audit-note">
              Todavía no hay personas apuntadas.
              <a href={`/h/${context.household.id}/recipes#diners-title`}>Apunta primero los comensales →</a>
            </p>
          {/if}
          <form class="action-form" onsubmit={submitNewGroup}>
            <label>Nombre
              <input type="text" autocomplete="off" enterkeyhint="done" bind:value={newGroupName} maxlength="120" required placeholder="Casa" />
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
            <button class="button secondary" type="submit">Crear grupo</button>
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
              {@const shownChecked = entry.itemId !== null && entry.itemId in checkedOverrides ? checkedOverrides[entry.itemId] : entry.checked}
              <li class:checked={shownChecked}>
                {#if entry.kind === 'manual' && shopping.canWrite}
                  <label class="inline-check">
                    <input type="checkbox" checked={shownChecked} onchange={() => toggleChecked(entry.itemId!, shownChecked ?? false)} />
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
        {#if pendingAdds.length}
          <ul class="ingredient-list">
            {#each pendingAdds as addition (addition.operationId)}
              <li>
                <span>{addition.name}</span>
                <small>{#if addition.quantity}{addition.quantity} {addition.unit}{/if}</small>
              </li>
            {/each}
          </ul>
        {/if}
      </section>

      {#if shopping.canWrite}
        <section class="card" aria-labelledby="shopping-add-title">
          <div class="section-heading"><div><p class="eyebrow">Lista de la compra</p><h2 id="shopping-add-title">Añadir otra cosa</h2></div></div>
          <form class="action-form" onsubmit={submitShoppingItem}>
            <label>¿Qué es? (elige o escríbelo)
              <select bind:value={itemFoodId}>
                <option value="">— Otra cosa: escríbela abajo —</option>
                {#each shopping.foods as food (food.id)}
                  <option value={food.id}>{food.name}</option>
                {/each}
              </select>
            </label>
            {#if !itemFoodId}
              <label>Escríbelo aquí
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
            <button class="button primary" type="submit">Añadir a la compra</button>
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
  /* Guía de primer uso (P1-7): pasos numerados con su acción al lado. */
  .first-use-steps {
    margin: 0.75rem 0 0;
    padding-left: 0;
    list-style: none;
    display: grid;
    gap: 0.85rem;
  }
  .first-use-steps li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem 1rem;
  }
  .first-use-steps li > span:first-child {
    display: grid;
    gap: 0.15rem;
  }
  .first-use-steps small {
    color: var(--ink-soft);
  }

  /* La pestaña «Recetas y comensales» es un enlace a su ruta propia con el
     mismo aspecto que las pestañas de sección del menú. */
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
