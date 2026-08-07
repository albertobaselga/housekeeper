import type { PoolClient } from "pg";

import type { UUID } from "@casa-clara/contracts";
import {
  menuGroupUpsertPayloadSchema,
  menuSlotCommandPayloadSchema,
  shoppingAddPayloadSchema,
  shoppingSetCheckedPayloadSchema,
} from "@casa-clara/contracts/schemas";

import type { ActiveMembership } from "../database.js";
import { computeMenuSlotHash } from "../menu-hash.js";
import { CommandConflictError, CommandRejectedError, type CommandHandler } from "../sync.js";
import {
  loadFoods,
  normalizeQuantity,
  rejectUnreviewedFoods,
  requireFamilyRole,
} from "./food.js";

const SHOPPING_WRITER_ROLES = new Set(["family_admin", "family_member", "employee_live_in"]);

const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * `menu_group` — upsert de grupo de comensales (solo familia). La lista
 * `dinerIds` del payload reemplaza por completo la membresía del grupo.
 */
export const menuGroupCommandHandler: CommandHandler = async (client, membership, envelope) => {
  requireFamilyRole(membership.role, "los grupos del menú");
  const parsed = menuGroupUpsertPayloadSchema.safeParse(envelope.payload);
  if (!parsed.success) {
    throw new CommandRejectedError("invalid_payload", parsed.error.issues[0]?.message);
  }
  const payload = parsed.data;
  const householdId = envelope.householdId;
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
 * `menu_slot` — set / clear / duplicate_week / confirm, todo escritura de
 * familia (RLS lo respalda; aquí se rechaza antes con `not_allowed`). `set`
 * aplica la puerta de alérgenos de AC-21 y cualquier set/clear invalida la
 * confirmación previa; `confirm` compara el hash de contenido vigente (AC-23).
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
    case "clear":
      return clearMenuSlot(client, householdId, payload.slotId);
    case "duplicate_week":
      return duplicateWeek(client, membership, householdId, payload.fromWeekStartsOn, payload.toWeekStartsOn);
    case "confirm":
      return confirmMenuSlot(client, membership, householdId, payload.slotId, payload.contentHash);
  }
};

/**
 * `shopping_item` — add / set_checked. Escriben familia y empleada interna
 * (la política RLS `shopping_write` respalda la restricción); helper y viewer
 * se rechazan aquí con `not_allowed`.
 */
export const shoppingItemCommandHandler: CommandHandler = async (client, membership, envelope) => {
  if (!SHOPPING_WRITER_ROLES.has(membership.role)) {
    throw new CommandRejectedError("not_allowed", "Este rol no puede escribir en la lista de la compra");
  }
  const householdId = envelope.householdId;
  const action = (envelope.payload as { action?: unknown } | null)?.action;

  if (action === "add") {
    const parsed = shoppingAddPayloadSchema.safeParse(envelope.payload);
    if (!parsed.success) {
      throw new CommandRejectedError("invalid_payload", parsed.error.issues[0]?.message);
    }
    const payload = parsed.data;

    let section = payload.section;
    if (payload.foodId !== undefined) {
      const food = await client.query<{ shopping_section: string }>(
        `select shopping_section from app.foods where household_id = $1 and id = $2`,
        [householdId, payload.foodId],
      );
      const row = food.rows[0];
      if (!row) throw new CommandRejectedError("food_not_found", "El alimento no existe en este hogar");
      section = section ?? row.shopping_section;
    }

    const inserted = await client.query<{ id: string }>(
      `insert into app.shopping_items
         (household_id, food_id, custom_name, quantity, unit, section, week_starts_on,
          created_by_membership_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       returning id`,
      [
        householdId,
        payload.foodId ?? null,
        payload.foodId === undefined ? (payload.customName ?? "").trim() : null,
        payload.quantity === undefined ? null : normalizeQuantity(payload.quantity),
        payload.unit ?? null,
        section ?? "despensa",
        payload.weekStartsOn ?? null,
        membership.id,
      ],
    );
    const row = inserted.rows[0];
    if (!row) throw new Error("La inserción del añadido de compra no devolvió identificador");
    return { resourceId: row.id };
  }

  if (action === "set_checked") {
    const parsed = shoppingSetCheckedPayloadSchema.safeParse(envelope.payload);
    if (!parsed.success) {
      throw new CommandRejectedError("invalid_payload", parsed.error.issues[0]?.message);
    }
    const payload = parsed.data;
    const updated = await client.query<{ id: string }>(
      `update app.shopping_items
          set checked_at = case when $3 then statement_timestamp() else null end
        where household_id = $1 and id = $2
        returning id`,
      [householdId, payload.itemId, payload.checked],
    );
    if ((updated.rowCount ?? 0) === 0) {
      throw new CommandRejectedError("item_not_found", "El añadido de compra no existe en este hogar");
    }
    return { resourceId: payload.itemId };
  }

  throw new CommandRejectedError("invalid_payload", "Acción de compra desconocida");
};

// ─────────────────────────────────────────────────────────────────────────────
// Agregación de la lista de la compra (AC-22 / AC-24)
// ─────────────────────────────────────────────────────────────────────────────

export interface ShoppingListEntry {
  foodId: UUID | null;
  name: string;
  unit: string | null;
  section: string;
  /** Suma decimal exacta como string (`"300"`, `"1.5"`); null si ninguna fuente aportó cantidad. */
  quantity: string | null;
}

