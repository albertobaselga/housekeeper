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
import { processSyncBatch } from "./sync.js";
import type { AuthenticatedPrincipal } from "./database.js";

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const ROBLE_HOUSEHOLD = "10000000-0000-4000-8000-000000000001";
const APP_LOGIN = "it_casa_clara_app_login";

const ADMIN: AuthenticatedPrincipal = { userId: "fixture:roble:admin" };
const EMPLOYEE: AuthenticatedPrincipal = { userId: "fixture:roble:employee" };

const HANDLERS = { ...wikiCommandHandlers, ...foodCommandHandlers };

// Semanas propias de esta suite, sin solaparse con las de otras.
const SOURCE_WEEK = "2026-10-05";
const APPLY_WEEK = "2026-10-12";
const APPLY_WEEK_2 = "2026-10-19";
const DEGRADED_WEEK = "2026-10-26";
const EMPTY_WEEK = "2026-12-07";

function envelope(
  aggregateType: AggregateType,
  payload: unknown,
  operationId = randomUUID(),
): CommandEnvelopeV1 {
  return {
    apiVersion: API_VERSION,
    operationId,
    householdId: ROBLE_HOUSEHOLD,
    schemaVersion: 1,
    aggregateType,
    aggregateId: null,
    baseRevision: null,
    occurredAt: "2026-08-08T10:00:00.000Z",
    payload,
  };
}

