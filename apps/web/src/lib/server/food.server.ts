import type { Pool } from 'pg';

import type { Role } from '@casa-clara/contracts';
import { AuthorizationError, computeMenuSlotHash, withAuthorizedTransaction } from '@casa-clara/server';

import { addQuantities, fromHundredths, scaleQuantity, toHundredths } from '$lib/food/quantities';
import { weekDays } from '$lib/food/dates';
import { getDatabasePool } from './db.server';

const FAMILY_ROLES: readonly Role[] = ['family_admin', 'family_member'];
const SHOPPING_WRITER_ROLES: readonly Role[] = ['family_admin', 'family_member', 'employee_live_in'];

export type MealSlot = 'desayuno' | 'almuerzo' | 'comida' | 'merienda' | 'cena';
export const MEAL_SLOTS: readonly MealSlot[] = ['desayuno', 'almuerzo', 'comida', 'merienda', 'cena'];

// El hash de confirmación (menu_confirmations.content_hash) tiene UNA sola
// implementación: computeMenuSlotHash de @casa-clara/server, la misma contra la
// que el comando confirm compara. La web la invoca dentro de su transacción de
// lectura; así es imposible que ambos lados divieran en el formato canónico.

function normalizeQuantity(quantity: string): string {
  const hundredths = toHundredths(quantity);
  return hundredths === null ? quantity : fromHundredths(hundredths);
}

export interface DinerFlagView {
  allergenCode: string;
  allergenName: string;
  severity: 'high' | 'medium';
  note: string;
}

export interface DinerView {
  id: string;
  name: string;
  notes: string;
  flags: DinerFlagView[];
}

export interface MenuGroupView {
  id: string;
  name: string;
  diners: DinerView[];
}

export interface RecipeIngredientView {
  foodId: string;
  name: string;
  quantity: string;
  unit: string;
  scaling: 'linear' | 'fixed';
  reviewed: boolean;
  allergenCodes: string[];
}

export interface SlotRecipeView {
  pageId: string;
  slug: string;
  title: string;
  baseServings: number;
  timeMinutes: number | null;
  ingredients: RecipeIngredientView[];
  /** Unión de alérgenos de todos sus ingredientes, con nombre en español. */
  allergens: Array<{ code: string; name: string }>;
}

export interface AllergenConflictView {
  dinerId: string;
  dinerName: string;
  allergenCode: string;
  allergenName: string;
  severity: 'high' | 'medium';
}

export interface MenuSlotView {
  id: string;
  groupId: string;
  onDate: string;
  meal: MealSlot;
  recipe: SlotRecipeView | null;
  freeText: string;
  notes: string;
  servingsOverride: number | null;
  /** Hash canónico calculado en esta misma transacción (payload de confirm). */
  contentHash: string;
  confirmation: { confirmedAt: string; contentHash: string; upToDate: boolean } | null;
  /** Choques receta ↔ restricciones de los comensales del grupo (AC-21). */
  conflicts: AllergenConflictView[];
}

export interface RecipeOptionView {
  pageId: string;
  title: string;
  baseServings: number;
  allergens: Array<{ code: string; name: string }>;
  hasUnreviewedFood: boolean;
}

export interface MenuWeek {
  householdId: string;
  role: Role;
  canWrite: boolean;
  weekStartsOn: string;
  days: string[];
  groups: MenuGroupView[];
  /** Todos los comensales del hogar (para crear/editar grupos). */
  diners: DinerView[];
  slots: MenuSlotView[];
  recipeOptions: RecipeOptionView[];
}

interface AllergenRow {
  code: string;
  name: string;
}

interface RecipeCoreRow {
  pageId: string;
  slug: string;
  title: string;
  revisionId: string | null;
  baseServings: number;
  timeMinutes: number | null;
}

interface IngredientRow {
  pageId: string;
  foodId: string;
  name: string;
  quantity: string;
  unit: string;
  scaling: 'linear' | 'fixed';
  reviewed: boolean;
  allergenCodes: string[] | null;
}

async function fetchAllergenNames(client: import('pg').PoolClient): Promise<Map<string, string>> {
  const result = await client.query<AllergenRow>(
    'select code, name_es as "name" from app.eu_allergens order by position'
  );
  return new Map(result.rows.map((row) => [row.code, row.name]));
}

