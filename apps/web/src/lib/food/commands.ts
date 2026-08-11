import type { CommandEnvelopeV1 } from '@casa-clara/contracts';

import { createCommandEnvelope } from '$lib/offline/schema';
import { queueCommand, type QueueOutcome } from '$lib/offline/queue-command';

/**
 * Constructores puros de envelopes para comida, menú, compra y rutinas.
 * Producen los payloads CONGELADOS de @casa-clara/contracts/schemas
 * (foodUpsert, dinerUpsert, recipeSetDetails, menuGroupUpsert, menuSlot
 * set/clear/duplicate_week/confirm, shoppingAdd, shoppingSetChecked,
 * routineUpsert y routineComplete). La validación zod vive en los tests y en
 * el servidor, nunca en el bundle del navegador; los tipos locales replican
 * los contratos porque el índice de contracts aún no exporta interfaces de
 * comida. `operationId`/`occurredAt` son inyectables para tests deterministas.
 */

interface EnvelopeOptions {
  operationId?: string;
  occurredAt?: string;
}

export type AllergenSeverity = 'high' | 'medium';
export type MealSlot = 'desayuno' | 'almuerzo' | 'comida' | 'merienda' | 'cena';
export type IngredientScaling = 'linear' | 'fixed';
export type RoutineAudience = 'family' | 'employee' | 'all';
export type RoutineFrequency = 'daily' | 'weekly' | 'monthly' | 'quarterly';

export interface FoodPackaging {
  size: string;
  unit: string;
}

export interface FoodUpsertPayload {
  action: 'upsert';
  foodId?: string;
  name: string;
  shoppingSection: string;
  allergenCodes: string[];
  reviewed: boolean;
  /** Tamaño del paquete con el que se compra («500 g»); opcional. */
  packaging?: FoodPackaging;
}

export interface DinerUpsertPayload {
  action: 'upsert';
  dinerId?: string;
  name: string;
  notes?: string;
  flags: Array<{ allergenCode: string; severity: AllergenSeverity; note?: string }>;
}

export interface RecipeSetDetailsPayload {
  action: 'set_details';
  pageId: string;
  baseServings: number;
  timeMinutes?: number;
  ingredients: Array<{ foodId: string; quantity: string; unit: string; scaling: IngredientScaling }>;
}

export interface MenuGroupUpsertPayload {
  action: 'upsert';
  groupId?: string;
  name: string;
  dinerIds: string[];
}

export interface MenuSlotSetPayload {
  action: 'set';
  groupId: string;
  onDate: string;
  meal: MealSlot;
  recipePageId?: string;
  freeText?: string;
  notes?: string;
  servingsOverride?: number;
  /** Reconocimiento explícito de una incompatibilidad de alérgenos (AC-21). */
  acknowledgeAllergens?: boolean;
}

export interface MenuSlotSetNewRecipePayload {
  action: 'set_new_recipe';
  groupId: string;
  onDate: string;
  meal: MealSlot;
  recipeTitle: string;
  /** Nota inicial (ingredientes en texto, pasos…) para la página wiki. */
  recipeBody?: string;
  baseServings?: number;
  notes?: string;
  servingsOverride?: number;
}

export interface MenuSlotClearPayload {
  action: 'clear';
  slotId: string;
}

export interface MenuWeekDuplicatePayload {
  action: 'duplicate_week';
  fromWeekStartsOn: string;
  toWeekStartsOn: string;
}

export interface MenuConfirmPayload {
  action: 'confirm';
  slotId: string;
  contentHash: string;
}

export interface MenuTemplateSavePayload {
  action: 'save';
  name: string;
  fromWeekStartsOn: string;
}

export interface MenuTemplateApplyPayload {
  action: 'apply';
  templateId: string;
  toWeekStartsOn: string;
}

export interface MenuTemplateDeletePayload {
  action: 'delete';
  templateId: string;
}

export type ShoppingListKind = 'casa' | 'personal';

export interface ShoppingAddPayload {
  action: 'add';
  foodId?: string;
  customName?: string;
  quantity?: string;
  unit?: string;
  section?: string;
  weekStartsOn?: string;
  listKind?: ShoppingListKind;
}

export interface ShoppingSetCheckedPayload {
  action: 'set_checked';
  itemId: string;
  checked: boolean;
}

export interface ShoppingSetLineCheckedPayload {
  action: 'set_line_checked';
  weekStartsOn: string;
  lineKey: string;
  listKind?: ShoppingListKind;
  checked: boolean;
}

