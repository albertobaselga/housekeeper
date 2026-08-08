import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  API_VERSION,
  type AggregateType,
  type CommandAckV1,
  type CommandEnvelopeV1,
  type UUID,
} from "@casa-clara/contracts";

import { foodCommandHandlers } from "./commands/food-handlers.js";
import { wikiCommandHandlers } from "./commands/wiki.js";
import { withAuthorizedTransaction, type AuthenticatedPrincipal } from "./database.js";
import { buildShoppingBoard } from "./commands/shopping.js";
import { processSyncBatch } from "./sync.js";

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const ROBLE_HOUSEHOLD = "10000000-0000-4000-8000-000000000001";
const APP_LOGIN = "it_casa_clara_app_login";

const ADMIN: AuthenticatedPrincipal = { userId: "fixture:roble:admin" };
const EMPLOYEE: AuthenticatedPrincipal = { userId: "fixture:roble:employee" };

const HANDLERS = { ...wikiCommandHandlers, ...foodCommandHandlers };

// Semanas propias de esta suite, sin solaparse con las de las demás.
const SOURCE_WEEK = "2027-01-04";
const APPLY_WEEK = "2027-01-11";
const SHOPPING_WEEK = "2027-01-18";

function envelope(aggregateType: AggregateType, payload: unknown): CommandEnvelopeV1 {
  return {
    apiVersion: API_VERSION,
    operationId: randomUUID(),
    householdId: ROBLE_HOUSEHOLD,
    schemaVersion: 1,
    aggregateType,
    aggregateId: null,
    baseRevision: null,
    occurredAt: "2026-08-08T10:00:00.000Z",
    payload,
  };
}

/**
 * Archivado de alimentos, recetas y grupos de comensales: baja lógica
 * reversible que no borra nada. Lo importante del brief: archivar algo que una
 * plantilla de menú ya usaba NO rompe aplicarla — la plantilla degrada, que es
 * lo que ya hacía ante desapariciones.
 */