async function fetchRecipes(
  client: import('pg').PoolClient,
  householdId: string,
  pageIds: string[] | null
): Promise<{ recipes: Map<string, RecipeCoreRow>; ingredients: Map<string, IngredientRow[]> }> {
  const filter = pageIds === null ? '' : 'and recipe.page_id = any($2::uuid[])';
  const params: unknown[] = pageIds === null ? [householdId] : [householdId, pageIds];
  const recipeResult = await client.query<RecipeCoreRow>(
    `select recipe.page_id as "pageId",
            page.current_slug as "slug",
            coalesce(revision.title, page.current_slug) as "title",
            page.current_revision_id as "revisionId",
            recipe.base_servings as "baseServings",
            recipe.time_minutes as "timeMinutes"
       from app.recipes as recipe
       join app.wiki_pages as page
         on page.household_id = recipe.household_id and page.id = recipe.page_id
       left join app.wiki_revisions as revision
         on revision.household_id = page.household_id and revision.id = page.current_revision_id
      where recipe.household_id = $1 and page.archived_at is null ${filter}
      order by "title"`,
    params
  );
  const ingredientResult = await client.query<IngredientRow>(
    `select ingredient.page_id as "pageId",
            ingredient.food_id as "foodId",
            food.name,
            ingredient.quantity::text as "quantity",
            ingredient.unit,
            ingredient.scaling::text as "scaling",
            food.allergens_reviewed as "reviewed",
            (select array_agg(fa.allergen_code order by fa.allergen_code)
               from app.food_allergens as fa
              where fa.household_id = ingredient.household_id and fa.food_id = ingredient.food_id
            ) as "allergenCodes"
       from app.recipe_ingredients as ingredient
       join app.foods as food
         on food.household_id = ingredient.household_id and food.id = ingredient.food_id
      where ingredient.household_id = $1 ${pageIds === null ? '' : 'and ingredient.page_id = any($2::uuid[])'}
      order by ingredient.page_id, ingredient.position, food.name`,
    params
  );
  const recipes = new Map(recipeResult.rows.map((row) => [row.pageId, row]));
  const ingredients = new Map<string, IngredientRow[]>();
  for (const row of ingredientResult.rows) {
    const list = ingredients.get(row.pageId) ?? [];
    list.push(row);
    ingredients.set(row.pageId, list);
  }
  return { recipes, ingredients };
}

async function fetchGroups(
  client: import('pg').PoolClient,
  householdId: string,
  allergenNames: Map<string, string>
): Promise<{ groups: MenuGroupView[]; diners: DinerView[] }> {
  const groupResult = await client.query<{ id: string; name: string }>(
    `select id, name from app.menu_groups
      where household_id = $1 and archived_at is null
      order by position, name`,
    [householdId]
  );
  const dinerResult = await client.query<{ id: string; name: string; notes: string }>(
    `select id, name, notes from app.diners
      where household_id = $1 and archived_at is null
      order by name`,
    [householdId]
  );
  const memberResult = await client.query<{ groupId: string; dinerId: string }>(
    `select group_id as "groupId", diner_id as "dinerId"
       from app.menu_group_diners
      where household_id = $1`,
    [householdId]
  );
  const flagResult = await client.query<{
    dinerId: string;
    allergenCode: string;
    severity: 'high' | 'medium';
    note: string;
  }>(
    `select diner_id as "dinerId", allergen_code as "allergenCode", severity, note
       from app.diner_flags
      where household_id = $1
      order by diner_id, allergen_code`,
    [householdId]
  );
  const flagsByDiner = new Map<string, DinerFlagView[]>();
  for (const flag of flagResult.rows) {
    const list = flagsByDiner.get(flag.dinerId) ?? [];
    list.push({
      allergenCode: flag.allergenCode,
      allergenName: allergenNames.get(flag.allergenCode) ?? flag.allergenCode,
      severity: flag.severity,
      note: flag.note
    });
    flagsByDiner.set(flag.dinerId, list);
  }
  const diners: DinerView[] = dinerResult.rows.map((diner) => ({
    id: diner.id,
    name: diner.name,
    notes: diner.notes,
    flags: flagsByDiner.get(diner.id) ?? []
  }));
  const dinerById = new Map(diners.map((diner) => [diner.id, diner]));
  const groups = groupResult.rows.map((group) => ({
    id: group.id,
    name: group.name,
    diners: memberResult.rows
      .filter((member) => member.groupId === group.id)
      .map((member) => dinerById.get(member.dinerId))
      .filter((diner): diner is DinerView => diner !== undefined)
      .sort((a, b) => a.name.localeCompare(b.name, 'es'))
  }));
  return { groups, diners };
}