export interface RoutineUpsertPayload {
  action: 'upsert';
  routineId?: string;
  title: string;
  details?: string;
  audience: RoutineAudience;
  frequency: RoutineFrequency;
  intervalCount: number;
  nextDueOn: string;
}

// `routine.complete` y `routine.uncomplete` viven en su módulo mínimo
// (routine-complete.ts) para no arrastrar todos los constructores al bundle
// inicial de Hoy; se re-exportan aquí para conservar la superficie histórica
// del módulo.
export {
  completeRoutine,
  uncompleteRoutine,
  type RoutineCompletePayload,
  type RoutineOccurrencePayload
} from './routine-complete';

function trimmedOrUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function upsertFood(
  input: {
    householdId: string;
    foodId?: string;
    name: string;
    shoppingSection: string;
    allergenCodes: string[];
    reviewed: boolean;
    packaging?: FoodPackaging;
  },
  options: EnvelopeOptions = {}
): CommandEnvelopeV1<FoodUpsertPayload> {
  // Tamaño y unidad del paquete viajan juntos o no viajan: media medida no
  // sirve para redondear y el contrato la rechazaría.
  const packageSize = trimmedOrUndefined(input.packaging?.size);
  const packageUnit = trimmedOrUndefined(input.packaging?.unit);
  const packaging = packageSize && packageUnit ? { size: packageSize, unit: packageUnit } : undefined;
  return createCommandEnvelope({
    ...options,
    householdId: input.householdId,
    aggregateType: 'food',
    aggregateId: input.foodId ?? null,
    payload: {
      action: 'upsert',
      ...(input.foodId ? { foodId: input.foodId } : {}),
      name: input.name.trim(),
      shoppingSection: input.shoppingSection.trim(),
      allergenCodes: [...input.allergenCodes].sort(),
      reviewed: input.reviewed,
      ...(packaging ? { packaging } : {})
    } satisfies FoodUpsertPayload
  }) as CommandEnvelopeV1<FoodUpsertPayload>;
}

export function upsertDiner(
  input: {
    householdId: string;
    dinerId?: string;
    name: string;
    notes?: string;
    flags: Array<{ allergenCode: string; severity: AllergenSeverity; note?: string }>;
  },
  options: EnvelopeOptions = {}
): CommandEnvelopeV1<DinerUpsertPayload> {
  const notes = trimmedOrUndefined(input.notes);
  return createCommandEnvelope({
    ...options,
    householdId: input.householdId,
    aggregateType: 'diner',
    aggregateId: input.dinerId ?? null,
    payload: {
      action: 'upsert',
      ...(input.dinerId ? { dinerId: input.dinerId } : {}),
      name: input.name.trim(),
      ...(notes ? { notes } : {}),
      flags: input.flags.map((flag) => {
        const note = trimmedOrUndefined(flag.note);
        return { allergenCode: flag.allergenCode, severity: flag.severity, ...(note ? { note } : {}) };
      })
    } satisfies DinerUpsertPayload
  }) as CommandEnvelopeV1<DinerUpsertPayload>;
}

export function setRecipeDetails(
  input: {
    householdId: string;
    pageId: string;
    baseServings: number;
    timeMinutes?: number;
    ingredients: Array<{ foodId: string; quantity: string; unit: string; scaling: IngredientScaling }>;
  },
  options: EnvelopeOptions = {}
): CommandEnvelopeV1<RecipeSetDetailsPayload> {
  return createCommandEnvelope({
    ...options,
    householdId: input.householdId,
    aggregateType: 'recipe',
    aggregateId: input.pageId,
    payload: {
      action: 'set_details',
      pageId: input.pageId,
      baseServings: input.baseServings,
      ...(input.timeMinutes ? { timeMinutes: input.timeMinutes } : {}),
      ingredients: input.ingredients.map((ingredient) => ({
        foodId: ingredient.foodId,
        quantity: ingredient.quantity.trim(),
        unit: ingredient.unit.trim(),
        scaling: ingredient.scaling
      }))
    } satisfies RecipeSetDetailsPayload
  }) as CommandEnvelopeV1<RecipeSetDetailsPayload>;
}

export function upsertMenuGroup(
  input: { householdId: string; groupId?: string; name: string; dinerIds: string[] },
  options: EnvelopeOptions = {}
): CommandEnvelopeV1<MenuGroupUpsertPayload> {
  return createCommandEnvelope({
    ...options,
    householdId: input.householdId,
    aggregateType: 'menu_group',
    aggregateId: input.groupId ?? null,
    payload: {
      action: 'upsert',
      ...(input.groupId ? { groupId: input.groupId } : {}),
      name: input.name.trim(),
      dinerIds: input.dinerIds
    } satisfies MenuGroupUpsertPayload
  }) as CommandEnvelopeV1<MenuGroupUpsertPayload>;
}

