import type { PoolClient } from "pg";

import type { UUID } from "@casa-clara/contracts";
import {
  dinerUpsertPayloadSchema,
  foodUpsertPayloadSchema,
  recipeSetDetailsPayloadSchema,
} from "@casa-clara/contracts/schemas";

import { CommandRejectedError, type CommandHandler } from "../sync.js";

const FAMILY_ROLES = new Set(["family_admin", "family_member"]);

export function requireFamilyRole(role: string, what: string): void {
  if (!FAMILY_ROLES.has(role)) {
    throw new CommandRejectedError("not_allowed", `Solo la familia gestiona ${what}`);
  }
}

/** Normaliza una cantidad del contrato (`"1,5"` o `"1.5"`) al punto decimal de SQL. */
export function normalizeQuantity(value: string): string {
  return value.replace(",", ".");
}

/**
 * Valida que todos los códigos existan en el catálogo `app.eu_allergens`; un
 * código desconocido se rechaza con mensaje claro en lugar de dejar aflorar la
 * violación de la clave foránea.
 */
async function requireKnownAllergens(client: PoolClient, codes: readonly string[]): Promise<void> {
  if (codes.length === 0) return;
  const known = await client.query<{ code: string }>(
    `select code from app.eu_allergens where code = any($1::text[])`,
    [codes],
  );
  const found = new Set(known.rows.map((row) => row.code));
  const unknown = codes.filter((code) => !found.has(code));
  if (unknown.length > 0) {
    throw new CommandRejectedError(
      "unknown_allergen",
      `Códigos de alérgeno desconocidos: ${[...new Set(unknown)].sort().join(", ")}`,
    );
  }
}

export interface FoodFacts {
  id: UUID;
  name: string;
  reviewed: boolean;
}

/**
 * Carga los alimentos pedidos y exige que existan todos; los que estén sin
 * revisar (`allergens_reviewed = false`) se devuelven para que quien llama
 * aplique la regla dura del brief: alimento sin mapear bloquea, sin excepción.
 */
export async function loadFoods(
  client: PoolClient,
  householdId: UUID,
  foodIds: readonly UUID[],
): Promise<FoodFacts[]> {
  const result = await client.query<{ id: string; name: string; allergens_reviewed: boolean }>(
    `select id, name, allergens_reviewed
       from app.foods
      where household_id = $1 and id = any($2::uuid[])`,
    [householdId, foodIds],
  );
  const byId = new Map(result.rows.map((row) => [row.id, row]));
  const missing = foodIds.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new CommandRejectedError("food_not_found", `Alimentos inexistentes: ${missing.join(", ")}`);
  }
  return foodIds.map((id) => {
    const row = byId.get(id) as { id: string; name: string; allergens_reviewed: boolean };
    return { id: row.id, name: row.name, reviewed: row.allergens_reviewed };
  });
}

/** Regla dura AC-21: cualquier alimento sin revisar bloquea la operación. */
export function rejectUnreviewedFoods(foods: readonly FoodFacts[]): void {
  const unreviewed = foods.filter((food) => !food.reviewed);
  if (unreviewed.length > 0) {
    throw new CommandRejectedError(
      "food_unreviewed",
      `Alimentos con alérgenos sin revisar: ${unreviewed.map((food) => food.name).sort().join(", ")}`,
    );
  }
}

/**
 * `food` — upsert de alimento del catálogo (solo familia). El mapeo de
 * alérgenos del payload reemplaza por completo al existente y `reviewed`
 * gobierna `allergens_reviewed`, la llave que desbloquea su uso en recetas.
 */
export const foodCommandHandler: CommandHandler = async (client, membership, envelope) => {
  requireFamilyRole(membership.role, "el catálogo de alimentos");
  const parsed = foodUpsertPayloadSchema.safeParse(envelope.payload);
  if (!parsed.success) {
    throw new CommandRejectedError("invalid_payload", parsed.error.issues[0]?.message);
  }
  const payload = parsed.data;
  const householdId = envelope.householdId;
  const allergenCodes = [...new Set(payload.allergenCodes)].sort();
  await requireKnownAllergens(client, allergenCodes);

  let foodId: UUID;
  if (payload.foodId !== undefined) {
    const updated = await client.query<{ id: string }>(
      `update app.foods
          set name = $3, shopping_section = $4, allergens_reviewed = $5
        where household_id = $1 and id = $2
        returning id`,
      [householdId, payload.foodId, payload.name, payload.shoppingSection, payload.reviewed],
    );
    const row = updated.rows[0];
    if (!row) throw new CommandRejectedError("food_not_found", "El alimento no existe en este hogar");
    foodId = row.id;
  } else {
    const inserted = await client.query<{ id: string }>(
      `insert into app.foods
         (household_id, name, shopping_section, allergens_reviewed, created_by_membership_id)
       values ($1, $2, $3, $4, $5)
       returning id`,
      [householdId, payload.name, payload.shoppingSection, payload.reviewed, membership.id],
    );
    const row = inserted.rows[0];
    if (!row) throw new Error("La inserción del alimento no devolvió identificador");
    foodId = row.id;
  }

  await client.query(`delete from app.food_allergens where household_id = $1 and food_id = $2`, [
    householdId,
    foodId,
  ]);
  if (allergenCodes.length > 0) {
    await client.query(
      `insert into app.food_allergens (household_id, food_id, allergen_code)
       select $1, $2, unnest($3::text[])`,
      [householdId, foodId, allergenCodes],
    );
  }
  return { resourceId: foodId };
};