function toSlotRecipeView(
  core: RecipeCoreRow,
  rows: IngredientRow[],
  allergenNames: Map<string, string>
): SlotRecipeView {
  const codes = new Set<string>();
  for (const row of rows) for (const code of row.allergenCodes ?? []) codes.add(code);
  return {
    pageId: core.pageId,
    slug: core.slug,
    title: core.title,
    baseServings: core.baseServings,
    timeMinutes: core.timeMinutes,
    ingredients: rows.map((row) => ({
      foodId: row.foodId,
      name: row.name,
      quantity: normalizeQuantity(row.quantity),
      unit: row.unit,
      scaling: row.scaling,
      reviewed: row.reviewed,
      allergenCodes: row.allergenCodes ?? []
    })),
    allergens: [...codes].sort().map((code) => ({ code, name: allergenNames.get(code) ?? code }))
  };
}

/**
 * Semana de menú leída de Postgres bajo RLS (familia, empleada y apoyo leen;
 * viewer recibe cero filas). El `contentHash` de cada hueco se calcula AQUÍ,
 * dentro de la misma transacción que leyó receta, revisión vigente, comensales
 * y restricciones: es el hash que la UI reenvía en menu_slot.confirm. Devuelve
 * null solo sin pool o sin membresía autorizada; la página cae a la fixture.
 */
export async function loadMenuWeek(
  user: { id: string },
  householdId: string,
  mondayISO: string,
  pool: Pool | null = getDatabasePool()
): Promise<MenuWeek | null> {
  if (!pool) return null;
  const days = weekDays(mondayISO);
  try {
    return await withAuthorizedTransaction(pool, { userId: user.id }, householdId, async (client, membership) => {
      const allergenNames = await fetchAllergenNames(client);
      const { groups, diners } = await fetchGroups(client, householdId, allergenNames);

      const slotResult = await client.query<{
        id: string;
        groupId: string;
        onDate: string;
        meal: MealSlot;
        recipePageId: string | null;
        freeText: string;
        notes: string;
        servingsOverride: number | null;
      }>(
        `select id,
                group_id as "groupId",
                on_date::text as "onDate",
                meal::text as "meal",
                recipe_page_id as "recipePageId",
                free_text as "freeText",
                notes,
                servings_override as "servingsOverride"
           from app.menu_slots
          where household_id = $1 and on_date between $2 and $3
          order by on_date, group_id, meal`,
        [householdId, days[0], days[6]]
      );

      const confirmationResult = await client.query<{
        slotId: string;
        contentHash: string;
        confirmedAt: Date;
      }>(
        `select slot_id as "slotId", content_hash as "contentHash", confirmed_at as "confirmedAt"
           from app.menu_confirmations
          where household_id = $1`,
        [householdId]
      );
      const confirmations = new Map(confirmationResult.rows.map((row) => [row.slotId, row]));

      const { recipes, ingredients } = await fetchRecipes(client, householdId, null);
      const groupById = new Map(groups.map((group) => [group.id, group]));

      const slotHashes = new Map<string, string>();
      for (const slot of slotResult.rows) {
        const hash = await computeMenuSlotHash(client, householdId, slot.id);
        if (hash) slotHashes.set(slot.id, hash);
      }

      const slots: MenuSlotView[] = slotResult.rows.map((slot) => {
        const group = groupById.get(slot.groupId);
        const core = slot.recipePageId ? (recipes.get(slot.recipePageId) ?? null) : null;
        const ingredientRows = core ? (ingredients.get(core.pageId) ?? []) : [];
        const recipe = core ? toSlotRecipeView(core, ingredientRows, allergenNames) : null;

        const contentHash = slotHashes.get(slot.id) ?? '';

        const stored = confirmations.get(slot.id) ?? null;
        const recipeCodes = new Set(recipe?.allergens.map((entry) => entry.code) ?? []);
        const conflicts: AllergenConflictView[] = (group?.diners ?? []).flatMap((diner) =>
          diner.flags
            .filter((flag) => recipeCodes.has(flag.allergenCode))
            .map((flag) => ({
              dinerId: diner.id,
              dinerName: diner.name,
              allergenCode: flag.allergenCode,
              allergenName: flag.allergenName,
              severity: flag.severity
            }))
        );

        return {
          id: slot.id,
          groupId: slot.groupId,
          onDate: slot.onDate,
          meal: slot.meal,
          recipe,
          freeText: slot.freeText,
          notes: slot.notes,
          servingsOverride: slot.servingsOverride,
          contentHash,
          confirmation: stored
            ? {
                confirmedAt: stored.confirmedAt.toISOString(),
                contentHash: stored.contentHash,
                upToDate: stored.contentHash === contentHash
              }
            : null,
          conflicts
        };
      });

      const recipeOptions: RecipeOptionView[] = [...recipes.values()].map((core) => {
        const rows = ingredients.get(core.pageId) ?? [];
        const codes = new Set<string>();
        for (const row of rows) for (const code of row.allergenCodes ?? []) codes.add(code);
        return {
          pageId: core.pageId,
          title: core.title,
          baseServings: core.baseServings,
          allergens: [...codes].sort().map((code) => ({ code, name: allergenNames.get(code) ?? code })),
          hasUnreviewedFood: rows.some((row) => !row.reviewed)
        };
      });

      return {
        householdId,
        role: membership.role,
        canWrite: FAMILY_ROLES.includes(membership.role),
        weekStartsOn: mondayISO,
        days,
        groups,
        diners,
        slots,
        recipeOptions
      } satisfies MenuWeek;
    });
  } catch (cause) {
    if (!(cause instanceof AuthorizationError)) {
      console.error('menu week unavailable', cause);
    }
    return null;
  }
}

