import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  API_VERSION,
  type AggregateType,
  type CommandAckV1,
  type CommandEnvelopeV1,
  type UUID,
} from "@housekeeper/contracts";

import { foodCommandHandlers } from "./commands/food-handlers.js";
import { recipeCommandHandler } from "./commands/food.js";
import { menuSlotCommandHandler } from "./commands/menu.js";
import { buildShoppingBoard, packagesNeeded, type ShoppingLine } from "./commands/shopping.js";
import { wikiCommandHandlers } from "./commands/wiki.js";
import { withAuthorizedTransaction, type AuthenticatedPrincipal } from "./database.js";
import { computeMenuSlotHash } from "./menu-hash.js";
import { processSyncBatch } from "./sync.js";

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const ROBLE_HOUSEHOLD = "10000000-0000-4000-8000-000000000001";
const APP_LOGIN = "it_housekeeper_app_login";

const ADMIN: AuthenticatedPrincipal = { userId: "fixture:roble:admin" };
const EMPLOYEE: AuthenticatedPrincipal = { userId: "fixture:roble:employee" };
const HELPER: AuthenticatedPrincipal = { userId: "fixture:roble:helper" };

const HANDLERS = { ...wikiCommandHandlers, ...foodCommandHandlers };

// Semanas propias de este suite, sin solaparse entre sí ni con otros tests.
const SCALE_WEEK = "2026-04-06";
const DUP_FROM_WEEK = "2026-05-04";
const DUP_TO_WEEK = "2026-05-11";
const AGG_WEEK = "2026-06-01";
const FUSION_WEEK = "2026-06-08";
const PACKAGE_WEEK = "2026-06-15";
const CHECK_WEEK = "2026-06-22";
const PERSONAL_WEEK = "2026-06-29";
const EMPLOYEE_WEEK = "2026-07-06";

/** Una fila por (línea, unidad): la forma corta con la que se leen los asserts. */
function flatten(
  sections: ReadonlyArray<{ section: string; lines: ShoppingLine[] }>,
): Array<{ name: string; section: string; unit: string | null; quantity: string | null; origin: string }> {
  return sections.flatMap((section) =>
    section.lines.flatMap((line) =>
      (line.parts.length > 0 ? line.parts : [{ unit: null, quantity: null }]).map((part) => ({
        name: line.name,
        section: section.section,
        unit: part.unit,
        quantity: part.quantity,
        origin: line.origin,
      })),
    ),
  );
}

function lineNamed(
  sections: ReadonlyArray<{ section: string; lines: ShoppingLine[] }>,
  name: string,
): ShoppingLine {
  const found = sections.flatMap((section) => section.lines).find((line) => line.name === name);
  if (!found) throw new Error(`No hay línea de compra llamada ${name}`);
  return found;
}

function envelope(aggregateType: AggregateType, payload: unknown): CommandEnvelopeV1 {
  return {
    apiVersion: API_VERSION,
    operationId: randomUUID(),
    householdId: ROBLE_HOUSEHOLD,
    schemaVersion: 1,
    aggregateType,
    aggregateId: null,
    baseRevision: null,
    occurredAt: "2026-08-07T10:00:00.000Z",
    payload,
  };
}