export function setMenuSlot(
  input: {
    householdId: string;
    groupId: string;
    onDate: string;
    meal: MealSlot;
    recipePageId?: string;
    freeText?: string;
    notes?: string;
    servingsOverride?: number;
    acknowledgeAllergens?: boolean;
  },
  options: EnvelopeOptions = {}
): CommandEnvelopeV1<MenuSlotSetPayload> {
  const freeText = trimmedOrUndefined(input.freeText);
  const notes = trimmedOrUndefined(input.notes);
  return createCommandEnvelope({
    ...options,
    householdId: input.householdId,
    aggregateType: 'menu_slot',
    payload: {
      action: 'set',
      groupId: input.groupId,
      onDate: input.onDate,
      meal: input.meal,
      ...(input.recipePageId ? { recipePageId: input.recipePageId } : {}),
      ...(freeText ? { freeText } : {}),
      ...(notes ? { notes } : {}),
      ...(input.servingsOverride ? { servingsOverride: input.servingsOverride } : {}),
      ...(input.acknowledgeAllergens ? { acknowledgeAllergens: true } : {})
    } satisfies MenuSlotSetPayload
  }) as CommandEnvelopeV1<MenuSlotSetPayload>;
}

/**
 * «Nueva receta» desde el hueco: crea la receta (página wiki + datos) y asigna
 * el hueco en UN solo comando atómico del servidor, robusto offline (o entra
 * todo o no entra nada, con un único recibo idempotente).
 */
export function setMenuSlotNewRecipe(
  input: {
    householdId: string;
    groupId: string;
    onDate: string;
    meal: MealSlot;
    recipeTitle: string;
    recipeBody?: string;
    baseServings?: number;
    notes?: string;
    servingsOverride?: number;
  },
  options: EnvelopeOptions = {}
): CommandEnvelopeV1<MenuSlotSetNewRecipePayload> {
  const recipeBody = trimmedOrUndefined(input.recipeBody);
  const notes = trimmedOrUndefined(input.notes);
  return createCommandEnvelope({
    ...options,
    householdId: input.householdId,
    aggregateType: 'menu_slot',
    payload: {
      action: 'set_new_recipe',
      groupId: input.groupId,
      onDate: input.onDate,
      meal: input.meal,
      recipeTitle: input.recipeTitle.trim(),
      ...(recipeBody ? { recipeBody } : {}),
      ...(input.baseServings ? { baseServings: input.baseServings } : {}),
      ...(notes ? { notes } : {}),
      ...(input.servingsOverride ? { servingsOverride: input.servingsOverride } : {})
    } satisfies MenuSlotSetNewRecipePayload
  }) as CommandEnvelopeV1<MenuSlotSetNewRecipePayload>;
}

export function clearMenuSlot(
  input: { householdId: string; slotId: string },
  options: EnvelopeOptions = {}
): CommandEnvelopeV1<MenuSlotClearPayload> {
  return createCommandEnvelope({
    ...options,
    householdId: input.householdId,
    aggregateType: 'menu_slot',
    aggregateId: input.slotId,
    payload: { action: 'clear', slotId: input.slotId } satisfies MenuSlotClearPayload
  }) as CommandEnvelopeV1<MenuSlotClearPayload>;
}

/** Duplica todos los huecos de una semana en otra (AC-23). */
export function duplicateMenuWeek(
  input: { householdId: string; fromWeekStartsOn: string; toWeekStartsOn: string },
  options: EnvelopeOptions = {}
): CommandEnvelopeV1<MenuWeekDuplicatePayload> {
  return createCommandEnvelope({
    ...options,
    householdId: input.householdId,
    aggregateType: 'menu_slot',
    payload: {
      action: 'duplicate_week',
      fromWeekStartsOn: input.fromWeekStartsOn,
      toWeekStartsOn: input.toWeekStartsOn
    } satisfies MenuWeekDuplicatePayload
  }) as CommandEnvelopeV1<MenuWeekDuplicatePayload>;
}

/**
 * Confirmación bloqueante de un hueco. `contentHash` es el hash canónico que
 * entregó `loadMenuWeek` en esta misma carga: si el contenido cambió desde
 * entonces, el servidor responde conflict y el triaje del outbox lo señala.
 */