export interface RecipeDetail {
  householdId: string;
  role: Role;
  canWrite: boolean;
  pageId: string;
  slug: string;
  title: string;
  baseServings: number;
  timeMinutes: number | null;
  ingredients: Array<RecipeIngredientView & { allergenNames: string[] }>;
  allergens: Array<{ code: string; name: string }>;
}

/** Ficha estructurada de una receta (extensión 1:1 de su página wiki). */
export async function loadRecipe(
  user: { id: string },
  householdId: string,
  pageId: string,
  pool: Pool | null = getDatabasePool()
): Promise<RecipeDetail | null> {
  if (!pool) return null;
  try {
    return await withAuthorizedTransaction(pool, { userId: user.id }, householdId, async (client, membership) => {
      const allergenNames = await fetchAllergenNames(client);
      const { recipes, ingredients } = await fetchRecipes(client, householdId, [pageId]);
      const core = recipes.get(pageId);
      if (!core) return null;
      const view = toSlotRecipeView(core, ingredients.get(pageId) ?? [], allergenNames);
      return {
        householdId,
        role: membership.role,
        canWrite: FAMILY_ROLES.includes(membership.role),
        pageId: view.pageId,
        slug: view.slug,
        title: view.title,
        baseServings: view.baseServings,
        timeMinutes: view.timeMinutes,
        ingredients: view.ingredients.map((ingredient) => ({
          ...ingredient,
          allergenNames: ingredient.allergenCodes.map((code) => allergenNames.get(code) ?? code)
        })),
        allergens: view.allergens
      } satisfies RecipeDetail;
    });
  } catch (cause) {
    if (!(cause instanceof AuthorizationError)) {
      console.error('recipe unavailable', cause);
    }
    return null;
  }
}

export interface ShoppingEntryView {
  kind: 'derived' | 'manual';
  /** Solo los añadidos manuales tienen fila propia que marcar (set_checked). */
  itemId: string | null;
  foodId: string | null;
  name: string;
  quantity: string | null;
  unit: string | null;
  checked: boolean;
  /** Cantidad con al menos un ingrediente 'fixed' sin escalar dentro. */
  includesFixed: boolean;
}

export interface ShoppingSectionView {
  section: string;
  entries: ShoppingEntryView[];
}