describe.runIf(Boolean(adminUrl))("comida, menú y compra sobre Postgres real", () => {
  let adminPool: pg.Pool;
  let appPool: pg.Pool;

  async function run(
    principal: AuthenticatedPrincipal,
    aggregateType: AggregateType,
    payload: unknown,
  ): Promise<CommandAckV1> {
    const result = await processSyncBatch(appPool, principal, [envelope(aggregateType, payload)], HANDLERS);
    expect(result.acknowledgements).toHaveLength(1);
    return result.acknowledgements[0] as CommandAckV1;
  }

  async function accept(
    principal: AuthenticatedPrincipal,
    aggregateType: AggregateType,
    payload: unknown,
  ): Promise<UUID> {
    const ack = await run(principal, aggregateType, payload);
    expect(ack, `${aggregateType}: ${JSON.stringify(ack)}`).toMatchObject({ status: "accepted" });
    return ack.resourceId as UUID;
  }

  async function slotHash(slotId: UUID): Promise<string | null> {
    return withAuthorizedTransaction(appPool, ADMIN, ROBLE_HOUSEHOLD, (client) =>
      computeMenuSlotHash(client, ROBLE_HOUSEHOLD, slotId),
    );
  }

  // Catálogo sembrado en beforeAll a través de los propios comandos.
  let harinaId: UUID;
  let lecheId: UUID;
  let arrozFoodId: UUID;
  let aceiteId: UUID;
  let salsaId: UUID;
  let abuelaId: UUID;
  let mesaAbuelaId: UUID;
  let seisGroupId: UUID;
  let bizcochoPageId: UUID;
  let arrozPageId: UUID;
  let salsaPageId: UUID;

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: adminUrl, max: 2 });
    const url = new URL(adminUrl as string);
    url.username = APP_LOGIN;
    url.password = "integration-only";
    appPool = new pg.Pool({ connectionString: url.toString(), max: 2 });

    const food = (name: string, section: string, codes: string[], reviewed: boolean) =>
      accept(ADMIN, "food", {
        action: "upsert",
        name,
        shoppingSection: section,
        allergenCodes: codes,
        reviewed,
      });
    harinaId = await food("Harina de trigo IT", "despensa", ["gluten"], true);
    lecheId = await food("Leche entera IT", "nevera", ["lacteos"], true);
    arrozFoodId = await food("Arroz bomba IT", "despensa", [], true);
    aceiteId = await food("Aceite de oliva IT", "despensa", [], true);
    salsaId = await food("Salsa misteriosa IT", "despensa", [], false);

    abuelaId = await accept(ADMIN, "diner", {
      action: "upsert",
      name: "Abuela IT",
      flags: [{ allergenCode: "gluten", severity: "high", note: "Celiaquía" }],
    });
    const nino = await accept(ADMIN, "diner", { action: "upsert", name: "Niño IT", flags: [] });
    mesaAbuelaId = await accept(ADMIN, "menu_group", {
      action: "upsert",
      name: "Mesa de la abuela IT",
      dinerIds: [abuelaId, nino],
    });

    const seis: UUID[] = [];
    for (let index = 1; index <= 6; index += 1) {
      seis.push(await accept(ADMIN, "diner", { action: "upsert", name: `Comensal ${index} IT`, flags: [] }));
    }
    seisGroupId = await accept(ADMIN, "menu_group", {
      action: "upsert",
      name: "Mesa de seis IT",
      dinerIds: seis,
    });

    const spaceAck = await run(ADMIN, "wiki_space", { action: "create", name: "Recetas IT" });
    expect(spaceAck.status).toBe("accepted");
    const spaceId = spaceAck.resourceId as UUID;
    const page = (title: string) =>
      accept(ADMIN, "wiki_page", {
        action: "create",
        spaceId,
        title,
        bodyMarkdown: `Receta: ${title}.`,
        publish: true,
      });
    bizcochoPageId = await page("Bizcocho de la abuela IT");
    arrozPageId = await page("Arroz con leche IT");
    salsaPageId = await page("Salsa de la casa IT");
  });

  afterAll(async () => {
    await appPool?.end();
    await adminPool?.end();
  });

  it("upserts de catálogo: los mapeos de alérgenos y flags se reemplazan por completo", async () => {
    const updated = await accept(ADMIN, "food", {
      action: "upsert",
      foodId: harinaId,
      name: "Harina de trigo IT",
      shoppingSection: "despensa",
      allergenCodes: ["gluten", "sesamo"],
      reviewed: true,
    });
    expect(updated).toBe(harinaId);
    let codes = await adminPool.query(
      `select allergen_code from app.food_allergens where food_id = $1 order by allergen_code`,
      [harinaId],
    );
    expect(codes.rows.map((row) => row.allergen_code)).toEqual(["gluten", "sesamo"]);

    await accept(ADMIN, "food", {
      action: "upsert",
      foodId: harinaId,
      name: "Harina de trigo IT",
      shoppingSection: "despensa",
      allergenCodes: ["gluten"],
      reviewed: true,
    });
    codes = await adminPool.query(
      `select allergen_code from app.food_allergens where food_id = $1 order by allergen_code`,
      [harinaId],
    );
    expect(codes.rows.map((row) => row.allergen_code)).toEqual(["gluten"]);

    const unknown = await run(ADMIN, "food", {
      action: "upsert",
      name: "Alimento inválido IT",
      shoppingSection: "despensa",
      allergenCodes: ["kriptonita"],
      reviewed: true,
    });
    expect(unknown).toMatchObject({ status: "rejected", errorCode: "unknown_allergen" });

    // El upsert del comensal reemplaza sus flags, no las acumula.
    await accept(ADMIN, "diner", {
      action: "upsert",
      dinerId: abuelaId,
      name: "Abuela IT",
      flags: [{ allergenCode: "gluten", severity: "high", note: "Celiaquía" }],
    });
    const flags = await adminPool.query(
      `select allergen_code, severity from app.diner_flags where diner_id = $1 order by allergen_code`,
      [abuelaId],
    );
    expect(flags.rows).toEqual([{ allergen_code: "gluten", severity: "high" }]);
  });

  it("un alimento sin revisar bloquea recipe.set_details y menu_slot.set, sin excepción", async () => {
    // set_details con la salsa sin revisar → rechazo con el alimento en el mensaje.
    await expect(
      withAuthorizedTransaction(appPool, ADMIN, ROBLE_HOUSEHOLD, (client, membership) =>
        recipeCommandHandler(
          client,
          membership,
          envelope("recipe", {
            action: "set_details",
            pageId: salsaPageId,
            baseServings: 2,
            ingredients: [{ foodId: salsaId, quantity: "12,5", unit: "g", scaling: "linear" }],
          }),
        ),
      ),
    ).rejects.toMatchObject({
      errorCode: "food_unreviewed",
      message: expect.stringContaining("Salsa misteriosa IT"),
    });

    // Revisada la salsa, la receta entra; la cantidad "12,5" se normaliza a 12.50.
    await accept(ADMIN, "food", {
      action: "upsert",
      foodId: salsaId,
      name: "Salsa misteriosa IT",
      shoppingSection: "despensa",
      allergenCodes: ["sulfitos"],
      reviewed: true,
    });
    await accept(ADMIN, "recipe", {
      action: "set_details",
      pageId: salsaPageId,
      baseServings: 2,
      ingredients: [{ foodId: salsaId, quantity: "12,5", unit: "g", scaling: "linear" }],
    });
    const stored = await adminPool.query(
      `select quantity::text as quantity from app.recipe_ingredients where page_id = $1`,
      [salsaPageId],
    );
    expect(stored.rows).toEqual([{ quantity: "12.50" }]);

    // Recetas que usan el resto de la suite.
    await accept(ADMIN, "recipe", {
      action: "set_details",
      pageId: bizcochoPageId,
      baseServings: 4,
      timeMinutes: 60,
      ingredients: [
        { foodId: harinaId, quantity: "200", unit: "g", scaling: "linear" },
        { foodId: lecheId, quantity: "250", unit: "ml", scaling: "linear" },
        { foodId: aceiteId, quantity: "1", unit: "ud", scaling: "fixed" },
      ],
    });
    await accept(ADMIN, "recipe", {
      action: "set_details",
      pageId: arrozPageId,
      baseServings: 4,
      ingredients: [
        { foodId: lecheId, quantity: "500", unit: "ml", scaling: "linear" },
        { foodId: arrozFoodId, quantity: "100", unit: "g", scaling: "linear" },
      ],
    });

    // Si la salsa vuelve a quedar sin revisar, su receta ya no puede asignarse al menú.
    await accept(ADMIN, "food", {
      action: "upsert",
      foodId: salsaId,
      name: "Salsa misteriosa IT",
      shoppingSection: "despensa",
      allergenCodes: ["sulfitos"],
      reviewed: false,
    });
    const blocked = await run(ADMIN, "menu_slot", {
      action: "set",
      groupId: mesaAbuelaId,
      onDate: "2026-03-02",
      meal: "cena",
      recipePageId: salsaPageId,
    });
    expect(blocked).toMatchObject({ status: "rejected", errorCode: "food_unreviewed" });
  });

  let bizcochoSlotId: UUID;

  it("AC-21: receta incompatible sin acknowledge se rechaza y con acknowledge procede", async () => {
    // Bizcocho lleva harina (gluten) y la abuela tiene flag de gluten.
    await expect(
      withAuthorizedTransaction(appPool, ADMIN, ROBLE_HOUSEHOLD, (client, membership) =>
        menuSlotCommandHandler(
          client,
          membership,
          envelope("menu_slot", {
            action: "set",
            groupId: mesaAbuelaId,
            onDate: "2026-03-02",
            meal: "merienda",
            recipePageId: bizcochoPageId,
          }),
        ),
      ),
    ).rejects.toMatchObject({
      errorCode: "allergen_conflict",
      message: expect.stringContaining("gluten"),
    });

    bizcochoSlotId = await accept(ADMIN, "menu_slot", {
      action: "set",
      groupId: mesaAbuelaId,
      onDate: "2026-03-02",
      meal: "merienda",
      recipePageId: bizcochoPageId,
      acknowledgeAllergens: true,
    });

    // Sin intersección (arroz con leche: lácteos; nadie del grupo los declara) no hace falta acknowledge.
    const compatible = await run(ADMIN, "menu_slot", {
      action: "set",
      groupId: mesaAbuelaId,
      onDate: "2026-03-02",
      meal: "comida",
      recipePageId: arrozPageId,
    });
    expect(compatible).toMatchObject({ status: "accepted" });
  });

  it("confirm: hash vigente confirma; cambiar un flag del comensal invalida el mismo hash", async () => {
    const hash = await slotHash(bizcochoSlotId);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);

    await accept(ADMIN, "menu_slot", { action: "confirm", slotId: bizcochoSlotId, contentHash: hash });
    const confirmed = await adminPool.query(
      `select content_hash from app.menu_confirmations where slot_id = $1`,
      [bizcochoSlotId],
    );
    expect(confirmed.rows).toEqual([{ content_hash: hash }]);

    // Un DietaryFlag nuevo de la abuela cambia el contenido canónico del hueco.
    await accept(ADMIN, "diner", {
      action: "upsert",
      dinerId: abuelaId,
      name: "Abuela IT",
      flags: [
        { allergenCode: "gluten", severity: "high", note: "Celiaquía" },
        { allergenCode: "lacteos", severity: "medium" },
      ],
    });
    expect(await slotHash(bizcochoSlotId)).not.toBe(hash);

    const stale = await run(ADMIN, "menu_slot", {
      action: "confirm",
      slotId: bizcochoSlotId,
      contentHash: hash,
    });
    expect(stale).toMatchObject({ status: "conflict", errorCode: "menu_content_changed" });

    // Con el hash recalculado la confirmación vuelve a entrar.
    const fresh = await slotHash(bizcochoSlotId);
    await accept(ADMIN, "menu_slot", { action: "confirm", slotId: bizcochoSlotId, contentHash: fresh });
  });

  it("AC-22: escalado 4→6 multiplica los lineales por 1,5 exacto y respeta los 'fixed'", async () => {
    await accept(ADMIN, "menu_slot", {
      action: "set",
      groupId: seisGroupId,
      onDate: SCALE_WEEK,
      meal: "comida",
      recipePageId: bizcochoPageId,
    });

    const board = await withAuthorizedTransaction(appPool, ADMIN, ROBLE_HOUSEHOLD, (client) =>
      buildShoppingBoard(client, ROBLE_HOUSEHOLD, SCALE_WEEK),
    );
    expect(flatten(board.sections)).toEqual([
      // El aceite es 'fixed': no escala con las raciones y se dice.
      { name: "Aceite de oliva IT", section: "despensa", unit: "ud", quantity: "1", origin: "menu" },
      { name: "Harina de trigo IT", section: "despensa", unit: "g", quantity: "300", origin: "menu" },
      { name: "Leche entera IT", section: "nevera", unit: "ml", quantity: "375", origin: "menu" },
    ]);
    const aceite = lineNamed(board.sections, "Aceite de oliva IT");
    expect(aceite.parts[0]?.includesFixed).toBe(true);
    expect(lineNamed(board.sections, "Harina de trigo IT").parts[0]?.includesFixed).toBe(false);
  });

  it("AC-23: duplicate_week dos veces produce el mismo resultado sin duplicados", async () => {
    await accept(ADMIN, "menu_slot", {
      action: "set",
      groupId: mesaAbuelaId,
      onDate: DUP_FROM_WEEK,
      meal: "comida",
      freeText: "Lentejas IT",
      notes: "Sin chorizo",
    });
    await accept(ADMIN, "menu_slot", {
      action: "set",
      groupId: seisGroupId,
      onDate: "2026-05-06",
      meal: "cena",
      recipePageId: arrozPageId,
      servingsOverride: 8,
    });

    const overlap = await run(ADMIN, "menu_slot", {
      action: "duplicate_week",
      fromWeekStartsOn: DUP_FROM_WEEK,
      toWeekStartsOn: "2026-05-07",
    });
    expect(overlap).toMatchObject({ status: "rejected", errorCode: "week_overlap" });

    const duplicate = () =>
      run(ADMIN, "menu_slot", {
        action: "duplicate_week",
        fromWeekStartsOn: DUP_FROM_WEEK,
        toWeekStartsOn: DUP_TO_WEEK,
      });
    expect(await duplicate()).toMatchObject({ status: "accepted" });

    const targetRows = () =>
      adminPool.query(
        `select id, group_id, on_date::text as on_date, meal, recipe_page_id, free_text,
                notes, servings_override
           from app.menu_slots
          where household_id = $1 and on_date >= $2::date and on_date <= $2::date + 6
          order by on_date, meal, group_id`,
        [ROBLE_HOUSEHOLD, DUP_TO_WEEK],
      );
    const firstPass = await targetRows();
    expect(firstPass.rows).toHaveLength(2);
    expect(firstPass.rows.map((row) => [row.on_date, row.free_text, row.recipe_page_id])).toEqual([
      ["2026-05-11", "Lentejas IT", null],
      ["2026-05-13", "", arrozPageId],
    ]);
    expect(firstPass.rows[1]).toMatchObject({ servings_override: 8, group_id: seisGroupId });

    // Confirmamos un hueco destino: la segunda duplicación debe invalidarlo.
    const targetSlotId = firstPass.rows[0]?.id as UUID;
    const hash = await slotHash(targetSlotId);
    await accept(ADMIN, "menu_slot", { action: "confirm", slotId: targetSlotId, contentHash: hash });

    expect(await duplicate()).toMatchObject({ status: "accepted" });
    const secondPass = await targetRows();
    expect(secondPass.rows).toEqual(firstPass.rows);

    const confirmations = await adminPool.query(
      `select 1 from app.menu_confirmations where slot_id = $1`,
      [targetSlotId],
    );
    expect(confirmations.rows).toHaveLength(0);
  });

  it("AC-24: la compra agrega ingredientes iguales de dos recetas por unidad y sección más añadidos", async () => {
    // Factor 1 (override = base) para aislar la agregación del escalado.
    await accept(ADMIN, "menu_slot", {
      action: "set",
      groupId: seisGroupId,
      onDate: AGG_WEEK,
      meal: "comida",
      recipePageId: bizcochoPageId,
      servingsOverride: 4,
    });
    await accept(ADMIN, "menu_slot", {
      action: "set",
      groupId: seisGroupId,
      onDate: AGG_WEEK,
      meal: "cena",
      recipePageId: arrozPageId,
      servingsOverride: 4,
    });

    // Añadidos manuales: misma leche en ml (se suma), en litros (entrada aparte)
    // y un artículo libre sin cantidad.
    await accept(ADMIN, "shopping_item", {
      action: "add",
      foodId: lecheId,
      quantity: "250",
      unit: "ml",
      weekStartsOn: AGG_WEEK,
    });
    await accept(ADMIN, "shopping_item", {
      action: "add",
      foodId: lecheId,
      quantity: "1",
      unit: "l",
      weekStartsOn: AGG_WEEK,
    });
    await accept(ADMIN, "shopping_item", {
      action: "add",
      customName: "Papel de cocina IT",
      section: "hogar",
      weekStartsOn: AGG_WEEK,
    });

    const board = await withAuthorizedTransaction(appPool, ADMIN, ROBLE_HOUSEHOLD, (client) =>
      buildShoppingBoard(client, ROBLE_HOUSEHOLD, AGG_WEEK),
    );
    expect(flatten(board.sections)).toEqual([
      { name: "Aceite de oliva IT", section: "despensa", unit: "ud", quantity: "1", origin: "menu" },
      { name: "Arroz bomba IT", section: "despensa", unit: "g", quantity: "100", origin: "menu" },
      { name: "Harina de trigo IT", section: "despensa", unit: "g", quantity: "200", origin: "menu" },
      { name: "Papel de cocina IT", section: "hogar", unit: null, quantity: null, origin: "manual" },
      // P2-4: la leche del menú y las dos añadidas a mano van en UNA línea, con
      // una parte por unidad (el litro no se convierte a mililitros a la brava).
      { name: "Leche entera IT", section: "nevera", unit: "l", quantity: "1", origin: "mixed" },
      { name: "Leche entera IT", section: "nevera", unit: "ml", quantity: "1000", origin: "mixed" },
    ]);

    const leche = lineNamed(board.sections, "Leche entera IT");
    expect(leche.itemIds).toHaveLength(2);
    // 250 (bizcocho) + 500 (arroz con leche) del menú y 250 a mano, en ml.
    expect(leche.parts.map((part) => [part.unit, part.fromMenu, part.fromManual])).toEqual([
      ["l", null, "1"],
      ["ml", "750", "250"],
    ]);
  });

  it("P2-4: un añadido a mano con el nombre del alimento se fusiona con lo del menú", async () => {
    await accept(ADMIN, "menu_slot", {
      action: "set",
      groupId: seisGroupId,
      onDate: FUSION_WEEK,
      meal: "comida",
      recipePageId: arrozPageId,
      servingsOverride: 4,
    });
    // Escrito a mano, sin elegir el alimento del catálogo: «leche entera it».
    await accept(ADMIN, "shopping_item", {
      action: "add",
      customName: "  LECHE ENTERA IT ",
      quantity: "2",
      unit: "ml",
      section: "hogar",
      weekStartsOn: FUSION_WEEK,
    });

    const board = await withAuthorizedTransaction(appPool, ADMIN, ROBLE_HOUSEHOLD, (client) =>
      buildShoppingBoard(client, ROBLE_HOUSEHOLD, FUSION_WEEK),
    );
    const leche = lineNamed(board.sections, "Leche entera IT");
    // Una sola línea, en la sección del alimento del catálogo (no en «hogar»).
    expect(board.sections.filter((section) => section.lines.some((line) => line.name === "Leche entera IT")))
      .toHaveLength(1);
    expect(leche.section).toBe("nevera");
    expect(leche.origin).toBe("mixed");
    expect(leche.parts).toEqual([
      expect.objectContaining({ unit: "ml", quantity: "502", fromMenu: "500", fromManual: "2" }),
    ]);
  });

  it("P2-4: el tamaño de paquete del alimento redondea la compra a paquetes enteros", async () => {
    const arrozPaquete = await accept(ADMIN, "food", {
      action: "upsert",
      foodId: arrozFoodId,
      name: "Arroz bomba IT",
      shoppingSection: "despensa",
      allergenCodes: [],
      reviewed: true,
      packaging: { size: "500", unit: "g" },
    });
    expect(arrozPaquete).toBe(arrozFoodId);

    await accept(ADMIN, "menu_slot", {
      action: "set",
      groupId: seisGroupId,
      onDate: PACKAGE_WEEK,
      meal: "comida",
      recipePageId: arrozPageId,
      servingsOverride: 4,
    });
    // La harina no declara paquete: su cantidad se muestra exacta, sin inventar.
    await accept(ADMIN, "menu_slot", {
      action: "set",
      groupId: seisGroupId,
      onDate: PACKAGE_WEEK,
      meal: "cena",
      recipePageId: bizcochoPageId,
      servingsOverride: 4,
    });

    const board = await withAuthorizedTransaction(appPool, ADMIN, ROBLE_HOUSEHOLD, (client) =>
      buildShoppingBoard(client, ROBLE_HOUSEHOLD, PACKAGE_WEEK),
    );
    const arroz = lineNamed(board.sections, "Arroz bomba IT");
    expect(arroz.packaging).toEqual({ size: "500", unit: "g" });
    // 100 g de arroz → un paquete de 500 g basta.
    expect(arroz.parts[0]).toMatchObject({ unit: "g", quantity: "100", packages: 1 });
    expect(lineNamed(board.sections, "Harina de trigo IT").parts[0]).toMatchObject({ packages: null });

    // Y la regla es pura: 1,2 kg con paquetes de 500 g son tres paquetes.
    expect(packagesNeeded("1,2", "kg", "500", "g")).toBe(3);
    expect(packagesNeeded("350", "g", "500", "g")).toBe(1);
    // Unidades incomparables (peso frente a piezas) → cantidad exacta.
    expect(packagesNeeded("3", "ud", "500", "g")).toBeNull();
  });

  it("P2-4: marcar la línea marca también lo que viene del menú y arrastra sus añadidos", async () => {
    await accept(ADMIN, "menu_slot", {
      action: "set",
      groupId: seisGroupId,
      onDate: CHECK_WEEK,
      meal: "comida",
      recipePageId: arrozPageId,
      servingsOverride: 4,
    });
    const manualId = await accept(ADMIN, "shopping_item", {
      action: "add",
      foodId: lecheId,
      quantity: "1",
      unit: "l",
      weekStartsOn: CHECK_WEEK,
    });

    const lineKey = `food:${lecheId}`;
    await accept(EMPLOYEE, "shopping_item", {
      action: "set_line_checked",
      weekStartsOn: CHECK_WEEK,
      lineKey,
      checked: true,
    });

    const marked = await withAuthorizedTransaction(appPool, ADMIN, ROBLE_HOUSEHOLD, (client) =>
      buildShoppingBoard(client, ROBLE_HOUSEHOLD, CHECK_WEEK),
    );
    const leche = lineNamed(marked.sections, "Leche entera IT");
    expect(leche.origin).toBe("mixed");
    expect(leche.checked).toBe(true);
    // El añadido fusionado queda marcado también: ninguna lectura miente.
    const mirrored = await adminPool.query(
      `select checked_at is not null as checked from app.shopping_items where id = $1`,
      [manualId],
    );
    expect(mirrored.rows).toEqual([{ checked: true }]);

    // El arroz de la misma receta sigue sin marcar: se marca por línea.
    expect(lineNamed(marked.sections, "Arroz bomba IT").checked).toBe(false);

    await accept(ADMIN, "shopping_item", {
      action: "set_line_checked",
      weekStartsOn: CHECK_WEEK,
      lineKey,
      checked: false,
    });
    const cleared = await withAuthorizedTransaction(appPool, ADMIN, ROBLE_HOUSEHOLD, (client) =>
      buildShoppingBoard(client, ROBLE_HOUSEHOLD, CHECK_WEEK),
    );
    expect(lineNamed(cleared.sections, "Leche entera IT").checked).toBe(false);

    // Una clave de alimento inventada no puede sembrar marcados huérfanos.
    const ghost = await run(ADMIN, "shopping_item", {
      action: "set_line_checked",
      weekStartsOn: CHECK_WEEK,
      lineKey: "food:00000000-0000-4000-8000-0000000000ff",
      checked: true,
    });
    expect(ghost).toMatchObject({ status: "rejected", errorCode: "food_not_found" });
  });

  it("lista Personal: la escriben empleada y administración; el resto ni la ve ni la escribe", async () => {
    await accept(EMPLOYEE, "shopping_item", {
      action: "add",
      customName: "Champú de la interna IT",
      quantity: "1",
      unit: "ud",
      weekStartsOn: PERSONAL_WEEK,
      listKind: "personal",
    });

    // La administración familiar la ve (verificación de la compra personal).
    const adminBoard = await withAuthorizedTransaction(appPool, ADMIN, ROBLE_HOUSEHOLD, (client) =>
      buildShoppingBoard(client, ROBLE_HOUSEHOLD, PERSONAL_WEEK),
    );
    expect(adminBoard.personal.map((line) => line.name)).toEqual(["Champú de la interna IT"]);
    expect(adminBoard.sections).toEqual([]);

    // RLS real: el apoyo no recibe ni una fila personal.
    const helperBoard = await withAuthorizedTransaction(appPool, HELPER, ROBLE_HOUSEHOLD, (client) =>
      buildShoppingBoard(client, ROBLE_HOUSEHOLD, PERSONAL_WEEK),
    );
    expect(helperBoard.personal).toEqual([]);

    const helperWrite = await run(HELPER, "shopping_item", {
      action: "add",
      customName: "Intento del apoyo",
      weekStartsOn: PERSONAL_WEEK,
      listKind: "personal",
    });
    expect(helperWrite).toMatchObject({ status: "rejected", errorCode: "not_allowed" });

    // La lista personal se escribe a mano: no admite alimentos del catálogo.
    const withCatalogFood = await run(EMPLOYEE, "shopping_item", {
      action: "add",
      foodId: lecheId,
      weekStartsOn: PERSONAL_WEEK,
      listKind: "personal",
    });
    expect(withCatalogFood).toMatchObject({ status: "rejected", errorCode: "invalid_payload" });

    // Y se marca con el mismo mecanismo de línea que la de casa.
    await accept(EMPLOYEE, "shopping_item", {
      action: "set_line_checked",
      weekStartsOn: PERSONAL_WEEK,
      lineKey: "name:champú de la interna it",
      listKind: "personal",
      checked: true,
    });
    const checkedBoard = await withAuthorizedTransaction(appPool, EMPLOYEE, ROBLE_HOUSEHOLD, (client) =>
      buildShoppingBoard(client, ROBLE_HOUSEHOLD, PERSONAL_WEEK),
    );
    expect(checkedBoard.personal[0]?.checked).toBe(true);
  });

  it("roles: el apoyo no escribe menú ni compra; la empleada no escribe menú pero sí añade a la compra", async () => {
    const helperMenu = await run(HELPER, "menu_slot", {
      action: "set",
      groupId: mesaAbuelaId,
      onDate: EMPLOYEE_WEEK,
      meal: "cena",
      freeText: "Intento del apoyo",
    });
    expect(helperMenu).toMatchObject({ status: "rejected", errorCode: "not_allowed" });

    const employeeMenu = await run(EMPLOYEE, "menu_slot", {
      action: "set",
      groupId: mesaAbuelaId,
      onDate: EMPLOYEE_WEEK,
      meal: "cena",
      freeText: "Intento de la empleada",
    });
    expect(employeeMenu).toMatchObject({ status: "rejected", errorCode: "not_allowed" });

    const helperShopping = await run(HELPER, "shopping_item", {
      action: "add",
      customName: "Intento del apoyo",
      weekStartsOn: EMPLOYEE_WEEK,
    });
    expect(helperShopping).toMatchObject({ status: "rejected", errorCode: "not_allowed" });

    const itemId = await accept(EMPLOYEE, "shopping_item", {
      action: "add",
      customName: "Detergente IT",
      quantity: "2",
      unit: "ud",
      section: "hogar",
      weekStartsOn: EMPLOYEE_WEEK,
    });
    await accept(EMPLOYEE, "shopping_item", { action: "set_checked", itemId, checked: true });
    let checked = await adminPool.query(
      `select checked_at is not null as checked from app.shopping_items where id = $1`,
      [itemId],
    );
    expect(checked.rows).toEqual([{ checked: true }]);

    await accept(ADMIN, "shopping_item", { action: "set_checked", itemId, checked: false });
    checked = await adminPool.query(
      `select checked_at is not null as checked from app.shopping_items where id = $1`,
      [itemId],
    );
    expect(checked.rows).toEqual([{ checked: false }]);
  });
});