describe.runIf(Boolean(adminUrl))("archivado de catálogo, recetas y grupos", () => {
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

  let foodId: UUID;
  let groupId: UUID;
  let recipePageId: UUID;
  let templateId: UUID;

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: adminUrl, max: 2 });
    const url = new URL(adminUrl as string);
    url.username = APP_LOGIN;
    url.password = "integration-only";
    appPool = new pg.Pool({ connectionString: url.toString(), max: 2 });

    foodId = await accept(ADMIN, "food", {
      action: "upsert",
      name: "Lenteja de archivo IT",
      shoppingSection: "despensa",
      allergenCodes: [],
      reviewed: true,
    });
    const dinerId = await accept(ADMIN, "diner", {
      action: "upsert",
      name: "Comensal de archivo IT",
      flags: [],
    });
    groupId = await accept(ADMIN, "menu_group", {
      action: "upsert",
      name: "Mesa de archivo IT",
      dinerIds: [dinerId],
    });

    const spaceId = await accept(ADMIN, "wiki_space", { action: "create", name: "Archivo IT" });
    recipePageId = await accept(ADMIN, "wiki_page", {
      action: "create",
      spaceId,
      title: "Lentejas de archivo IT",
      bodyMarkdown: "Receta de las lentejas.",
      publish: true,
    });
    await accept(ADMIN, "recipe", {
      action: "set_details",
      pageId: recipePageId,
      baseServings: 4,
      ingredients: [{ foodId, quantity: "400", unit: "g", scaling: "linear" }],
    });

    await accept(ADMIN, "menu_slot", {
      action: "set",
      groupId,
      onDate: SOURCE_WEEK,
      meal: "comida",
      recipePageId,
      servingsOverride: 4,
    });
    templateId = await accept(ADMIN, "menu_template", {
      action: "save",
      name: "Semana de archivo IT",
      fromWeekStartsOn: SOURCE_WEEK,
    });
  });

  afterAll(async () => {
    await appPool?.end();
    await adminPool?.end();
  });

  it("solo la familia archiva; el apoyo y la empleada no", async () => {
    const employeeFood = await run(EMPLOYEE, "food", { action: "archive", foodId });
    expect(employeeFood).toMatchObject({ status: "rejected", errorCode: "not_allowed" });

    const employeeGroup = await run(EMPLOYEE, "menu_group", { action: "archive", groupId });
    expect(employeeGroup).toMatchObject({ status: "rejected", errorCode: "not_allowed" });

    const employeeRecipe = await run(EMPLOYEE, "recipe", { action: "archive", pageId: recipePageId });
    expect(employeeRecipe).toMatchObject({ status: "rejected", errorCode: "not_allowed" });
  });

  it("archivar y recuperar un alimento es reversible e idempotente en su rechazo", async () => {
    await accept(ADMIN, "food", { action: "archive", foodId });
    let row = await adminPool.query(`select archived_at from app.foods where id = $1`, [foodId]);
    expect(row.rows[0]?.archived_at).not.toBeNull();

    // Archivar dos veces no es un no-op silencioso: se dice que ya lo estaba.
    const again = await run(ADMIN, "food", { action: "archive", foodId });
    expect(again).toMatchObject({ status: "rejected", errorCode: "food_not_found" });

    // Un alimento vigente con el mismo nombre bloquea la recuperación con un
    // mensaje, en vez de reventar el índice único por hogar.
    const clashId = await accept(ADMIN, "food", {
      action: "upsert",
      name: "lenteja DE archivo it",
      shoppingSection: "despensa",
      allergenCodes: [],
      reviewed: true,
    });
    const blocked = await run(ADMIN, "food", { action: "restore", foodId });
    expect(blocked).toMatchObject({ status: "rejected", errorCode: "food_name_taken" });
    await accept(ADMIN, "food", { action: "archive", foodId: clashId });

    await accept(ADMIN, "food", { action: "restore", foodId });
    row = await adminPool.query(`select archived_at from app.foods where id = $1`, [foodId]);
    expect(row.rows[0]?.archived_at).toBeNull();
  });

  it("la compra sigue pidiendo un alimento archivado que una receta todavía usa", async () => {
    await accept(ADMIN, "menu_slot", {
      action: "set",
      groupId,
      onDate: SHOPPING_WEEK,
      meal: "comida",
      recipePageId,
      servingsOverride: 4,
    });
    await accept(ADMIN, "food", { action: "archive", foodId });
    try {
      const board = await withAuthorizedTransaction(appPool, ADMIN, ROBLE_HOUSEHOLD, (client) =>
        buildShoppingBoard(client, ROBLE_HOUSEHOLD, SHOPPING_WEEK),
      );
      const lines = board.sections.flatMap((section) => section.lines);
      // Si desapareciera de la lista se cocinaría sin haberlo comprado.
      expect(lines.find((line) => line.name === "Lenteja de archivo IT")?.parts[0]).toMatchObject({
        unit: "g",
        quantity: "400",
      });
    } finally {
      await accept(ADMIN, "food", { action: "restore", foodId });
    }
  });

  it("archivar la receta y el grupo NO rompe aplicar la plantilla que los usaba", async () => {
    await accept(ADMIN, "recipe", { action: "archive", pageId: recipePageId });

    // La ficha se retira del recetario pero la nota de la Guía sigue publicada.
    const page = await adminPool.query(`select archived_at from app.wiki_pages where id = $1`, [
      recipePageId,
    ]);
    expect(page.rows[0]?.archived_at).toBeNull();

    const degraded = await run(ADMIN, "menu_template", {
      action: "apply",
      templateId,
      toWeekStartsOn: APPLY_WEEK,
    });
    expect(degraded).toMatchObject({ status: "accepted" });

    // El hueco entra como texto libre con el título capturado al guardar.
    const applied = await adminPool.query(
      `select recipe_page_id, free_text from app.menu_slots
        where household_id = $1 and on_date = $2::date`,
      [ROBLE_HOUSEHOLD, APPLY_WEEK],
    );
    expect(applied.rows).toEqual([
      { recipe_page_id: null, free_text: "Lentejas de archivo IT" },
    ]);

    // Y con el grupo archivado, la plantilla salta sus huecos sin romperse.
    await accept(ADMIN, "menu_group", { action: "archive", groupId });
    const emptied = await run(ADMIN, "menu_template", {
      action: "apply",
      templateId,
      toWeekStartsOn: "2027-02-01",
    });
    expect(emptied).toMatchObject({ status: "accepted" });
    const none = await adminPool.query(
      `select count(*)::int as n from app.menu_slots
        where household_id = $1 and on_date >= $2::date and on_date <= $2::date + 6`,
      [ROBLE_HOUSEHOLD, "2027-02-01"],
    );
    expect(none.rows[0]).toEqual({ n: 0 });

    // Las comidas ya planificadas del grupo archivado siguen guardadas.
    const kept = await adminPool.query(
      `select count(*)::int as n from app.menu_slots
        where household_id = $1 and group_id = $2 and on_date = $3::date`,
      [ROBLE_HOUSEHOLD, groupId, SOURCE_WEEK],
    );
    expect(kept.rows[0]).toEqual({ n: 1 });

    await accept(ADMIN, "menu_group", { action: "restore", groupId });
    await accept(ADMIN, "recipe", { action: "restore", pageId: recipePageId });
  });
});
