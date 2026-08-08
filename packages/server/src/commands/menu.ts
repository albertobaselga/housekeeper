import type { PoolClient } from "pg";

import type { UUID } from "@casa-clara/contracts";
import {
  menuGroupCommandPayloadSchema,
  menuSlotCommandPayloadSchema,
} from "@casa-clara/contracts/schemas";

import type { ActiveMembership } from "../database.js";
import { computeMenuSlotHash } from "../menu-hash.js";
import { CommandConflictError, CommandRejectedError, type CommandHandler } from "../sync.js";
import { loadFoods, rejectUnreviewedFoods, requireFamilyRole, setArchived } from "./food.js";
import { createWikiPage, createWikiSpace } from "./wiki.js";

const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * `menu_group` — upsert / archive / restore de grupo de comensales (solo
 * familia). En el upsert, la lista `dinerIds` del payload reemplaza por
 * completo la membresía del grupo. Archivar retira el grupo del menú sin
 * borrar sus comidas ya planificadas: las plantillas que lo usan degradan
 * saltándose sus huecos, como ya hacían.
 */
export const menuGroupCommandHandler: CommandHandler = async (client, membership, envelope) => {
  requireFamilyRole(membership.role, "los grupos del menú");
  const parsed = menuGroupCommandPayloadSchema.safeParse(envelope.payload);
  if (!parsed.success) {
    throw new CommandRejectedError("invalid_payload", parsed.error.issues[0]?.message);
  }
  const payload = parsed.data;
  const householdId = envelope.householdId;

  if (payload.action === "archive" || payload.action === "restore") {
    return setArchived(client, {
      table: "app.menu_groups",
      householdId,
      idColumn: "id",
      id: payload.groupId,
      archived: payload.action === "archive",
      errorCode: "group_not_found",
      what: "El grupo",
    });
  }

  const dinerIds = [...new Set(payload.dinerIds)].sort();

  if (dinerIds.length > 0) {
    const diners = await client.query<{ id: string }>(
      `select id from app.diners where household_id = $1 and id = any($2::uuid[])`,
      [householdId, dinerIds],
    );
    if ((diners.rowCount ?? 0) !== dinerIds.length) {
      const found = new Set(diners.rows.map((row) => row.id));
      const missing = dinerIds.filter((id) => !found.has(id));
      throw new CommandRejectedError("diner_not_found", `Comensales inexistentes: ${missing.join(", ")}`);
    }
  }

  let groupId: UUID;
  if (payload.groupId !== undefined) {
    const updated = await client.query<{ id: string }>(
      `update app.menu_groups set name = $3 where household_id = $1 and id = $2 returning id`,
      [householdId, payload.groupId, payload.name],
    );
    const row = updated.rows[0];
    if (!row) throw new CommandRejectedError("group_not_found", "El grupo no existe en este hogar");
    groupId = row.id;
  } else {
    const inserted = await client.query<{ id: string }>(
      `insert into app.menu_groups (household_id, name) values ($1, $2) returning id`,
      [householdId, payload.name],
    );
    const row = inserted.rows[0];
    if (!row) throw new Error("La inserción del grupo no devolvió identificador");
    groupId = row.id;
  }

  await client.query(`delete from app.menu_group_diners where household_id = $1 and group_id = $2`, [
    householdId,
    groupId,
  ]);
  if (dinerIds.length > 0) {
    await client.query(
      `insert into app.menu_group_diners (household_id, group_id, diner_id)
       select $1, $2, unnest($3::uuid[])`,
      [householdId, groupId, dinerIds],
    );
  }
  return { resourceId: groupId };
};

interface MenuSlotSetPayload {
  groupId: UUID;
  onDate: string;
  meal: "desayuno" | "almuerzo" | "comida" | "merienda" | "cena";
  recipePageId?: UUID | undefined;
  freeText?: string | undefined;
  notes?: string | undefined;
  servingsOverride?: number | undefined;
  acknowledgeAllergens?: boolean | undefined;
}

/**
 * Puerta de alérgenos de AC-21: intersección entre los alérgenos de los
 * ingredientes de la receta y las restricciones de los comensales del grupo.
 * Devuelve los códigos en conflicto, ordenados.
 */
