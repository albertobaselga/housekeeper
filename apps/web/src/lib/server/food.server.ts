import type { Pool } from 'pg';

import type { Role } from '@casa-clara/contracts';
import {
  PENDING_LOOKBACK_DAYS,
  nextOccurrenceOnOrAfter,
  pendingFor,
  type RoutineOverduePolicy,
  type RoutineSchedule
} from '@casa-clara/domain';
import {
  buildShoppingBoard,
  createLogger,
  computeMenuSlotHash,
  withAuthorizedTransaction,
  type ShoppingLine,
  type ShoppingSection
} from '@casa-clara/server';

import { fromHundredths, toHundredths } from '$lib/food/quantities';
import { weekDays } from '$lib/food/dates';
import { unreadable } from './data-source.server';
import { getDatabasePool } from './db.server';

const log = createLogger('web:food');

/** Hoy en la zona del hogar: el mismo criterio que Hoy y el calendario. */
const MADRID_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' });

const FAMILY_ROLES: readonly Role[] = ['family_admin', 'family_member'];
const SHOPPING_WRITER_ROLES: readonly Role[] = ['family_admin', 'family_member', 'employee_live_in'];
/** Lista «Personal» de la interna (Anexo H): ella y la administración. */
const PERSONAL_SHOPPING_ROLES: readonly Role[] = ['family_admin', 'employee_live_in'];

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

export interface MenuTemplateView {
  id: string;
  name: string;
  /** Lunes de la semana origen de la que se capturó. */
  sourceWeekStartsOn: string;
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
  /** Semanas plantilla guardadas con nombre («Semana de cole»…). */
  templates: MenuTemplateView[];
  /** Grupos archivados, para poder recuperarlos desde la lista plegada. */
  archivedGroups: Array<{ id: string; name: string }>;
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
      where recipe.household_id = $1
        and recipe.archived_at is null and page.archived_at is null ${filter}
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

      const archivedGroupResult = await client.query<{ id: string; name: string }>(
        `select id, name from app.menu_groups
          where household_id = $1 and archived_at is not null
          order by name`,
        [householdId]
      );

      const templateResult = await client.query<{ id: string; name: string; sourceWeekStartsOn: string }>(
        `select id, name, source_week_starts_on::text as "sourceWeekStartsOn"
           from app.menu_week_templates
          where household_id = $1
          order by name`,
        [householdId]
      );

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
        recipeOptions,
        templates: templateResult.rows,
        archivedGroups: archivedGroupResult.rows
      } satisfies MenuWeek;
    });
  } catch (cause) {
    return unreadable(log, 'menu week', cause);
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
    return unreadable(log, 'recipe', cause);
  }
}

export type { ShoppingLine, ShoppingPart, ShoppingSection } from '@casa-clara/server';

export interface ShoppingList {
  householdId: string;
  role: Role;
  weekStartsOn: string;
  /** Compra de casa: familia y empleada escriben (política shopping_write). */
  canWrite: boolean;
  /**
   * Lista «Personal» de la interna: solo se ofrece a la propia empleada y a la
   * administración familiar. La RLS ya impide leer sus filas a los demás; esto
   * decide únicamente si la sección aparece en la pantalla.
   */
  canUsePersonal: boolean;
  sections: ShoppingSection[];
  personal: ShoppingLine[];
  /** Alimentos del catálogo para el alta manual con sección precargada. */
  foods: Array<{ id: string; name: string; section: string }>;
}

/**
 * Lista de compra semanal ya fusionada, tal como se ve. Toda la regla vive en
 * `buildShoppingBoard` (@casa-clara/server): parte derivada del menú calculada
 * en lectura y escalada con aritmética decimal exacta, añadidos a mano
 * fusionados en la misma línea cuando son el mismo alimento, redondeo a
 * paquetes cuando el alimento lo declara y marcado por línea (que es lo que
 * permite marcar también lo que viene del menú).
 */
export async function loadShoppingList(
  user: { id: string },
  householdId: string,
  mondayISO: string,
  pool: Pool | null = getDatabasePool()
): Promise<ShoppingList | null> {
  if (!pool) return null;
  try {
    return await withAuthorizedTransaction(pool, { userId: user.id }, householdId, async (client, membership) => {
      const board = await buildShoppingBoard(client, householdId, mondayISO);
      const foodResult = await client.query<{ id: string; name: string; section: string }>(
        `select id, name, shopping_section as "section"
           from app.foods
          where household_id = $1 and archived_at is null
          order by name`,
        [householdId]
      );

      return {
        householdId,
        role: membership.role,
        weekStartsOn: mondayISO,
        canWrite: SHOPPING_WRITER_ROLES.includes(membership.role),
        canUsePersonal: PERSONAL_SHOPPING_ROLES.includes(membership.role),
        sections: board.sections,
        personal: board.personal,
        foods: foodResult.rows
      } satisfies ShoppingList;
    });
  } catch (cause) {
    return unreadable(log, 'shopping list', cause);
  }
}

