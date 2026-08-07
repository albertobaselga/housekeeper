import type { PoolClient } from "pg";

import type { UUID } from "@casa-clara/contracts";

import { canonicalSha256 } from "./canonical-json.js";

interface MenuSlotRow {
  group_id: string;
  recipe_page_id: string | null;
  free_text: string;
  servings_override: number | null;
}

interface IngredientRow {
  food_id: string;
  quantity: string;
  unit: string;
  scaling: string;
}

interface RecipeContent {
  pageId: UUID;
  /** Revisión vigente de la página wiki: editar la receta narrativa cambia el hash. */
  revisionId: UUID | null;
  baseServings: number | null;
  ingredients: Array<{ foodId: UUID; quantity: string; unit: string; scaling: string }>;
}

/**
 * sha-256 canónico del contenido de un hueco de menú, base de la confirmación
 * bloqueante (AC-21/AC-23): receta (page_id + revisión wiki vigente +
 * ingredientes ordenados por food_id) o texto libre, grupo (dinerIds ordenados)
 * y DietaryFlags de cada comensal del grupo (allergenCode + severity ordenados).
 * Cualquier cambio en la receta, en la composición del grupo o en las
 * restricciones de un comensal produce un hash distinto, con lo que la
 * confirmación previa deja de coincidir y se exige revalidar.
 *
 * Devuelve `null` si el hueco no existe (o no es visible bajo RLS).
 */
export async function computeMenuSlotHash(
  client: PoolClient,
  householdId: UUID,
  slotId: UUID,
): Promise<string | null> {
  const slotResult = await client.query<MenuSlotRow>(
    `select group_id, recipe_page_id, free_text, servings_override
       from app.menu_slots
      where household_id = $1 and id = $2`,
    [householdId, slotId],
  );
  const slot = slotResult.rows[0];
  if (!slot) return null;

  let recipe: RecipeContent | null = null;
  if (slot.recipe_page_id !== null) {
    const head = await client.query<{ base_servings: number; current_revision_id: string | null }>(
      `select recipe.base_servings, page.current_revision_id
         from app.recipes as recipe
         join app.wiki_pages as page
           on page.household_id = recipe.household_id and page.id = recipe.page_id
        where recipe.household_id = $1 and recipe.page_id = $2`,
      [householdId, slot.recipe_page_id],
    );
    const ingredients = await client.query<IngredientRow>(
      `select food_id, quantity::text as quantity, unit, scaling
         from app.recipe_ingredients
        where household_id = $1 and page_id = $2
        order by food_id`,
      [householdId, slot.recipe_page_id],
    );
    recipe = {
      pageId: slot.recipe_page_id,
      revisionId: head.rows[0]?.current_revision_id ?? null,
      baseServings: head.rows[0]?.base_servings ?? null,
      ingredients: ingredients.rows.map((row) => ({
        foodId: row.food_id,
        quantity: row.quantity,
        unit: row.unit,
        scaling: row.scaling,
      })),
    };
  }

  const diners = await client.query<{ diner_id: string }>(
    `select diner_id
       from app.menu_group_diners
      where household_id = $1 and group_id = $2
      order by diner_id`,
    [householdId, slot.group_id],
  );
  const flags = await client.query<{ diner_id: string; allergen_code: string; severity: string }>(
    `select flag.diner_id, flag.allergen_code, flag.severity
       from app.diner_flags as flag
       join app.menu_group_diners as member
         on member.household_id = flag.household_id and member.diner_id = flag.diner_id
      where flag.household_id = $1 and member.group_id = $2
      order by flag.diner_id, flag.allergen_code`,
    [householdId, slot.group_id],
  );

  return canonicalSha256({
    version: 1,
    freeText: slot.free_text,
    servingsOverride: slot.servings_override,
    recipe,
    group: { id: slot.group_id, dinerIds: diners.rows.map((row) => row.diner_id) },
    flags: flags.rows.map((row) => ({
      dinerId: row.diner_id,
      allergenCode: row.allergen_code,
      severity: row.severity,
    })),
  });
}