async function conflictingAllergens(
  client: PoolClient,
  householdId: UUID,
  recipePageId: UUID,
  groupId: UUID,
): Promise<string[]> {
  const result = await client.query<{ allergen_code: string }>(
    `select distinct food_allergen.allergen_code
       from app.recipe_ingredients as ingredient
       join app.food_allergens as food_allergen
         on food_allergen.household_id = ingredient.household_id
        and food_allergen.food_id = ingredient.food_id
       join app.menu_group_diners as member
         on member.household_id = ingredient.household_id and member.group_id = $3
       join app.diner_flags as flag
         on flag.household_id = ingredient.household_id
        and flag.diner_id = member.diner_id
        and flag.allergen_code = food_allergen.allergen_code
      where ingredient.household_id = $1 and ingredient.page_id = $2
      order by 1`,
    [householdId, recipePageId, groupId],
  );
  return result.rows.map((row) => row.allergen_code);
}

async function setMenuSlot(
  client: PoolClient,
  membership: ActiveMembership,
  householdId: UUID,
  payload: MenuSlotSetPayload,
): Promise<{ resourceId: UUID }> {
  const group = await client.query(
    `select 1 from app.menu_groups where household_id = $1 and id = $2 for update`,
    [householdId, payload.groupId],
  );
  if ((group.rowCount ?? 0) === 0) {
    throw new CommandRejectedError("group_not_found", "El grupo del menú no existe en este hogar");
  }

  const freeText = payload.freeText?.trim() ?? "";
  if (payload.recipePageId === undefined && freeText.length === 0) {
    throw new CommandRejectedError("invalid_payload", "El hueco necesita receta o texto libre");
  }

  if (payload.recipePageId !== undefined) {
    const recipe = await client.query<{ page_id: string }>(
      `select page_id from app.recipes where household_id = $1 and page_id = $2`,
      [householdId, payload.recipePageId],
    );
    if ((recipe.rowCount ?? 0) === 0) {
      throw new CommandRejectedError("recipe_not_found", "La receta no existe en este hogar");
    }
    const ingredientFoods = await client.query<{ food_id: string }>(
      `select food_id from app.recipe_ingredients where household_id = $1 and page_id = $2`,
      [householdId, payload.recipePageId],
    );
    // Regla dura: TODOS los ingredientes deben estar revisados, sin excepción.
    const foods = await loadFoods(
      client,
      householdId,
      ingredientFoods.rows.map((row) => row.food_id),
    );
    rejectUnreviewedFoods(foods);

    const conflicts = await conflictingAllergens(client, householdId, payload.recipePageId, payload.groupId);
    if (conflicts.length > 0 && payload.acknowledgeAllergens !== true) {
      throw new CommandRejectedError(
        "allergen_conflict",
        `La receta contiene alérgenos declarados por comensales del grupo: ${conflicts.join(", ")}`,
      );
    }
  }

  const upserted = await client.query<{ id: string }>(
    `insert into app.menu_slots
       (household_id, group_id, on_date, meal, recipe_page_id, free_text, notes,
        servings_override, updated_by_membership_id)
     values ($1, $2, $3, $4::app.meal_slot, $5, $6, $7, $8, $9)
     on conflict (household_id, group_id, on_date, meal) do update
       set recipe_page_id = excluded.recipe_page_id,
           free_text = excluded.free_text,
           notes = excluded.notes,
           servings_override = excluded.servings_override,
           updated_by_membership_id = excluded.updated_by_membership_id
     returning id`,
    [
      householdId,
      payload.groupId,
      payload.onDate,
      payload.meal,
      payload.recipePageId ?? null,
      freeText,
      payload.notes ?? "",
      payload.servingsOverride ?? null,
      membership.id,
    ],
  );
  const slot = upserted.rows[0];
  if (!slot) throw new Error("El upsert del hueco de menú no devolvió identificador");

  // Cualquier set invalida la confirmación previa del hueco: el contenido cambió.
  await client.query(`delete from app.menu_confirmations where household_id = $1 and slot_id = $2`, [
    householdId,
    slot.id,
  ]);
  return { resourceId: slot.id };
}

