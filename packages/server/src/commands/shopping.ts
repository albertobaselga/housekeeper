import type { PoolClient } from "pg";

import type { UUID } from "@casa-clara/contracts";
import {
  shoppingAddPayloadSchema,
  shoppingSetCheckedPayloadSchema,
  shoppingSetLineCheckedPayloadSchema,
} from "@casa-clara/contracts/schemas";

import { CommandRejectedError, type CommandHandler } from "../sync.js";
import { normalizeQuantity } from "./food.js";
import { formatHundredths, scaleIngredientHundredths, toHundredths } from "./menu.js";

export type ShoppingListKind = "casa" | "personal";

const HOUSE_WRITER_ROLES = new Set(["family_admin", "family_member", "employee_live_in"]);
/** Lista personal de la interna: solo ella y la administración familiar. */
const PERSONAL_ROLES = new Set(["family_admin", "employee_live_in"]);

// ─────────────────────────────────────────────────────────────────────────────
// Redondeo a medidas de compra reales
//
// La regla vive en el servidor y solo actúa cuando el alimento DECLARA su
// tamaño de paquete (`app.foods.package_size` / `package_unit`). Sin ese dato
// la lista muestra la cantidad exacta: no existe ningún catálogo de envases
// inventado. Las equivalencias son las tres obvias del sistema métrico
// (g↔kg, ml↔cl↔l); cualquier otra unidad solo casa consigo misma.
// ─────────────────────────────────────────────────────────────────────────────

interface UnitScale {
  family: string;
  /** Cuántas unidades base vale una unidad de esta (g y ml son la base). */
  factor: bigint;
}

const UNIT_SCALES: ReadonlyMap<string, UnitScale> = new Map<string, UnitScale>([
  ["g", { family: "masa", factor: 1n }],
  ["gr", { family: "masa", factor: 1n }],
  ["gramo", { family: "masa", factor: 1n }],
  ["gramos", { family: "masa", factor: 1n }],
  ["kg", { family: "masa", factor: 1000n }],
  ["kilo", { family: "masa", factor: 1000n }],
  ["kilos", { family: "masa", factor: 1000n }],
  ["kilogramo", { family: "masa", factor: 1000n }],
  ["kilogramos", { family: "masa", factor: 1000n }],
  ["ml", { family: "volumen", factor: 1n }],
  ["mililitro", { family: "volumen", factor: 1n }],
  ["mililitros", { family: "volumen", factor: 1n }],
  ["cl", { family: "volumen", factor: 10n }],
  ["l", { family: "volumen", factor: 1000n }],
  ["lt", { family: "volumen", factor: 1000n }],
  ["litro", { family: "volumen", factor: 1000n }],
  ["litros", { family: "volumen", factor: 1000n }],
]);

/** Unidad comparable: minúsculas, sin espacios sobrantes ni punto final. */
export function normalizeShoppingUnit(unit: string): string {
  return unit.trim().toLowerCase().replace(/\.+$/, "");
}

function unitScale(unit: string): UnitScale {
  const key = normalizeShoppingUnit(unit);
  return UNIT_SCALES.get(key) ?? { family: `propia:${key}`, factor: 1n };
}

/**
 * Cuántos paquetes hacen falta para cubrir `quantity unit` si el alimento se
 * vende en paquetes de `packageSize packageUnit` (350 g con paquete de 500 g →
 * 1; 1,2 kg con paquete de 500 g → 3). Devuelve null —y quien llama muestra la
 * cantidad exacta— cuando las unidades no son comparables, cuando falta la
 * cantidad o cuando el resultado sería absurdo (más de mil paquetes).
 */
export function packagesNeeded(
  quantity: string,
  unit: string | null,
  packageSize: string,
  packageUnit: string,
): number | null {
  if (unit === null) return null;
  const wanted = unitScale(unit);
  const sold = unitScale(packageUnit);
  if (wanted.family !== sold.family) return null;
  const total = toHundredths(quantity) * wanted.factor;
  const size = toHundredths(packageSize) * sold.factor;
  if (total <= 0n || size <= 0n) return null;
  const packages = (total + size - 1n) / size;
  return packages > 1000n ? null : Number(packages);
}