export function confirmMenuSlot(
  input: { householdId: string; slotId: string; contentHash: string },
  options: EnvelopeOptions = {}
): CommandEnvelopeV1<MenuConfirmPayload> {
  return createCommandEnvelope({
    ...options,
    householdId: input.householdId,
    aggregateType: 'menu_slot',
    aggregateId: input.slotId,
    payload: {
      action: 'confirm',
      slotId: input.slotId,
      contentHash: input.contentHash
    } satisfies MenuConfirmPayload
  }) as CommandEnvelopeV1<MenuConfirmPayload>;
}

/** Guarda la semana visible como plantilla con nombre («Semana de cole»…). */
export function saveMenuTemplate(
  input: { householdId: string; name: string; fromWeekStartsOn: string },
  options: EnvelopeOptions = {}
): CommandEnvelopeV1<MenuTemplateSavePayload> {
  return createCommandEnvelope({
    ...options,
    householdId: input.householdId,
    aggregateType: 'menu_template',
    payload: {
      action: 'save',
      name: input.name.trim(),
      fromWeekStartsOn: input.fromWeekStartsOn
    } satisfies MenuTemplateSavePayload
  }) as CommandEnvelopeV1<MenuTemplateSavePayload>;
}

/**
 * Aplica una plantilla sobre el lunes destino. La semana debe estar vacía: si
 * ya tiene contenido, el servidor rechaza con `week_overlap` (misma familia de
 * rechazo que el duplicado semanal) y la nota unificada lo cuenta tal cual.
 */
export function applyMenuTemplate(
  input: { householdId: string; templateId: string; toWeekStartsOn: string },
  options: EnvelopeOptions = {}
): CommandEnvelopeV1<MenuTemplateApplyPayload> {
  return createCommandEnvelope({
    ...options,
    householdId: input.householdId,
    aggregateType: 'menu_template',
    aggregateId: input.templateId,
    payload: {
      action: 'apply',
      templateId: input.templateId,
      toWeekStartsOn: input.toWeekStartsOn
    } satisfies MenuTemplateApplyPayload
  }) as CommandEnvelopeV1<MenuTemplateApplyPayload>;
}

export function deleteMenuTemplate(
  input: { householdId: string; templateId: string },
  options: EnvelopeOptions = {}
): CommandEnvelopeV1<MenuTemplateDeletePayload> {
  return createCommandEnvelope({
    ...options,
    householdId: input.householdId,
    aggregateType: 'menu_template',
    aggregateId: input.templateId,
    payload: { action: 'delete', templateId: input.templateId } satisfies MenuTemplateDeletePayload
  }) as CommandEnvelopeV1<MenuTemplateDeletePayload>;
}

export function addShoppingItem(
  input: {
    householdId: string;
    foodId?: string;
    customName?: string;
    quantity?: string;
    unit?: string;
    section?: string;
    weekStartsOn?: string;
    listKind?: ShoppingListKind;
  },
  options: EnvelopeOptions = {}
): CommandEnvelopeV1<ShoppingAddPayload> {
  const customName = trimmedOrUndefined(input.customName);
  const quantity = trimmedOrUndefined(input.quantity);
  const unit = trimmedOrUndefined(input.unit);
  const section = trimmedOrUndefined(input.section);
  return createCommandEnvelope({
    ...options,
    householdId: input.householdId,
    aggregateType: 'shopping_item',
    payload: {
      action: 'add',
      ...(input.foodId ? { foodId: input.foodId } : {}),
      ...(customName ? { customName } : {}),
      ...(quantity ? { quantity } : {}),
      ...(unit ? { unit } : {}),
      ...(section ? { section } : {}),
      ...(input.weekStartsOn ? { weekStartsOn: input.weekStartsOn } : {}),
      ...(input.listKind && input.listKind !== 'casa' ? { listKind: input.listKind } : {})
    } satisfies ShoppingAddPayload
  }) as CommandEnvelopeV1<ShoppingAddPayload>;
}

/**
 * Marca (o desmarca) una LÍNEA entera de la compra de la semana, incluida la
 * parte que viene del menú —que no tiene fila propia porque se calcula en
 * lectura—. Un solo comando idempotente por línea: dos taps rápidos no dejan
 * medio marcado, y offline se reenvía tal cual.
 */
export function setShoppingLineChecked(
  input: {
    householdId: string;
    weekStartsOn: string;
    lineKey: string;
    listKind?: ShoppingListKind;
    checked: boolean;
  },
  options: EnvelopeOptions = {}
): CommandEnvelopeV1<ShoppingSetLineCheckedPayload> {
  return createCommandEnvelope({
    ...options,
    householdId: input.householdId,
    aggregateType: 'shopping_item',
    payload: {
      action: 'set_line_checked',
      weekStartsOn: input.weekStartsOn,
      lineKey: input.lineKey,
      ...(input.listKind && input.listKind !== 'casa' ? { listKind: input.listKind } : {}),
      checked: input.checked
    } satisfies ShoppingSetLineCheckedPayload
  }) as CommandEnvelopeV1<ShoppingSetLineCheckedPayload>;
}