/**
 * `diner` — upsert de comensal (solo familia). Las restricciones (DietaryFlag)
 * del payload reemplazan por completo a las existentes; un mismo alérgeno
 * repetido con severidades distintas es ambiguo y se rechaza.
 */
export const dinerCommandHandler: CommandHandler = async (client, membership, envelope) => {
  requireFamilyRole(membership.role, "los comensales");
  const parsed = dinerUpsertPayloadSchema.safeParse(envelope.payload);
  if (!parsed.success) {
    throw new CommandRejectedError("invalid_payload", parsed.error.issues[0]?.message);
  }
  const payload = parsed.data;
  const householdId = envelope.householdId;

  const codes = payload.flags.map((flag) => flag.allergenCode);
  if (new Set(codes).size !== codes.length) {
    throw new CommandRejectedError("duplicate_allergen", "Cada alérgeno solo admite una restricción por comensal");
  }
  await requireKnownAllergens(client, codes);

  let dinerId: UUID;
  if (payload.dinerId !== undefined) {
    const updated = await client.query<{ id: string }>(
      `update app.diners
          set name = $3, notes = $4
        where household_id = $1 and id = $2
        returning id`,
      [householdId, payload.dinerId, payload.name, payload.notes ?? ""],
    );
    const row = updated.rows[0];
    if (!row) throw new CommandRejectedError("diner_not_found", "El comensal no existe en este hogar");
    dinerId = row.id;
  } else {
    const inserted = await client.query<{ id: string }>(
      `insert into app.diners (household_id, name, notes)
       values ($1, $2, $3)
       returning id`,
      [householdId, payload.name, payload.notes ?? ""],
    );
    const row = inserted.rows[0];
    if (!row) throw new Error("La inserción del comensal no devolvió identificador");
    dinerId = row.id;
  }

  await client.query(`delete from app.diner_flags where household_id = $1 and diner_id = $2`, [
    householdId,
    dinerId,
  ]);
  for (const flag of payload.flags) {
    await client.query(
      `insert into app.diner_flags (household_id, diner_id, allergen_code, severity, note)
       values ($1, $2, $3, $4, $5)`,
      [householdId, dinerId, flag.allergenCode, flag.severity, flag.note ?? ""],
    );
  }
  return { resourceId: dinerId };
};

/**
 * `recipe` — set_details (solo familia): la parte estructurada de una receta
 * sobre una página wiki existente del hogar. Upsert de `app.recipes` y
 * reemplazo completo de los ingredientes. Regla dura AC-21: si algún alimento
 * usado tiene `allergens_reviewed = false` la operación se rechaza con
 * `food_unreviewed` listando los alimentos afectados.
 */
export const recipeCommandHandler: CommandHandler = async (client, membership, envelope) => {
  requireFamilyRole(membership.role, "las recetas");
  const parsed = recipeSetDetailsPayloadSchema.safeParse(envelope.payload);
  if (!parsed.success) {
    throw new CommandRejectedError("invalid_payload", parsed.error.issues[0]?.message);
  }
  const payload = parsed.data;
  const householdId = envelope.householdId;

  const page = await client.query(
    `select 1 from app.wiki_pages where household_id = $1 and id = $2 for update`,
    [householdId, payload.pageId],
  );
  if ((page.rowCount ?? 0) === 0) {
    throw new CommandRejectedError("page_not_found", "La página wiki de la receta no existe en este hogar");
  }

  const foodIds = payload.ingredients.map((ingredient) => ingredient.foodId);
  if (new Set(foodIds).size !== foodIds.length) {
    throw new CommandRejectedError("duplicate_ingredient", "Cada alimento solo puede aparecer una vez en la receta");
  }
  const foods = await loadFoods(client, householdId, foodIds);
  rejectUnreviewedFoods(foods);

  await client.query(
    `insert into app.recipes (household_id, page_id, base_servings, time_minutes)
     values ($1, $2, $3, $4)
     on conflict (household_id, page_id) do update
       set base_servings = excluded.base_servings,
           time_minutes = excluded.time_minutes,
           updated_at = statement_timestamp()`,
    [householdId, payload.pageId, payload.baseServings, payload.timeMinutes ?? null],
  );

  await client.query(`delete from app.recipe_ingredients where household_id = $1 and page_id = $2`, [
    householdId,
    payload.pageId,
  ]);
  for (const [position, ingredient] of payload.ingredients.entries()) {
    await client.query(
      `insert into app.recipe_ingredients
         (household_id, page_id, food_id, quantity, unit, scaling, position)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        householdId,
        payload.pageId,
        ingredient.foodId,
        normalizeQuantity(ingredient.quantity),
        ingredient.unit,
        ingredient.scaling,
        position,
      ],
    );
  }
  return { resourceId: payload.pageId };
};