export interface FoodCatalogEntry {
  id: string;
  name: string;
  section: string;
  reviewed: boolean;
  allergenCodes: string[];
  /** Tamaño del paquete con el que se compra («500 g»); null si no se fijó. */
  packaging: { size: string; unit: string } | null;
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
  /** Archivados, para la lista plegada desde la que se recuperan. */
  archivedFoods: Array<{ id: string; name: string }>;
  archivedRecipes: Array<{ pageId: string; title: string }>;
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
        packageSize: string | null;
        packageUnit: string | null;
      }>(
        `select food.id,
                food.name,
                food.shopping_section as "section",
                food.allergens_reviewed as "reviewed",
                food.package_size::text as "packageSize",
                food.package_unit as "packageUnit",
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

      const archivedFoodResult = await client.query<{ id: string; name: string }>(
        `select id, name from app.foods
          where household_id = $1 and archived_at is not null
          order by name`,
        [householdId]
      );
      const archivedRecipeResult = await client.query<{ pageId: string; title: string }>(
        `select recipe.page_id as "pageId",
                coalesce(revision.title, page.current_slug) as "title"
           from app.recipes as recipe
           join app.wiki_pages as page
             on page.household_id = recipe.household_id and page.id = recipe.page_id
           left join app.wiki_revisions as revision
             on revision.household_id = page.household_id and revision.id = page.current_revision_id
          where recipe.household_id = $1 and recipe.archived_at is not null
          order by "title"`,
        [householdId]
      );

      return {
        householdId,
        role: membership.role,
        canWrite: FAMILY_ROLES.includes(membership.role),
        allergens: [...allergenNames.entries()].map(([code, name]) => ({ code, name })),
        archivedFoods: archivedFoodResult.rows,
        archivedRecipes: archivedRecipeResult.rows,
        foods: foodResult.rows.map((row) => ({
          id: row.id,
          name: row.name,
          section: row.section,
          reviewed: row.reviewed,
          allergenCodes: row.allergenCodes ?? [],
          packaging:
            row.packageSize && row.packageUnit
              ? { size: normalizeQuantity(row.packageSize), unit: row.packageUnit }
              : null
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
    return unreadable(log, 'food catalog', cause);
  }
}

export interface RoutineView {
  id: string;
  title: string;
  details: string;
  audience: 'family' | 'employee' | 'all';
  /**
   * La cadencia rica de la 0023. `null` significa «se hace, falta decidir
   * cuándo» (§2.3): la rutina se ve AQUÍ y jamás en Hoy, en el calendario, en
   * el ICS ni en los avisos.
   */
  schedule: RoutineSchedule;
  /**
   * Primera ocurrencia pendiente, ya resuelta por el motor. NO es la columna
   * `next_due_hint`: desde la 0023 esa columna es una caché que solo garantiza
   * ser cota inferior (§2.7), así que sirve para prefiltrar en SQL y no para
   * enseñar. Se llamó `next_due_on` hasta la 0033, cuando el nombre dejó de
   * sugerir que fuera un estado.
   */
  nextOccurrenceOn: string | null;
  /**
   * Qué ocurrencia marcaría «Marcar hecha» desde esta página: la atrasada si la
   * hay, si no la de hoy. `null` = hoy no hay nada que marcar.
   */
  actionableDueOn: string | null;
  /**
   * Qué quedaría pendiente después de marcar `actionableDueOn`. Lo calcula el
   * servidor para que el chip optimista prometa la MISMA fecha que confirmará
   * el ACK, en vez de que el navegador vuelva a derivarla por su cuenta.
   */
  nextAfterActionOn: string | null;
  /** Hoy es ocurrencia de esta rutina y ya está marcada. */
  completedToday: boolean;
}

export interface RoutinesOverview {
  householdId: string;
  role: Role;
  canWrite: boolean;
  /** Hoy en la zona del hogar, para que el formulario no lo adivine. */
  todayISO: string;
  routines: RoutineView[];
}

/** Fila de patrón de `app.routines` → regla del generador. */
function scheduleFromRow(row: {
  pattern: string | null;
  anchorOn: string | null;
  repeatEvery: number | null;
  weekdays: number[] | null;
  monthDay: number | null;
  months: number[] | null;
  endsOn: string | null;
}): RoutineSchedule {
  // La CHECK `routines_pattern_shape` de la 0023 hace imposible que a un patrón
  // le falte una de sus columnas. Si aun así llegara una fila incoherente, esta
  // pantalla la trata como «sin cadencia» en vez de reventar la carga entera:
  // se ve, se puede editar y se le puede poner día, que es la salida útil.
  if (row.pattern === null || row.anchorOn === null) return null;
  const anchorOn = row.anchorOn;
  const endsOn = row.endsOn;
  switch (row.pattern) {
    case 'every_n_days':
      return row.repeatEvery === null
        ? null
        : { pattern: 'every_n_days', anchorOn, repeatEvery: row.repeatEvery, endsOn };
    case 'days_of_week':
      return row.repeatEvery === null || row.weekdays === null
        ? null
        : {
            pattern: 'days_of_week',
            anchorOn,
            repeatEvery: row.repeatEvery,
            weekdays: row.weekdays,
            endsOn
          };
    case 'day_of_month':
      return row.repeatEvery === null || row.monthDay === null
        ? null
        : {
            pattern: 'day_of_month',
            anchorOn,
            repeatEvery: row.repeatEvery,
            monthDay: row.monthDay,
            endsOn
          };
    case 'months_of_year':
      return row.months === null || row.monthDay === null
        ? null
        : { pattern: 'months_of_year', anchorOn, months: row.months, monthDay: row.monthDay, endsOn };
    default:
      return null;
  }
}

/**
 * Rutinas visibles para el rol (RLS filtra por audiencia) con su cadencia y su
 * próxima ocurrencia. Deliberadamente SIN porcentajes, rachas ni medias
 * (AC-26 revisado): esta página enseña qué ritmo tiene cada cosa, no cuánto
 * cumple nadie.
 *
 * Las ocurrencias se calculan con el motor puro y NO se leen de `next_due_hint`,
 * que desde la 0023 es una caché con garantía de cota inferior (§2.7). El
 * cálculo es del orden de 40 reglas × una ventana corta: microsegundos.
 */
export async function loadRoutines(
  user: { id: string },
  householdId: string,
  pool: Pool | null = getDatabasePool(),
  todayISO: string = MADRID_DATE.format(new Date())
): Promise<RoutinesOverview | null> {
  if (!pool) return null;
  try {
    return await withAuthorizedTransaction(pool, { userId: user.id }, householdId, async (client, membership) => {
      const result = await client.query<{
        id: string;
        title: string;
        details: string;
        audience: RoutineView['audience'];
        pattern: string | null;
        anchorOn: string | null;
        repeatEvery: number | null;
        weekdays: number[] | null;
        monthDay: number | null;
        months: number[] | null;
        endsOn: string | null;
        overduePolicy: RoutineOverduePolicy;
        completedDueOns: string[] | null;
      }>(
        // Las finalizaciones vienen agregadas por rutina y acotadas a la ventana
        // que mira `pendingFor`: sin el corte, un hogar con años de historia
        // arrastraría miles de filas para decidir si hoy queda algo por hacer.
        `select routine.id,
                routine.title,
                routine.details,
                routine.audience::text as "audience",
                routine.pattern::text as "pattern",
                routine.anchor_on::text as "anchorOn",
                routine.repeat_every as "repeatEvery",
                routine.weekdays as "weekdays",
                routine.month_day as "monthDay",
                routine.months as "months",
                routine.ends_on::text as "endsOn",
                routine.overdue_policy::text as "overduePolicy",
                (
                  select array_agg(completion.due_on::text)
                    from app.routine_completions as completion
                   where completion.household_id = routine.household_id
                     and completion.routine_id = routine.id
                     and completion.due_on between $2::date - $3::int and $2::date
                ) as "completedDueOns"
           from app.routines as routine
          where routine.household_id = $1 and routine.archived_at is null
          order by routine.title`,
        [householdId, todayISO, PENDING_LOOKBACK_DAYS]
      );
      const routines = result.rows.map((row) => {
        const schedule = scheduleFromRow(row);
        const completedDueOns = row.completedDueOns ?? [];
        const pending = pendingFor(schedule, row.overduePolicy, new Set(completedDueOns), todayISO);
        // Marcar resuelve primero lo atrasado; entonces lo de hoy sigue vivo y
        // es lo próximo. Si se marca lo de hoy, lo próximo es la siguiente.
        const actionableDueOn = pending.overdue ?? pending.due[0] ?? null;
        const nextAfterActionOn =
          (pending.overdue === null ? pending.upcoming[0] : (pending.due[0] ?? pending.upcoming[0])) ??
          null;
        // Una finalización HUÉRFANA —cuyo `due_on` dejó de ser ocurrencia
        // porque la regla cambió— no se pinta. No se borra ni se toca: es un
        // hecho, y el comando acepta a propósito los `dueOn` que llegan de un
        // cliente que quedó con la regla anterior. Simplemente no se enseña.
        const todayIsOccurrence = nextOccurrenceOnOrAfter(schedule, todayISO) === todayISO;
        return {
          id: row.id,
          title: row.title,
          details: row.details,
          audience: row.audience,
          schedule,
          nextOccurrenceOn: pending.nextDueHint,
          actionableDueOn,
          nextAfterActionOn,
          completedToday: todayIsOccurrence && completedDueOns.includes(todayISO)
        } satisfies RoutineView;
      });
      return {
        householdId,
        role: membership.role,
        canWrite: FAMILY_ROLES.includes(membership.role),
        todayISO,
        routines
      } satisfies RoutinesOverview;
    });
  } catch (cause) {
    return unreadable(log, 'routines', cause);
  }
}