export interface ShoppingList {
  householdId: string;
  role: Role;
  weekStartsOn: string;
  /** Compra: familia y empleada escriben (política shopping_write). */
  canWrite: boolean;
  sections: ShoppingSectionView[];
  /** Alimentos del catálogo para el alta manual con sección precargada. */
  foods: Array<{ id: string; name: string; section: string }>;
}

/**
 * Lista de compra semanal: parte derivada del menú (ingredientes de las
 * recetas asignadas, escalados linealmente al nº de comensales del grupo —o al
 * servings_override— frente a base_servings con aritmética decimal exacta;
 * los 'fixed' entran intactos) más los añadidos manuales de la semana (y los
 * sin semana). Agregado por alimento+unidad dentro de cada sección.
 */
export async function loadShoppingList(
  user: { id: string },
  householdId: string,
  mondayISO: string,
  pool: Pool | null = getDatabasePool()
): Promise<ShoppingList | null> {
  if (!pool) return null;
  const days = weekDays(mondayISO);
  try {
    return await withAuthorizedTransaction(pool, { userId: user.id }, householdId, async (client, membership) => {
      const slotResult = await client.query<{
        groupId: string;
        recipePageId: string;
        servingsOverride: number | null;
      }>(
        `select group_id as "groupId",
                recipe_page_id as "recipePageId",
                servings_override as "servingsOverride"
           from app.menu_slots
          where household_id = $1 and on_date between $2 and $3 and recipe_page_id is not null`,
        [householdId, days[0], days[6]]
      );

      const dinerCountResult = await client.query<{ groupId: string; diners: number }>(
        `select member.group_id as "groupId", count(*)::int as "diners"
           from app.menu_group_diners as member
           join app.diners as diner
             on diner.household_id = member.household_id and diner.id = member.diner_id
          where member.household_id = $1 and diner.archived_at is null
          group by member.group_id`,
        [householdId]
      );
      const dinersByGroup = new Map(dinerCountResult.rows.map((row) => [row.groupId, row.diners]));

      const pageIds = [...new Set(slotResult.rows.map((row) => row.recipePageId))];
      const { recipes, ingredients } = await fetchRecipes(
        client,
        householdId,
        pageIds.length > 0 ? pageIds : ['00000000-0000-4000-8000-000000000000']
      );

      const foodResult = await client.query<{ id: string; name: string; section: string }>(
        `select id, name, shopping_section as "section"
           from app.foods
          where household_id = $1 and archived_at is null
          order by name`,
        [householdId]
      );
      const foodSection = new Map(foodResult.rows.map((row) => [row.id, row.section]));

      // Agregado derivado por (alimento, unidad): suma exacta en centésimas.
      const derived = new Map<
        string,
        { foodId: string; name: string; unit: string; section: string; total: string; includesFixed: boolean }
      >();
      for (const slot of slotResult.rows) {
        const core = recipes.get(slot.recipePageId);
        if (!core) continue;
        const servings = slot.servingsOverride ?? dinersByGroup.get(slot.groupId) ?? 0;
        const effectiveServings = servings > 0 ? servings : core.baseServings;
        for (const ingredient of ingredients.get(core.pageId) ?? []) {
          const amount =
            ingredient.scaling === 'fixed'
              ? normalizeQuantity(ingredient.quantity)
              : scaleQuantity(ingredient.quantity, effectiveServings, core.baseServings);
          if (amount === null) continue;
          const key = `${ingredient.foodId}::${ingredient.unit}`;
          const existing = derived.get(key);
          if (!existing) {
            derived.set(key, {
              foodId: ingredient.foodId,
              name: ingredient.name,
              unit: ingredient.unit,
              section: foodSection.get(ingredient.foodId) ?? 'despensa',
              total: amount,
              includesFixed: ingredient.scaling === 'fixed'
            });
          } else {
            existing.total = addQuantities(existing.total, amount) ?? existing.total;
            existing.includesFixed = existing.includesFixed || ingredient.scaling === 'fixed';
          }
        }
      }

      const manualResult = await client.query<{
        id: string;
        foodId: string | null;
        customName: string | null;
        foodName: string | null;
        quantity: string | null;
        unit: string | null;
        section: string;
        checkedAt: Date | null;
      }>(
        `select item.id,
                item.food_id as "foodId",
                item.custom_name as "customName",
                food.name as "foodName",
                item.quantity::text as "quantity",
                item.unit,
                item.section,
                item.checked_at as "checkedAt"
           from app.shopping_items as item
           left join app.foods as food
             on food.household_id = item.household_id and food.id = item.food_id
          where item.household_id = $1
            and (item.week_starts_on = $2 or item.week_starts_on is null)
          order by item.created_at`,
        [householdId, mondayISO]
      );

      const sections = new Map<string, ShoppingEntryView[]>();
      const push = (section: string, entry: ShoppingEntryView): void => {
        const list = sections.get(section) ?? [];
        list.push(entry);
        sections.set(section, list);
      };
      for (const entry of [...derived.values()].sort((a, b) => a.name.localeCompare(b.name, 'es'))) {
        push(entry.section, {
          kind: 'derived',
          itemId: null,
          foodId: entry.foodId,
          name: entry.name,
          quantity: entry.total,
          unit: entry.unit,
          checked: false,
          includesFixed: entry.includesFixed
        });
      }
      for (const row of manualResult.rows) {
        push(row.section, {
          kind: 'manual',
          itemId: row.id,
          foodId: row.foodId,
          name: row.foodName ?? row.customName ?? '',
          quantity: row.quantity ? normalizeQuantity(row.quantity) : null,
          unit: row.unit,
          checked: row.checkedAt !== null,
          includesFixed: false
        });
      }

      return {
        householdId,
        role: membership.role,
        weekStartsOn: mondayISO,
        canWrite: SHOPPING_WRITER_ROLES.includes(membership.role),
        sections: [...sections.entries()]
          .sort(([a], [b]) => a.localeCompare(b, 'es'))
          .map(([section, entries]) => ({ section, entries })),
        foods: foodResult.rows
      } satisfies ShoppingList;
    });
  } catch (cause) {
    if (!(cause instanceof AuthorizationError)) {
      console.error('shopping list unavailable', cause);
    }
    return null;
  }
}