interface MenuSlotSetNewRecipePayload {
  groupId: UUID;
  onDate: string;
  meal: "desayuno" | "almuerzo" | "comida" | "merienda" | "cena";
  recipeTitle: string;
  recipeBody?: string | undefined;
  baseServings?: number | undefined;
  notes?: string | undefined;
  servingsOverride?: number | undefined;
}

/**
 * Espacio wiki donde vivirá una receta creada desde el menú: el de la última
 * receta del hogar; si no hay recetas todavía, el espacio con slug `recetas`;
 * y como último recurso se crea el espacio «Recetas» con el mismo camino que
 * `wiki_space.create` (slug desambiguado).
 */
async function resolveRecipeSpaceId(
  client: PoolClient,
  membership: ActiveMembership,
  householdId: UUID,
): Promise<UUID> {
  const fromRecipes = await client.query<{ space_id: string }>(
    `select page.space_id
       from app.recipes as recipe
       join app.wiki_pages as page
         on page.household_id = recipe.household_id and page.id = recipe.page_id
       join app.wiki_spaces as space
         on space.household_id = page.household_id and space.id = page.space_id
      where recipe.household_id = $1
        and page.archived_at is null and space.archived_at is null
      order by recipe.updated_at desc
      limit 1`,
    [householdId],
  );
  const recipeSpace = fromRecipes.rows[0];
  if (recipeSpace) return recipeSpace.space_id;

  const bySlug = await client.query<{ id: string }>(
    `select id from app.wiki_spaces
      where household_id = $1 and slug = 'recetas' and archived_at is null`,
    [householdId],
  );
  const named = bySlug.rows[0];
  if (named) return named.id;

  const created = await createWikiSpace(client, membership, householdId, {
    name: "Recetas",
    description: "Recetario de la casa",
  });
  return created.resourceId;
}

/**
 * `set_new_recipe` — crear la receta AHÍ MISMO, desde el hueco: página wiki
 * (mismo camino que `wiki_page.create`, publicada), fila de `app.recipes`
 * (todavía sin ingredientes) y asignación del hueco vía `setMenuSlot`, todo en
 * la MISMA transacción y con un único recibo idempotente: offline no puede
 * quedar la receta creada sin hueco ni al revés. Sin ingredientes no hay
 * alérgenos que reconocer; la puerta de AC-21 gobierna en cuanto la receta
 * reciba ingredientes con `recipe.set_details`.
 */
async function setMenuSlotWithNewRecipe(
  client: PoolClient,
  membership: ActiveMembership,
  householdId: UUID,
  payload: MenuSlotSetNewRecipePayload,
): Promise<{ resourceId: UUID }> {
  // El grupo se comprueba ANTES de crear nada para rechazar con código claro
  // (la transacción revertiría igualmente, pero sin ruido intermedio).
  const group = await client.query(
    `select 1 from app.menu_groups where household_id = $1 and id = $2 for update`,
    [householdId, payload.groupId],
  );
  if ((group.rowCount ?? 0) === 0) {
    throw new CommandRejectedError("group_not_found", "El grupo del menú no existe en este hogar");
  }

  const spaceId = await resolveRecipeSpaceId(client, membership, householdId);
  const page = await createWikiPage(client, membership, householdId, {
    spaceId,
    title: payload.recipeTitle,
    bodyMarkdown: payload.recipeBody?.trim() ?? "",
    tags: ["receta"],
    publish: true,
  });

  // Raciones base: explícitas o el nº de comensales del grupo (mínimo 1).
  let baseServings = payload.baseServings;
  if (baseServings === undefined) {
    const diners = await client.query<{ n: number }>(
      `select count(*)::int as n from app.menu_group_diners
        where household_id = $1 and group_id = $2`,
      [householdId, payload.groupId],
    );
    baseServings = Math.max(1, diners.rows[0]?.n ?? 0);
  }
  await client.query(
    `insert into app.recipes (household_id, page_id, base_servings) values ($1, $2, $3)`,
    [householdId, page.resourceId, baseServings],
  );

  return setMenuSlot(client, membership, householdId, {
    groupId: payload.groupId,
    onDate: payload.onDate,
    meal: payload.meal,
    recipePageId: page.resourceId,
    notes: payload.notes,
    servingsOverride: payload.servingsOverride,
  });
}