// ─────────────────────────────────────────────────────────────────────────────
// Lista de la compra de la semana, ya fusionada
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Identidad de una línea: `food:<uuid>` para los alimentos del catálogo y
 * `name:<nombre en minúsculas>` para los añadidos libres. Un añadido a mano
 * cuyo nombre coincide con un alimento del catálogo se resuelve a la clave del
 * alimento, y por eso acaba fusionado con lo que viene del menú.
 */
export function foodLineKey(foodId: UUID): string {
  return `food:${foodId}`;
}

export function nameLineKey(name: string): string {
  return `name:${normalizeShoppingName(name)}`;
}

/** Igual que `lower(btrim(...))` en SQL: la fusión debe casar en ambos lados. */
export function normalizeShoppingName(name: string): string {
  return name.trim().toLowerCase();
}

export interface ShoppingPart {
  /** Unidad tal cual se escribió (`"g"`, `"l"`, `"paquetes"`); null si no hay. */
  unit: string | null;
  /** Total de la parte (menú + añadidos); null si nadie puso cantidad. */
  quantity: string | null;
  /** Lo que aporta el menú de la semana, para el literal «500 g del menú». */
  fromMenu: string | null;
  /** Lo que aportan los añadidos a mano, para «+ 1 añadido». */
  fromManual: string | null;
  /** Alguna cantidad entró como 'fixed' y no se escaló con las raciones. */
  includesFixed: boolean;
  /** Paquetes de compra si el alimento declara tamaño; null si no aplica. */
  packages: number | null;
}

export interface ShoppingLine {
  key: string;
  name: string;
  section: string;
  foodId: string | null;
  /** De dónde sale la línea: del menú, a mano, o las dos cosas fusionadas. */
  origin: "menu" | "manual" | "mixed";
  parts: ShoppingPart[];
  /** Añadidos manuales fusionados aquí (marcar la línea los marca todos). */
  itemIds: string[];
  checked: boolean;
  /** Tamaño de paquete declarado por el alimento, si lo tiene. */
  packaging: { size: string; unit: string } | null;
}

export interface ShoppingSection {
  section: string;
  lines: ShoppingLine[];
}

export interface ShoppingBoard {
  weekStartsOn: string;
  /** Lista de la casa, por secciones de tienda. */
  sections: ShoppingSection[];
  /**
   * Lista «Personal» de la interna. Llega vacía a quien la RLS no deja leerla
   * (familia no administradora, apoyo y visor): no se filtra en la interfaz.
   */
  personal: ShoppingLine[];
}

interface FoodRow {
  id: string;
  name: string;
  section: string;
  package_size: string | null;
  package_unit: string | null;
}

interface PartAccumulator {
  unit: string | null;
  menu: bigint | null;
  manual: bigint | null;
  includesFixed: boolean;
}

interface LineAccumulator {
  key: string;
  name: string;
  section: string;
  foodId: string | null;
  parts: Map<string, PartAccumulator>;
  itemIds: string[];
  hasMenu: boolean;
  hasManual: boolean;
  packaging: { size: string; unit: string } | null;
}

function partOf(line: LineAccumulator, unit: string | null): PartAccumulator {
  const key = unit === null ? "" : normalizeShoppingUnit(unit);
  const existing = line.parts.get(key);
  if (existing) return existing;
  const created: PartAccumulator = { unit, menu: null, manual: null, includesFixed: false };
  line.parts.set(key, created);
  return created;
}

function finishLine(line: LineAccumulator, checked: boolean): ShoppingLine {
  const parts = [...line.parts.values()]
    .sort((a, b) => (a.unit ?? "").localeCompare(b.unit ?? "", "es"))
    .map((part) => {
      const total = part.menu === null && part.manual === null ? null : (part.menu ?? 0n) + (part.manual ?? 0n);
      const quantity = total === null ? null : formatHundredths(total);
      return {
        unit: part.unit,
        quantity,
        fromMenu: part.menu === null ? null : formatHundredths(part.menu),
        fromManual: part.manual === null ? null : formatHundredths(part.manual),
        includesFixed: part.includesFixed,
        packages:
          line.packaging === null || quantity === null
            ? null
            : packagesNeeded(quantity, part.unit, line.packaging.size, line.packaging.unit),
      } satisfies ShoppingPart;
    });
  return {
    key: line.key,
    name: line.name,
    section: line.section,
    foodId: line.foodId,
    origin: line.hasMenu && line.hasManual ? "mixed" : line.hasMenu ? "menu" : "manual",
    parts,
    itemIds: line.itemIds,
    checked,
    packaging: line.packaging,
  };
}