export interface FoodCatalogEntry {
  id: string;
  name: string;
  section: string;
  reviewed: boolean;
  allergenCodes: string[];
}

export interface FoodCatalog {
  householdId: string;
  role: Role;
  /** Catálogo y comensales: solo la familia escribe (RLS family_role). */
  canWrite: boolean;
  allergens: Array<{ code: string; name: string }>;
  foods: FoodCatalogEntry[];
  diners: DinerView[];
  recipes: Array<{
    pageId: string;
    slug: string;
    title: string;
    baseServings: number;
    timeMinutes: number | null;
    ingredientCount: number;
    allergens: Array<{ code: string; name: string }>;
    hasUnreviewedFood: boolean;
  }>;
}

/** Alimentos con alérgenos y estado de revisión, comensales con sus flags y recetario. */
export async function loadFoodCatalog(
  user: { id: string },
  householdId: string,
  pool: Pool | null = getDatabasePool()
): Promise<FoodCatalog | null> {
  if (!pool) return null;
  try {
    return await withAuthorizedTransaction(pool, { userId: user.id }, householdId, async (client, membership) => {
      const allergenNames = await fetchAllergenNames(client);
      const foodResult = await client.query<{
        id: string;
        name: string;
        section: string;
        reviewed: boolean;
        allergenCodes: string[] | null;
      }>(
        `select food.id,
                food.name,
                food.shopping_section as "section",
                food.allergens_reviewed as "reviewed",
                (select array_agg(fa.allergen_code order by fa.allergen_code)
                   from app.food_allergens as fa
                  where fa.household_id = food.household_id and fa.food_id = food.id
                ) as "allergenCodes"
           from app.foods as food
          where food.household_id = $1 and food.archived_at is null
          order by food.name`,
        [householdId]
      );

      const dinerResult = await client.query<{ id: string; name: string; notes: string }>(
        `select id, name, notes from app.diners
          where household_id = $1 and archived_at is null
          order by name`,
        [householdId]
      );
      const flagResult = await client.query<{
        dinerId: string;
        allergenCode: string;
        severity: 'high' | 'medium';
        note: string;
      }>(
        `select diner_id as "dinerId", allergen_code as "allergenCode", severity, note
           from app.diner_flags
          where household_id = $1
          order by diner_id, allergen_code`,
        [householdId]
      );

      const { recipes, ingredients } = await fetchRecipes(client, householdId, null);

      return {
        householdId,
        role: membership.role,
        canWrite: FAMILY_ROLES.includes(membership.role),
        allergens: [...allergenNames.entries()].map(([code, name]) => ({ code, name })),
        foods: foodResult.rows.map((row) => ({
          id: row.id,
          name: row.name,
          section: row.section,
          reviewed: row.reviewed,
          allergenCodes: row.allergenCodes ?? []
        })),
        diners: dinerResult.rows.map((diner) => ({
          id: diner.id,
          name: diner.name,
          notes: diner.notes,
          flags: flagResult.rows
            .filter((flag) => flag.dinerId === diner.id)
            .map((flag) => ({
              allergenCode: flag.allergenCode,
              allergenName: allergenNames.get(flag.allergenCode) ?? flag.allergenCode,
              severity: flag.severity,
              note: flag.note
            }))
        })),
        recipes: [...recipes.values()].map((core) => {
          const rows = ingredients.get(core.pageId) ?? [];
          const codes = new Set<string>();
          for (const row of rows) for (const code of row.allergenCodes ?? []) codes.add(code);
          return {
            pageId: core.pageId,
            slug: core.slug,
            title: core.title,
            baseServings: core.baseServings,
            timeMinutes: core.timeMinutes,
            ingredientCount: rows.length,
            allergens: [...codes].sort().map((code) => ({ code, name: allergenNames.get(code) ?? code })),
            hasUnreviewedFood: rows.some((row) => !row.reviewed)
          };
        })
      } satisfies FoodCatalog;
    });
  } catch (cause) {
    if (!(cause instanceof AuthorizationError)) {
      console.error('food catalog unavailable', cause);
    }
    return null;
  }
}