export function setShoppingChecked(
  input: { householdId: string; itemId: string; checked: boolean },
  options: EnvelopeOptions = {}
): CommandEnvelopeV1<ShoppingSetCheckedPayload> {
  return createCommandEnvelope({
    ...options,
    householdId: input.householdId,
    aggregateType: 'shopping_item',
    aggregateId: input.itemId,
    payload: {
      action: 'set_checked',
      itemId: input.itemId,
      checked: input.checked
    } satisfies ShoppingSetCheckedPayload
  }) as CommandEnvelopeV1<ShoppingSetCheckedPayload>;
}

export function upsertRoutine(
  input: {
    householdId: string;
    routineId?: string;
    title: string;
    details?: string;
    audience: RoutineAudience;
    frequency: RoutineFrequency;
    intervalCount: number;
    nextDueOn: string;
  },
  options: EnvelopeOptions = {}
): CommandEnvelopeV1<RoutineUpsertPayload> {
  const details = trimmedOrUndefined(input.details);
  return createCommandEnvelope({
    ...options,
    householdId: input.householdId,
    aggregateType: 'routine',
    aggregateId: input.routineId ?? null,
    payload: {
      action: 'upsert',
      ...(input.routineId ? { routineId: input.routineId } : {}),
      title: input.title.trim(),
      ...(details ? { details } : {}),
      audience: input.audience,
      frequency: input.frequency,
      intervalCount: input.intervalCount,
      nextDueOn: input.nextDueOn
    } satisfies RoutineUpsertPayload
  }) as CommandEnvelopeV1<RoutineUpsertPayload>;
}

// ─── Archivado (baja lógica reversible, solo familia) ────────────────────────
// Nada se borra: `archive` lo retira de las listas y `restore` lo devuelve. Lo
// que ya lo usaba (recetas, plantillas de menú) degrada con gracia.

export interface ArchiveTogglePayload {
  action: 'archive' | 'restore';
}

function archiveEnvelope<T extends ArchiveTogglePayload>(
  input: { householdId: string; aggregateType: 'food' | 'recipe' | 'menu_group'; aggregateId: string },
  payload: T,
  options: EnvelopeOptions
): CommandEnvelopeV1<T> {
  return createCommandEnvelope({
    ...options,
    householdId: input.householdId,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    payload
  }) as CommandEnvelopeV1<T>;
}

export function setFoodArchived(
  input: { householdId: string; foodId: string; archived: boolean },
  options: EnvelopeOptions = {}
): CommandEnvelopeV1<ArchiveTogglePayload & { foodId: string }> {
  return archiveEnvelope(
    { householdId: input.householdId, aggregateType: 'food', aggregateId: input.foodId },
    { action: input.archived ? 'archive' : 'restore', foodId: input.foodId },
    options
  );
}

export function setRecipeArchived(
  input: { householdId: string; pageId: string; archived: boolean },
  options: EnvelopeOptions = {}
): CommandEnvelopeV1<ArchiveTogglePayload & { pageId: string }> {
  return archiveEnvelope(
    { householdId: input.householdId, aggregateType: 'recipe', aggregateId: input.pageId },
    { action: input.archived ? 'archive' : 'restore', pageId: input.pageId },
    options
  );
}

export function setMenuGroupArchived(
  input: { householdId: string; groupId: string; archived: boolean },
  options: EnvelopeOptions = {}
): CommandEnvelopeV1<ArchiveTogglePayload & { groupId: string }> {
  return archiveEnvelope(
    { householdId: input.householdId, aggregateType: 'menu_group', aggregateId: input.groupId },
    { action: input.archived ? 'archive' : 'restore', groupId: input.groupId },
    options
  );
}

export type { QueueOutcome };

/**
 * Delegado del encolado unificado (`$lib/offline/queue-command`): conserva la
 * firma histórica devolviendo solo el outcome ('synced' | 'queued' |
 * 'rejected' | 'conflict'). Para el mensaje veraz completo (causa traducida de
 * un rejected/conflict) llama a `queueCommand` directamente.
 */
export async function queueFoodCommand(envelope: CommandEnvelopeV1): Promise<QueueOutcome> {
  return (await queueCommand(envelope)).outcome;
}