/**
 * Lista de la compra de la semana `weekStartsOn` (7 días) tal como se ve:
 *
 *  · La parte derivada del menú se calcula en lectura (ingredientes de las
 *    recetas asignadas, escalados por los comensales del grupo —o por
 *    `servings_override`— frente a `base_servings`; los 'fixed' entran
 *    intactos, AC-22). No se materializa ninguna fila.
 *  · Cada añadido a mano se FUSIONA con lo derivado cuando apunta al mismo
 *    alimento del catálogo o repite su nombre: una sola línea, con el desglose
 *    por origen a la vista («500 g del menú + 1 añadido»).
 *  · Si el alimento declara tamaño de paquete, cada parte trae además cuántos
 *    paquetes hacen falta.
 *  · `checked` sale de `app.shopping_line_checks` (semana + línea), de modo
 *    que también los artículos «del menú» se pueden marcar como comprados.
 *
 * La RLS decide qué filas llegan: la lista personal viene vacía para quien no
 * puede verla.
 */
export async function buildShoppingBoard(
  client: PoolClient,
  householdId: UUID,
  weekStartsOn: string,
): Promise<ShoppingBoard> {
  const foodResult = await client.query<FoodRow>(
    `select id, name, shopping_section as section,
            package_size::text as package_size, package_unit
       from app.foods
      where household_id = $1 and archived_at is null
      order by name`,
    [householdId],
  );
  const foodById = new Map(foodResult.rows.map((row) => [row.id, row]));
  const foodByName = new Map(foodResult.rows.map((row) => [normalizeShoppingName(row.name), row]));

  const packagingOf = (food: FoodRow | undefined): { size: string; unit: string } | null =>
    food?.package_size && food.package_unit
      ? { size: food.package_size, unit: food.package_unit }
      : null;

  const houseLines = new Map<string, LineAccumulator>();
  const personalLines = new Map<string, LineAccumulator>();

  const lineFor = (
    lines: Map<string, LineAccumulator>,
    key: string,
    seed: () => Omit<LineAccumulator, "parts" | "itemIds" | "hasMenu" | "hasManual">,
  ): LineAccumulator => {
    const existing = lines.get(key);
    if (existing) return existing;
    const created: LineAccumulator = {
      ...seed(),
      parts: new Map(),
      itemIds: [],
      hasMenu: false,
      hasManual: false,
    };
    lines.set(key, created);
    return created;
  };

  // ── Parte derivada del menú de la semana ──────────────────────────────────
  const menuResult = await client.query<{
    food_id: string;
    unit: string;
    quantity: string;
    scaling: string;
    base_servings: number;
    diner_count: number;
    servings_override: number | null;
  }>(
    `select ingredient.food_id, ingredient.unit, ingredient.quantity::text as quantity,
            ingredient.scaling, recipe.base_servings, slot.servings_override,
            (select count(*)::int from app.menu_group_diners as member
              where member.household_id = slot.household_id
                and member.group_id = slot.group_id) as diner_count
       from app.menu_slots as slot
       join app.recipes as recipe
         on recipe.household_id = slot.household_id and recipe.page_id = slot.recipe_page_id
        and recipe.archived_at is null
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

  for (const row of menuResult.rows) {
    const food = foodById.get(row.food_id);
    if (!food) continue;
    // Raciones objetivo: override explícito del hueco, si no el nº de
    // comensales del grupo; un grupo vacío cae a base_servings (factor 1).
    const target = row.servings_override ?? (row.diner_count > 0 ? row.diner_count : row.base_servings);
    const scaled = scaleIngredientHundredths(
      toHundredths(row.quantity),
      row.scaling === "linear" ? "linear" : "fixed",
      target,
      row.base_servings,
    );
    const line = lineFor(houseLines, foodLineKey(row.food_id), () => ({
      key: foodLineKey(row.food_id),
      name: food.name,
      section: food.section,
      foodId: food.id,
      packaging: packagingOf(food),
    }));
    line.hasMenu = true;
    const part = partOf(line, row.unit);
    part.menu = (part.menu ?? 0n) + scaled;
    part.includesFixed = part.includesFixed || row.scaling !== "linear";
  }

  // ── Añadidos a mano de la semana (y los que no tienen semana) ─────────────
  const manualResult = await client.query<{
    id: string;
    food_id: string | null;
    custom_name: string | null;
    quantity: string | null;
    unit: string | null;
    section: string;
    list_kind: ShoppingListKind;
  }>(
    `select item.id, item.food_id, item.custom_name, item.quantity::text as quantity,
            item.unit, item.section, item.list_kind
       from app.shopping_items as item
      where item.household_id = $1
        and (item.week_starts_on is null or item.week_starts_on = $2::date)
      order by item.created_at, item.id`,
    [householdId, weekStartsOn],
  );

  for (const row of manualResult.rows) {
    const catalogFood =
      (row.food_id ? foodById.get(row.food_id) : undefined) ??
      (row.food_id === null && row.custom_name && row.list_kind === "casa"
        ? foodByName.get(normalizeShoppingName(row.custom_name))
        : undefined);
    const rawName = catalogFood?.name ?? row.custom_name ?? "";
    const key = catalogFood ? foodLineKey(catalogFood.id) : nameLineKey(rawName);
    const lines = row.list_kind === "personal" ? personalLines : houseLines;
    const line = lineFor(lines, key, () => ({
      key,
      name: rawName,
      section: catalogFood?.section ?? row.section,
      foodId: catalogFood?.id ?? null,
      packaging: packagingOf(catalogFood),
    }));
    line.hasManual = true;
    line.itemIds.push(row.id);
    const part = partOf(line, row.unit);
    if (row.quantity !== null) part.manual = (part.manual ?? 0n) + toHundredths(row.quantity);
  }

  // ── Marcado por línea de esta semana ──────────────────────────────────────
  const checkResult = await client.query<{ list_kind: ShoppingListKind; line_key: string }>(
    `select list_kind, line_key from app.shopping_line_checks
      where household_id = $1 and week_starts_on = $2::date`,
    [householdId, weekStartsOn],
  );
  const checked = new Set(checkResult.rows.map((row) => `${row.list_kind}|${row.line_key}`));

  const sections = new Map<string, ShoppingLine[]>();
  for (const line of houseLines.values()) {
    const list = sections.get(line.section) ?? [];
    list.push(finishLine(line, checked.has(`casa|${line.key}`)));
    sections.set(line.section, list);
  }

  return {
    weekStartsOn,
    sections: [...sections.entries()]
      .sort(([a], [b]) => a.localeCompare(b, "es"))
      .map(([section, lines]) => ({
        section,
        lines: lines.sort((a, b) => a.name.localeCompare(b.name, "es")),
      })),
    personal: [...personalLines.values()]
      .map((line) => finishLine(line, checked.has(`personal|${line.key}`)))
      .sort((a, b) => a.name.localeCompare(b.name, "es")),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Comandos de la compra
// ─────────────────────────────────────────────────────────────────────────────

function requireShoppingWriter(role: string, listKind: ShoppingListKind): void {
  const allowed = listKind === "personal" ? PERSONAL_ROLES : HOUSE_WRITER_ROLES;
  if (!allowed.has(role)) {
    throw new CommandRejectedError(
      "not_allowed",
      listKind === "personal"
        ? "La lista personal es de la persona interna y de quien administra la casa"
        : "Este rol no puede escribir en la lista de la compra",
    );
  }
}

/**
 * `shopping_item` — add / set_checked / set_line_checked.
 *
 * `set_line_checked` marca la LÍNEA completa de una semana: escribe el hecho en
 * `app.shopping_line_checks` (que es lo que permite marcar también lo que viene
 * del menú, sin materializarlo) y refleja el mismo estado en los añadidos
 * manuales fusionados, para que ninguna lectura heredada mienta.
 */
export const shoppingItemCommandHandler: CommandHandler = async (client, membership, envelope) => {
  const householdId = envelope.householdId;
  const action = (envelope.payload as { action?: unknown } | null)?.action;

  if (action === "add") {
    const parsed = shoppingAddPayloadSchema.safeParse(envelope.payload);
    if (!parsed.success) {
      throw new CommandRejectedError("invalid_payload", parsed.error.issues[0]?.message);
    }
    const payload = parsed.data;
    const listKind: ShoppingListKind = payload.listKind ?? "casa";
    requireShoppingWriter(membership.role, listKind);

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
          list_kind, created_by_membership_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       returning id`,
      [
        householdId,
        payload.foodId ?? null,
        payload.foodId === undefined ? (payload.customName ?? "").trim() : null,
        payload.quantity === undefined ? null : normalizeQuantity(payload.quantity),
        payload.unit ?? null,
        section ?? (listKind === "personal" ? "personal" : "despensa"),
        payload.weekStartsOn ?? null,
        listKind,
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
    requireShoppingWriter(membership.role, "casa");
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

  if (action === "set_line_checked") {
    const parsed = shoppingSetLineCheckedPayloadSchema.safeParse(envelope.payload);
    if (!parsed.success) {
      throw new CommandRejectedError("invalid_payload", parsed.error.issues[0]?.message);
    }
    const payload = parsed.data;
    const listKind: ShoppingListKind = payload.listKind ?? "casa";
    requireShoppingWriter(membership.role, listKind);

    // Una clave de alimento debe existir en el hogar: así un cliente viejo o
    // manipulado no puede sembrar marcados huérfanos.
    let foodId: string | null = null;
    let foodName: string | null = null;
    if (payload.lineKey.startsWith("food:")) {
      const food = await client.query<{ id: string; name: string }>(
        `select id, name from app.foods where household_id = $1 and id = $2`,
        [householdId, payload.lineKey.slice("food:".length)],
      );
      const row = food.rows[0];
      if (!row) throw new CommandRejectedError("food_not_found", "El alimento no existe en este hogar");
      foodId = row.id;
      foodName = row.name.trim().toLowerCase();
    }
    const freeName = foodId === null ? payload.lineKey.slice("name:".length) : null;

    if (payload.checked) {
      await client.query(
        `insert into app.shopping_line_checks
           (household_id, week_starts_on, list_kind, line_key, checked_by_membership_id)
         values ($1, $2::date, $3, $4, $5)
         on conflict (household_id, week_starts_on, list_kind, line_key) do update
           set checked_at = statement_timestamp(),
               checked_by_membership_id = excluded.checked_by_membership_id`,
        [householdId, payload.weekStartsOn, listKind, payload.lineKey, membership.id],
      );
    } else {
      await client.query(
        `delete from app.shopping_line_checks
          where household_id = $1 and week_starts_on = $2::date
            and list_kind = $3 and line_key = $4`,
        [householdId, payload.weekStartsOn, listKind, payload.lineKey],
      );
    }

    // Espejo en los añadidos manuales que la línea fusiona.
    await client.query(
      `update app.shopping_items as item
          set checked_at = case when $5 then statement_timestamp() else null end
        where item.household_id = $1
          and item.list_kind = $3
          and (item.week_starts_on is null or item.week_starts_on = $2::date)
          and (
            ($4::uuid is not null and (
               item.food_id = $4::uuid
               or (item.food_id is null and lower(btrim(item.custom_name)) = $6)
            ))
            or ($4::uuid is null and item.food_id is null
                and lower(btrim(item.custom_name)) = $6)
          )`,
      [householdId, payload.weekStartsOn, listKind, foodId, payload.checked, foodName ?? freeName],
    );
    return {};
  }

  throw new CommandRejectedError("invalid_payload", "Acción de compra desconocida");
};