export interface RoutineView {
  id: string;
  title: string;
  details: string;
  audience: 'family' | 'employee' | 'all';
  frequency: 'daily' | 'weekly' | 'monthly' | 'quarterly';
  intervalCount: number;
  nextDueOn: string;
  /** La ocurrencia vigente (due_on = next_due_on) ya está completada. */
  completedCurrent: boolean;
}

export interface RoutinesOverview {
  householdId: string;
  role: Role;
  canWrite: boolean;
  routines: RoutineView[];
}

/**
 * Rutinas visibles para el rol (RLS filtra por audiencia) con su próxima fecha
 * y si la ocurrencia vigente está completada. Deliberadamente SIN porcentajes
 * ni histórico de rendimiento (AC-26): solo el estado de la ocurrencia actual.
 */
export async function loadRoutines(
  user: { id: string },
  householdId: string,
  pool: Pool | null = getDatabasePool()
): Promise<RoutinesOverview | null> {
  if (!pool) return null;
  try {
    return await withAuthorizedTransaction(pool, { userId: user.id }, householdId, async (client, membership) => {
      const result = await client.query<{
        id: string;
        title: string;
        details: string;
        audience: RoutineView['audience'];
        frequency: RoutineView['frequency'];
        intervalCount: number;
        nextDueOn: string;
        completedCurrent: boolean;
      }>(
        `select routine.id,
                routine.title,
                routine.details,
                routine.audience::text as "audience",
                routine.frequency::text as "frequency",
                routine.interval_count as "intervalCount",
                routine.next_due_on::text as "nextDueOn",
                exists (
                  select 1 from app.routine_completions as completion
                   where completion.household_id = routine.household_id
                     and completion.routine_id = routine.id
                     and completion.due_on = routine.next_due_on
                ) as "completedCurrent"
           from app.routines as routine
          where routine.household_id = $1 and routine.archived_at is null
          order by routine.next_due_on, routine.title`,
        [householdId]
      );
      return {
        householdId,
        role: membership.role,
        canWrite: FAMILY_ROLES.includes(membership.role),
        routines: result.rows
      } satisfies RoutinesOverview;
    });
  } catch (cause) {
    if (!(cause instanceof AuthorizationError)) {
      console.error('routines unavailable', cause);
    }
    return null;
  }
}