/** `"12,5"` / `"12.50"` → céntimas exactas como BigInt (1250n). Sin floats. */
function toHundredths(value: string): bigint {
  const [integerPart = "0", fractionPart = ""] = value.replace(",", ".").split(".");
  return BigInt(integerPart) * 100n + BigInt(fractionPart.padEnd(2, "0").slice(0, 2));
}

/** Escala lineal exacta en céntimas con redondeo half-up a la céntima. */
function scaleHundredths(quantity: bigint, targetServings: number, baseServings: number): bigint {
  const numerator = quantity * BigInt(targetServings);
  const base = BigInt(baseServings);
  return (2n * numerator + base) / (2n * base);
}

/** Céntimas → decimal legible sin ceros de relleno: 30000n → "300", 150n → "1.5". */
function formatHundredths(value: bigint): string {
  const integerPart = value / 100n;
  const fraction = value % 100n;
  if (fraction === 0n) return integerPart.toString();
  if (fraction % 10n === 0n) return `${integerPart}.${fraction / 10n}`;
  return `${integerPart}.${fraction.toString().padStart(2, "0")}`;
}

interface Accumulator {
  foodId: UUID | null;
  name: string;
  unit: string | null;
  section: string;
  sum: bigint | null;
}

function accumulate(
  entries: Map<string, Accumulator>,
  item: { foodId: UUID | null; name: string; unit: string | null; section: string },
  hundredths: bigint | null,
): void {
  const key = `${item.foodId ?? `custom:${item.name.toLowerCase()}`}|${item.unit ?? ""}|${item.section}`;
  const existing = entries.get(key);
  if (!existing) {
    entries.set(key, { ...item, sum: hundredths });
    return;
  }
  if (hundredths !== null) {
    existing.sum = (existing.sum ?? 0n) + hundredths;
  }
}

/**
 * Lista de la compra agregada de la semana `weekStartsOn` (7 días): los
 * ingredientes de las recetas asignadas en el menú, escalados por los
 * comensales del grupo (o `servings_override`) frente a `base_servings` —
 * `linear` escala con redondeo half-up a la céntima, `fixed` va tal cual
 * (AC-22) — más los añadidos manuales sin marcar de esa semana o sin semana.
 * Se agrupa por (alimento o nombre libre, unidad, sección) sumando cantidades
 * de forma exacta con BigInt sobre céntimas (AC-24).
 */
export async function aggregateShoppingList(
  client: PoolClient,
  householdId: UUID,
  weekStartsOn: string,
): Promise<ShoppingListEntry[]> {
  const entries = new Map<string, Accumulator>();

  const menuRows = await client.query<{
    food_id: string;
    name: string;
    unit: string;
    section: string;
    quantity: string;
    scaling: string;
    base_servings: number;
    diner_count: number;
    servings_override: number | null;
  }>(
    `select ingredient.food_id, food.name, ingredient.unit,
            food.shopping_section as section, ingredient.quantity::text as quantity,
            ingredient.scaling, recipe.base_servings, slot.servings_override,
            (select count(*)::int from app.menu_group_diners as member
              where member.household_id = slot.household_id
                and member.group_id = slot.group_id) as diner_count
       from app.menu_slots as slot
       join app.recipes as recipe
         on recipe.household_id = slot.household_id and recipe.page_id = slot.recipe_page_id
       join app.recipe_ingredients as ingredient
         on ingredient.household_id = recipe.household_id and ingredient.page_id = recipe.page_id
       join app.foods as food
         on food.household_id = ingredient.household_id and food.id = ingredient.food_id
      where slot.household_id = $1
        and slot.on_date >= $2::date and slot.on_date <= $2::date + 6
        and slot.recipe_page_id is not null
      order by slot.on_date, slot.meal, ingredient.position`,
    [householdId, weekStartsOn],
  );

  for (const row of menuRows.rows) {
    // Raciones objetivo: override explícito del hueco, si no el nº de comensales
    // del grupo; un grupo vacío cae a base_servings (factor 1).
    const target = row.servings_override ?? (row.diner_count > 0 ? row.diner_count : row.base_servings);
    const raw = toHundredths(row.quantity);
    const scaled = row.scaling === "linear" ? scaleHundredths(raw, target, row.base_servings) : raw;
    accumulate(
      entries,
      { foodId: row.food_id, name: row.name, unit: row.unit, section: row.section },
      scaled,
    );
  }

  const manualRows = await client.query<{
    food_id: string | null;
    name: string;
    unit: string | null;
    section: string;
    quantity: string | null;
  }>(
    `select item.food_id, coalesce(food.name, item.custom_name) as name,
            item.unit, item.section, item.quantity::text as quantity
       from app.shopping_items as item
       left join app.foods as food
         on food.household_id = item.household_id and food.id = item.food_id
      where item.household_id = $1
        and item.checked_at is null
        and (item.week_starts_on is null or item.week_starts_on = $2::date)
      order by item.created_at`,
    [householdId, weekStartsOn],
  );

  for (const row of manualRows.rows) {
    accumulate(
      entries,
      { foodId: row.food_id, name: row.name, unit: row.unit, section: row.section },
      row.quantity === null ? null : toHundredths(row.quantity),
    );
  }

  return [...entries.values()]
    .map((entry) => ({
      foodId: entry.foodId,
      name: entry.name,
      unit: entry.unit,
      section: entry.section,
      quantity: entry.sum === null ? null : formatHundredths(entry.sum),
    }))
    .sort(
      (a, b) =>
        a.section.localeCompare(b.section, "es") ||
        a.name.localeCompare(b.name, "es") ||
        (a.unit ?? "").localeCompare(b.unit ?? "", "es"),
    );
}