async function clearMenuSlot(
  client: PoolClient,
  householdId: UUID,
  slotId: UUID,
): Promise<{ resourceId: UUID }> {
  // La confirmación cae por ON DELETE CASCADE junto con el hueco.
  const deleted = await client.query<{ id: string }>(
    `delete from app.menu_slots where household_id = $1 and id = $2 returning id`,
    [householdId, slotId],
  );
  if ((deleted.rowCount ?? 0) === 0) {
    throw new CommandRejectedError("slot_not_found", "El hueco de menú no existe en este hogar");
  }
  return { resourceId: slotId };
}

/**
 * `duplicate_week` (AC-23): copia los 7 días de la semana origen a la destino
 * para TODOS los grupos (receta o texto, notas y servings_override) con un
 * único INSERT … ON CONFLICT: los huecos ya existentes en destino se
 * sobrescriben y una segunda ejecución produce exactamente el mismo resultado.
 * Las semanas no pueden solaparse: con solape la copia leería huecos que ella
 * misma acaba de escribir y dejaría de ser idempotente.
 */
async function duplicateWeek(
  client: PoolClient,
  membership: ActiveMembership,
  householdId: UUID,
  fromWeekStartsOn: string,
  toWeekStartsOn: string,
): Promise<Record<string, never>> {
  const dayDiff = Math.round(
    (Date.parse(`${toWeekStartsOn}T00:00:00Z`) - Date.parse(`${fromWeekStartsOn}T00:00:00Z`)) / DAY_MS,
  );
  if (Math.abs(dayDiff) < 7) {
    throw new CommandRejectedError("week_overlap", "Las semanas origen y destino no pueden solaparse");
  }

  const copied = await client.query<{ id: string }>(
    `insert into app.menu_slots
       (household_id, group_id, on_date, meal, recipe_page_id, free_text, notes,
        servings_override, updated_by_membership_id)
     select household_id, group_id, on_date + ($3::date - $2::date), meal,
            recipe_page_id, free_text, notes, servings_override, $4
       from app.menu_slots
      where household_id = $1
        and on_date >= $2::date and on_date <= $2::date + 6
     on conflict (household_id, group_id, on_date, meal) do update
       set recipe_page_id = excluded.recipe_page_id,
           free_text = excluded.free_text,
           notes = excluded.notes,
           servings_override = excluded.servings_override,
           updated_by_membership_id = excluded.updated_by_membership_id
     returning id`,
    [householdId, fromWeekStartsOn, toWeekStartsOn, membership.id],
  );

  // Los huecos escritos en destino cambian de contenido: sus confirmaciones
  // previas dejan de valer y se retiran.
  const targetIds = copied.rows.map((row) => row.id);
  if (targetIds.length > 0) {
    await client.query(
      `delete from app.menu_confirmations where household_id = $1 and slot_id = any($2::uuid[])`,
      [householdId, targetIds],
    );
  }
  return {};
}

async function confirmMenuSlot(
  client: PoolClient,
  membership: ActiveMembership,
  householdId: UUID,
  slotId: UUID,
  contentHash: string,
): Promise<{ resourceId: UUID }> {
  const slot = await client.query(
    `select 1 from app.menu_slots where household_id = $1 and id = $2 for update`,
    [householdId, slotId],
  );
  if ((slot.rowCount ?? 0) === 0) {
    throw new CommandRejectedError("slot_not_found", "El hueco de menú no existe en este hogar");
  }

  const currentHash = await computeMenuSlotHash(client, householdId, slotId);
  if (currentHash !== contentHash) {
    // El contenido (receta, grupo o restricciones) cambió desde que la persona
    // vio el hueco: conflicto con resolución humana, no rechazo.
    throw new CommandConflictError(
      "menu_content_changed",
      "El contenido del hueco cambió desde la última revisión; vuelve a comprobarlo antes de confirmar",
    );
  }

  await client.query(
    `insert into app.menu_confirmations (household_id, slot_id, content_hash, confirmed_by_membership_id)
     values ($1, $2, $3, $4)
     on conflict (household_id, slot_id) do update
       set content_hash = excluded.content_hash,
           confirmed_by_membership_id = excluded.confirmed_by_membership_id,
           confirmed_at = statement_timestamp()`,
    [householdId, slotId, contentHash, membership.id],
  );
  return { resourceId: slotId };
}