describe.runIf(Boolean(adminUrl))("plantillas de semana de menú sobre Postgres real", () => {
  let adminPool: pg.Pool;
  let appPool: pg.Pool;

  async function run(
    principal: AuthenticatedPrincipal,
    aggregateType: AggregateType,
    payload: unknown,
    operationId?: string,
  ): Promise<CommandAckV1> {
    const result = await processSyncBatch(
      appPool,
      principal,
      [envelope(aggregateType, payload, operationId)],
      HANDLERS,
    );
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

  let groupId: UUID;
  let recipePageId: UUID;

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: adminUrl, max: 2 });
    const url = new URL(adminUrl as string);
    url.username = APP_LOGIN;
    url.password = "integration-only";
    appPool = new pg.Pool({ connectionString: url.toString(), max: 2 });

    const foodId = await accept(ADMIN, "food", {
      action: "upsert",
      name: "Garbanzos plantilla IT",
      shoppingSection: "despensa",
      allergenCodes: [],
      reviewed: true,
    });
    const dinerId = await accept(ADMIN, "diner", { action: "upsert", name: "Comensal plantilla IT", flags: [] });
    groupId = await accept(ADMIN, "menu_group", {
      action: "upsert",
      name: "Mesa plantilla IT",
      dinerIds: [dinerId],
    });

    const spaceId = await accept(ADMIN, "wiki_space", { action: "create", name: "Plantillas IT" });
    recipePageId = await accept(ADMIN, "wiki_page", {
      action: "create",
      spaceId,
      title: "Cocido de plantilla IT",
      bodyMarkdown: "Receta del cocido.",
      publish: true,
    });
    await accept(ADMIN, "recipe", {
      action: "set_details",
      pageId: recipePageId,
      baseServings: 4,
      ingredients: [{ foodId, quantity: "400", unit: "g", scaling: "linear" }],
    });

    // Semana origen: un hueco con receta (lunes) y otro de texto libre (miércoles).
    await accept(ADMIN, "menu_slot", {
      action: "set",
      groupId,
      onDate: SOURCE_WEEK,
      meal: "comida",
      recipePageId,
      servingsOverride: 6,
      notes: "Con su pringá",
    });
    await accept(ADMIN, "menu_slot", {
      action: "set",
      groupId,
      onDate: "2026-10-07",
      meal: "cena",
      freeText: "Revuelto de plantilla IT",
    });
  });

  afterAll(async () => {
    await appPool?.end();
    await adminPool?.end();
  });

  let templateId: UUID;

  it("save captura la semana con día relativo, receta, texto, notas y raciones", async () => {
    templateId = await accept(ADMIN, "menu_template", {
      action: "save",
      name: "Semana de cole IT",
      fromWeekStartsOn: SOURCE_WEEK,
    });

    const rows = await adminPool.query(
      `select day_offset, meal::text as meal, recipe_page_id, recipe_title, free_text,
              notes, servings_override
         from app.menu_week_template_slots
        where template_id = $1
        order by day_offset`,
      [templateId],
    );
    expect(rows.rows).toEqual([
      {
        day_offset: 0,
        meal: "comida",
        recipe_page_id: recipePageId,
        recipe_title: "Cocido de plantilla IT",
        free_text: "",
        notes: "Con su pringá",
        servings_override: 6,
      },
      {
        day_offset: 2,
        meal: "cena",
        recipe_page_id: null,
        recipe_title: "",
        free_text: "Revuelto de plantilla IT",
        notes: "",
        servings_override: null,
      },
    ]);
  });

  it("save rechaza el nombre repetido (aun con otras mayúsculas) y la semana vacía", async () => {
    const taken = await run(ADMIN, "menu_template", {
      action: "save",
      name: "SEMANA DE COLE it",
      fromWeekStartsOn: SOURCE_WEEK,
    });
    expect(taken).toMatchObject({ status: "rejected", errorCode: "template_name_taken" });

    const empty = await run(ADMIN, "menu_template", {
      action: "save",
      name: "Semana vacía IT",
      fromWeekStartsOn: EMPTY_WEEK,
    });
    expect(empty).toMatchObject({ status: "rejected", errorCode: "menu_week_empty" });
  });

  it("apply sobre una semana vacía copia los huecos al día relativo correcto", async () => {
    const ack = await run(ADMIN, "menu_template", {
      action: "apply",
      templateId,
      toWeekStartsOn: APPLY_WEEK,
    });
    expect(ack).toMatchObject({ status: "accepted" });

    const rows = await adminPool.query(
      `select on_date::text as on_date, meal::text as meal, recipe_page_id, free_text,
              notes, servings_override
         from app.menu_slots
        where household_id = $1 and on_date >= $2::date and on_date <= $2::date + 6
        order by on_date`,
      [ROBLE_HOUSEHOLD, APPLY_WEEK],
    );
    expect(rows.rows).toEqual([
      {
        on_date: "2026-10-12",
        meal: "comida",
        recipe_page_id: recipePageId,
        free_text: "",
        notes: "Con su pringá",
        servings_override: 6,
      },
      {
        on_date: "2026-10-14",
        meal: "cena",
        recipe_page_id: null,
        free_text: "Revuelto de plantilla IT",
        notes: "",
        servings_override: null,
      },
    ]);
  });

  it("apply rechaza week_overlap si la semana destino ya tiene contenido", async () => {
    // La semana recién aplicada ya no está vacía; también protege la origen.
    const occupied = await run(ADMIN, "menu_template", {
      action: "apply",
      templateId,
      toWeekStartsOn: APPLY_WEEK,
    });
    expect(occupied).toMatchObject({ status: "rejected", errorCode: "week_overlap" });

    const source = await run(ADMIN, "menu_template", {
      action: "apply",
      templateId,
      toWeekStartsOn: SOURCE_WEEK,
    });
    expect(source).toMatchObject({ status: "rejected", errorCode: "week_overlap" });
  });

  it("el recibo idempotente responde duplicate al reintentar la misma operación", async () => {
    const operationId = randomUUID();
    const payload = { action: "apply", templateId, toWeekStartsOn: APPLY_WEEK_2 };

    const first = await run(ADMIN, "menu_template", payload, operationId);
    expect(first).toMatchObject({ status: "accepted", resourceId: templateId });

    const retry = await run(ADMIN, "menu_template", payload, operationId);
    expect(retry).toMatchObject({ status: "duplicate", resourceId: templateId });

    const count = await adminPool.query(
      `select count(*)::int as n from app.menu_slots
        where household_id = $1 and on_date >= $2::date and on_date <= $2::date + 6`,
      [ROBLE_HOUSEHOLD, APPLY_WEEK_2],
    );
    expect(count.rows[0]).toEqual({ n: 2 });
  });

  it("apply degrada con gracia: receta con página archivada pasa a texto con su título", async () => {
    // La página wiki de la receta se archiva después de guardar la plantilla.
    await adminPool.query(
      `update app.wiki_pages set archived_at = statement_timestamp() where id = $1`,
      [recipePageId],
    );
    try {
      const ack = await run(ADMIN, "menu_template", {
        action: "apply",
        templateId,
        toWeekStartsOn: DEGRADED_WEEK,
      });
      expect(ack).toMatchObject({ status: "accepted" });

      const rows = await adminPool.query(
        `select on_date::text as on_date, recipe_page_id, free_text
           from app.menu_slots
          where household_id = $1 and on_date >= $2::date and on_date <= $2::date + 6
          order by on_date`,
        [ROBLE_HOUSEHOLD, DEGRADED_WEEK],
      );
      expect(rows.rows).toEqual([
        { on_date: "2026-10-26", recipe_page_id: null, free_text: "Cocido de plantilla IT" },
        { on_date: "2026-10-28", recipe_page_id: null, free_text: "Revuelto de plantilla IT" },
      ]);
    } finally {
      await adminPool.query(`update app.wiki_pages set archived_at = null where id = $1`, [recipePageId]);
    }
  });

  it("solo la familia gestiona plantillas", async () => {
    const employee = await run(EMPLOYEE, "menu_template", {
      action: "save",
      name: "Plantilla de la empleada IT",
      fromWeekStartsOn: SOURCE_WEEK,
    });
    expect(employee).toMatchObject({ status: "rejected", errorCode: "not_allowed" });
  });

  it("delete borra la plantilla y sus huecos; repetirlo responde template_not_found", async () => {
    const ack = await run(ADMIN, "menu_template", { action: "delete", templateId });
    expect(ack).toMatchObject({ status: "accepted", resourceId: templateId });

    const rows = await adminPool.query(
      `select count(*)::int as n from app.menu_week_template_slots where template_id = $1`,
      [templateId],
    );
    expect(rows.rows[0]).toEqual({ n: 0 });

    const again = await run(ADMIN, "menu_template", { action: "delete", templateId });
    expect(again).toMatchObject({ status: "rejected", errorCode: "template_not_found" });

    const apply = await run(ADMIN, "menu_template", {
      action: "apply",
      templateId,
      toWeekStartsOn: EMPTY_WEEK,
    });
    expect(apply).toMatchObject({ status: "rejected", errorCode: "template_not_found" });
  });
});
