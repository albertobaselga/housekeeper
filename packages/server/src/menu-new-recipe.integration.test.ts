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
import { wikiCommandHandlers } from "./commands/wiki.js";
import { withAuthorizedTransaction, type AuthenticatedPrincipal } from "./database.js";
import { computeMenuSlotHash } from "./menu-hash.js";
import { processSyncBatch } from "./sync.js";

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const ROBLE_HOUSEHOLD = "10000000-0000-4000-8000-000000000001";
const APP_LOGIN = "it_housekeeper_app_login";

const ADMIN: AuthenticatedPrincipal = { userId: "fixture:roble:admin" };
const EMPLOYEE: AuthenticatedPrincipal = { userId: "fixture:roble:employee" };

const HANDLERS = { ...wikiCommandHandlers, ...foodCommandHandlers };

// Semana propia de esta suite, sin solaparse con las de otras.
const WEEK = "2026-11-02";

function envelope(
  aggregateType: AggregateType,
  payload: unknown,
  operationId: string = randomUUID(),
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

describe.runIf(Boolean(adminUrl))("nueva receta desde el hueco del menú sobre Postgres real", () => {
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

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: adminUrl, max: 2 });
    const url = new URL(adminUrl as string);
    url.username = APP_LOGIN;
    url.password = "integration-only";
    appPool = new pg.Pool({ connectionString: url.toString(), max: 2 });

    const dinerA = await accept(ADMIN, "diner", { action: "upsert", name: "Comensal receta nueva 1 IT", flags: [] });
    const dinerB = await accept(ADMIN, "diner", { action: "upsert", name: "Comensal receta nueva 2 IT", flags: [] });
    const dinerC = await accept(ADMIN, "diner", { action: "upsert", name: "Comensal receta nueva 3 IT", flags: [] });
    groupId = await accept(ADMIN, "menu_group", {
      action: "upsert",
      name: "Mesa receta nueva IT",
      dinerIds: [dinerA, dinerB, dinerC],
    });
  });

  afterAll(async () => {
    await appPool?.end();
    await adminPool?.end();
  });

  let slotId: UUID;
  let pageId: UUID;

  it("set_new_recipe crea página wiki + receta y asigna el hueco en un solo comando", async () => {
    slotId = await accept(ADMIN, "menu_slot", {
      action: "set_new_recipe",
      groupId,
      onDate: WEEK,
      meal: "cena",
      recipeTitle: "Tortilla de la casa IT",
      recipeBody: "Patata, huevo y cebolla al gusto.",
      notes: "Poco cuajada",
    });

    const slot = await adminPool.query<{ recipe_page_id: string; notes: string }>(
      `select recipe_page_id, notes from app.menu_slots where household_id = $1 and id = $2`,
      [ROBLE_HOUSEHOLD, slotId],
    );
    expect(slot.rows).toHaveLength(1);
    pageId = slot.rows[0]!.recipe_page_id;
    expect(pageId).toMatch(/^[0-9a-f-]{36}$/);
    expect(slot.rows[0]!.notes).toBe("Poco cuajada");

    // La receta es real y 1:1 con su página wiki publicada; las raciones base
    // caen al nº de comensales del grupo (3) al no venir en el payload.
    const recipe = await adminPool.query(
      `select recipe.base_servings, page.status::text as status, revision.title, revision.body_markdown
         from app.recipes as recipe
         join app.wiki_pages as page
           on page.household_id = recipe.household_id and page.id = recipe.page_id
         join app.wiki_revisions as revision
           on revision.household_id = page.household_id and revision.id = page.current_revision_id
        where recipe.household_id = $1 and recipe.page_id = $2`,
      [ROBLE_HOUSEHOLD, pageId],
    );
    expect(recipe.rows).toEqual([
      {
        base_servings: 3,
        status: "published",
        title: "Tortilla de la casa IT",
        body_markdown: "Patata, huevo y cebolla al gusto.",
      },
    ]);

    // El slug quedó registrado como el de cualquier página creada por comando.
    const slugs = await adminPool.query(
      `select slug from app.wiki_page_slugs where household_id = $1 and page_id = $2`,
      [ROBLE_HOUSEHOLD, pageId],
    );
    expect(slugs.rows).toEqual([{ slug: "tortilla-de-la-casa-it" }]);
  });

  it("el hash del hueco es el canónico del servidor y la confirmación entra con él", async () => {
    const hash = await withAuthorizedTransaction(appPool, ADMIN, ROBLE_HOUSEHOLD, (client) =>
      computeMenuSlotHash(client, ROBLE_HOUSEHOLD, slotId),
    );
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    await accept(ADMIN, "menu_slot", { action: "confirm", slotId, contentHash: hash });

    const confirmed = await adminPool.query(
      `select content_hash from app.menu_confirmations where slot_id = $1`,
      [slotId],
    );
    expect(confirmed.rows).toEqual([{ content_hash: hash }]);
  });

  it("una segunda receta con el mismo nombre convive con slug desambiguado", async () => {
    const otherSlotId = await accept(ADMIN, "menu_slot", {
      action: "set_new_recipe",
      groupId,
      onDate: "2026-11-03",
      meal: "cena",
      recipeTitle: "Tortilla de la casa IT",
      baseServings: 2,
    });
    expect(otherSlotId).not.toBe(slotId);

    const other = await adminPool.query<{ recipe_page_id: string }>(
      `select recipe_page_id from app.menu_slots where id = $1`,
      [otherSlotId],
    );
    const otherPageId = other.rows[0]!.recipe_page_id;
    expect(otherPageId).not.toBe(pageId);

    const slug = await adminPool.query(
      `select current_slug, space_id from app.wiki_pages where id = $1`,
      [otherPageId],
    );
    expect(slug.rows[0]!.current_slug).toBe("tortilla-de-la-casa-it-2");

    // Ambas páginas comparten espacio: la segunda cae donde ya viven recetas.
    const first = await adminPool.query(`select space_id from app.wiki_pages where id = $1`, [pageId]);
    expect(slug.rows[0]!.space_id).toBe(first.rows[0]!.space_id);

    const servings = await adminPool.query(
      `select base_servings from app.recipes where page_id = $1`,
      [otherPageId],
    );
    expect(servings.rows).toEqual([{ base_servings: 2 }]);
  });

  it("el recibo idempotente no duplica ni receta ni hueco al reintentar", async () => {
    const operationId = randomUUID();
    const payload = {
      action: "set_new_recipe",
      groupId,
      onDate: "2026-11-04",
      meal: "comida",
      recipeTitle: "Guiso idempotente IT",
    };
    const first = await run(ADMIN, "menu_slot", payload, operationId);
    expect(first).toMatchObject({ status: "accepted" });

    const retry = await run(ADMIN, "menu_slot", payload, operationId);
    expect(retry).toMatchObject({ status: "duplicate", resourceId: first.resourceId });

    const pages = await adminPool.query(
      `select count(*)::int as n from app.wiki_page_slugs
        where household_id = $1 and slug like 'guiso-idempotente-it%'`,
      [ROBLE_HOUSEHOLD],
    );
    expect(pages.rows[0]).toEqual({ n: 1 });
  });

  it("la empleada no puede crear recetas desde el menú (familia only)", async () => {
    const ack = await run(EMPLOYEE, "menu_slot", {
      action: "set_new_recipe",
      groupId,
      onDate: "2026-11-05",
      meal: "cena",
      recipeTitle: "Intento de la empleada IT",
    });
    expect(ack).toMatchObject({ status: "rejected", errorCode: "not_allowed" });

    const grupoFalso = await run(ADMIN, "menu_slot", {
      action: "set_new_recipe",
      groupId: randomUUID(),
      onDate: "2026-11-05",
      meal: "cena",
      recipeTitle: "Receta sin grupo IT",
    });
    expect(grupoFalso).toMatchObject({ status: "rejected", errorCode: "group_not_found" });

    // El rechazo revirtió la transacción entera: no quedó página huérfana.
    const leftovers = await adminPool.query(
      `select count(*)::int as n from app.wiki_page_slugs
        where household_id = $1 and slug like 'receta-sin-grupo-it%'`,
      [ROBLE_HOUSEHOLD],
    );
    expect(leftovers.rows[0]).toEqual({ n: 0 });
  });
});