/**
 * `menu_slot` — set / set_new_recipe / clear / duplicate_week / confirm, todo
 * escritura de familia (RLS lo respalda; aquí se rechaza antes con
 * `not_allowed`). `set` aplica la puerta de alérgenos de AC-21 y cualquier
 * set/clear invalida la confirmación previa; `set_new_recipe` crea la receta
 * (página wiki + fila de recipes) y asigna el hueco en un único comando
 * atómico; `confirm` compara el hash de contenido vigente (AC-23).
 */
export const menuSlotCommandHandler: CommandHandler = async (client, membership, envelope) => {
  requireFamilyRole(membership.role, "el menú semanal");
  const parsed = menuSlotCommandPayloadSchema.safeParse(envelope.payload);
  if (!parsed.success) {
    throw new CommandRejectedError("invalid_payload", parsed.error.issues[0]?.message);
  }
  const payload = parsed.data;
  const householdId = envelope.householdId;

  switch (payload.action) {
    case "set":
      return setMenuSlot(client, membership, householdId, payload);
    case "set_new_recipe":
      return setMenuSlotWithNewRecipe(client, membership, householdId, payload);
    case "clear":
      return clearMenuSlot(client, householdId, payload.slotId);
    case "duplicate_week":
      return duplicateWeek(client, membership, householdId, payload.fromWeekStartsOn, payload.toWeekStartsOn);
    case "confirm":
      return confirmMenuSlot(client, membership, householdId, payload.slotId, payload.contentHash);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Aritmética exacta de cantidades de la compra (AC-22 / AC-24). La lista en sí
// la construye `buildShoppingBoard` en ./shopping.ts, que reutiliza estas
// utilidades: aquí solo vive el cálculo, sin acceso a la base de datos.
// ─────────────────────────────────────────────────────────────────────────────

/** `"12,5"` / `"12.50"` → céntimas exactas como BigInt (1250n). Sin floats. */
export function toHundredths(value: string): bigint {
  const [integerPart = "0", fractionPart = ""] = value.replace(",", ".").split(".");
  return BigInt(integerPart) * 100n + BigInt(fractionPart.padEnd(2, "0").slice(0, 2));
}

/** Escala lineal exacta en céntimas con redondeo half-up a la céntima. */
export function scaleHundredths(quantity: bigint, targetServings: number, baseServings: number): bigint {
  const numerator = quantity * BigInt(targetServings);
  const base = BigInt(baseServings);
  return (2n * numerator + base) / (2n * base);
}

/**
 * Cantidad de un ingrediente en céntimas según su modo de escalado: `linear`
 * escala con `scaleHundredths`; `fixed` es invariante a las raciones (AC-22).
 * Es exactamente la regla que aplica `buildShoppingBoard`, exportada para
 * poder someterla a tests de propiedades.
 */
export function scaleIngredientHundredths(
  quantity: bigint,
  scaling: "linear" | "fixed",
  targetServings: number,
  baseServings: number,
): bigint {
  return scaling === "linear" ? scaleHundredths(quantity, targetServings, baseServings) : quantity;
}

/** Céntimas → decimal legible sin ceros de relleno: 30000n → "300", 150n → "1.5". */
export function formatHundredths(value: bigint): string {
  const integerPart = value / 100n;
  const fraction = value % 100n;
  if (fraction === 0n) return integerPart.toString();
  if (fraction % 10n === 0n) return `${integerPart}.${fraction / 10n}`;
  return `${integerPart}.${fraction.toString().padStart(2, "0")}`;
}
