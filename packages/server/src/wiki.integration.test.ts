import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { API_VERSION, type CommandEnvelopeV1, type UUID } from "@casa-clara/contracts";

import { wikiCommandHandlers, wikiSpaceCommandHandler } from "./commands/wiki.js";
import { withAuthorizedTransaction, type AuthenticatedPrincipal } from "./database.js";
import { processSyncBatch } from "./sync.js";
import { recordSearchOutcome, recordWikiRead, searchWiki } from "./wiki-search.js";

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const ROBLE_HOUSEHOLD = "10000000-0000-4000-8000-000000000001";
const ADMIN_MEMBERSHIP = "11000000-0000-4000-8000-000000000001";
const APP_LOGIN = "it_casa_clara_app_login";

const ADMIN: AuthenticatedPrincipal = { userId: "fixture:roble:admin" };
const EMPLOYEE: AuthenticatedPrincipal = { userId: "fixture:roble:employee" };
const HELPER: AuthenticatedPrincipal = { userId: "fixture:roble:helper" };
const VIEWER: AuthenticatedPrincipal = { userId: "fixture:roble:viewer" };

const HANDLERS = wikiCommandHandlers;

function pageEnvelope(
  operationId: string,
  payload: unknown,
  overrides: Partial<CommandEnvelopeV1> = {},
): CommandEnvelopeV1 {
  return {
    apiVersion: API_VERSION,
    operationId,
    householdId: ROBLE_HOUSEHOLD,
    schemaVersion: 1,
    aggregateType: "wiki_page",
    aggregateId: null,
    baseRevision: null,
    occurredAt: "2026-08-07T10:00:00.000Z",
    payload,
    ...overrides,
  };
}

describe.runIf(Boolean(adminUrl))("comandos y búsqueda de la wiki sobre Postgres real", () => {
  let adminPool: pg.Pool;
  let appPool: pg.Pool;

  beforeAll(() => {
    adminPool = new pg.Pool({ connectionString: adminUrl, max: 2 });
    const url = new URL(adminUrl as string);
    url.username = APP_LOGIN;
    url.password = "integration-only";
    appPool = new pg.Pool({ connectionString: url.toString(), max: 2 });
  });

  afterAll(async () => {
    await appPool?.end();
    await adminPool?.end();
  });

  async function createSpace(
    principal: AuthenticatedPrincipal,
    name: string,
    slug?: string,
  ): Promise<UUID> {
    return withAuthorizedTransaction(appPool, principal, ROBLE_HOUSEHOLD, async (client, membership) => {
      const ack = await wikiSpaceCommandHandler(client, membership, {
        apiVersion: API_VERSION,
        operationId: randomUUID(),
        householdId: ROBLE_HOUSEHOLD,
        schemaVersion: 1,
        aggregateType: "wiki_space",
        aggregateId: null,
        baseRevision: null,
        occurredAt: "2026-08-07T10:00:00.000Z",
        payload: slug === undefined ? { action: "create", name } : { action: "create", name, slug },
      });
      return ack.resourceId as UUID;
    });
  }

  async function createPage(
    principal: AuthenticatedPrincipal,
    spaceId: UUID,
    title: string,
    options: { bodyMarkdown?: string; aliases?: string[]; publish?: boolean } = {},
  ): Promise<UUID> {
    const operationId = randomUUID();
    const result = await processSyncBatch(
      appPool,
      principal,
      [
        pageEnvelope(operationId, {
          action: "create",
          spaceId,
          title,
          bodyMarkdown: options.bodyMarkdown ?? `Contenido de ${title}.`,
          aliases: options.aliases ?? [],
          publish: options.publish ?? true,
        }),
      ],
      HANDLERS,
    );
    expect(result.acknowledgements[0]).toMatchObject({ operationId, status: "accepted", revision: 1 });
    return result.acknowledgements[0]?.resourceId as UUID;
  }

  it("crea, edita con control de revisión, renombra conservando slugs y replica como duplicate", async () => {
    const spaceId = await createSpace(ADMIN, "Electrodomésticos");
    const space = await adminPool.query("select slug from app.wiki_spaces where id = $1", [spaceId]);
    expect(space.rows[0]).toEqual({ slug: "electrodomesticos" });

    const createOp = randomUUID();
    const createEnvelope = pageEnvelope(createOp, {
      action: "create",
      spaceId,
      title: "Lavadora · programa corto",
      bodyMarkdown: "Pulsa el botón de encendido y elige el programa corto de 30 minutos.",
      aliases: ["lavadora"],
      publish: true,
    });
    const created = await processSyncBatch(appPool, ADMIN, [createEnvelope], HANDLERS);
    expect(created.acknowledgements[0]).toMatchObject({ operationId: createOp, status: "accepted", revision: 1 });
    const pageId = created.acknowledgements[0]?.resourceId as UUID;

    const page = await adminPool.query(
      `select status, current_slug, current_revision_id from app.wiki_pages where id = $1`,
      [pageId],
    );
    expect(page.rows[0]).toMatchObject({ status: "published", current_slug: "lavadora-programa-corto" });
    expect(page.rows[0]?.current_revision_id).toBeTruthy();

    const firstRevision = await adminPool.query(
      `select revision_number, authored_by_membership_id from app.wiki_revisions
        where page_id = $1 order by revision_number`,
      [pageId],
    );
    expect(firstRevision.rows).toEqual([
      { revision_number: 1, authored_by_membership_id: ADMIN_MEMBERSHIP },
    ]);

    // Edición correcta sobre la revisión vigente → revisión 2.
    const editPayload = {
      action: "edit",
      pageId,
      title: "Lavadora · programa corto",
      bodyMarkdown: "Programa corto de 30 minutos; usa detergente líquido, media dosis.",
      aliases: ["lavadora"],
    };
    const edited = await processSyncBatch(
      appPool,
      ADMIN,
      [pageEnvelope(randomUUID(), editPayload, { aggregateId: pageId, baseRevision: 1 })],
      HANDLERS,
    );
    expect(edited.acknowledgements[0]).toMatchObject({ status: "accepted", revision: 2 });

    // Edición sobre una revisión superada → conflict con resolución humana.
    const stale = await processSyncBatch(
      appPool,
      ADMIN,
      [pageEnvelope(randomUUID(), editPayload, { aggregateId: pageId, baseRevision: 1 })],
      HANDLERS,
    );
    expect(stale.acknowledgements[0]).toMatchObject({
      status: "conflict",
      errorCode: "wiki_revision_conflict",
    });

    // Edición a ciegas (sin baseRevision) → también conflict.
    const blind = await processSyncBatch(
      appPool,
      ADMIN,
      [pageEnvelope(randomUUID(), editPayload, { aggregateId: pageId, baseRevision: null })],
      HANDLERS,
    );
    expect(blind.acknowledgements[0]).toMatchObject({
      status: "conflict",
      errorCode: "wiki_revision_conflict",
    });

    // Renombrar añade slug nuevo y el viejo sigue resolviendo (AC-15).
    const renamed = await processSyncBatch(
      appPool,
      ADMIN,
      [
        pageEnvelope(
          randomUUID(),
          { ...editPayload, title: "Lavadora · guía completa" },
          { aggregateId: pageId, baseRevision: 2 },
        ),
      ],
      HANDLERS,
    );
    expect(renamed.acknowledgements[0]).toMatchObject({ status: "accepted", revision: 3 });

    const afterRename = await adminPool.query(
      `select current_slug from app.wiki_pages where id = $1`,
      [pageId],
    );
    expect(afterRename.rows[0]).toEqual({ current_slug: "lavadora-guia-completa" });

    const slugs = await adminPool.query(
      `select slug from app.wiki_page_slugs where household_id = $1 and page_id = $2 order by slug`,
      [ROBLE_HOUSEHOLD, pageId],
    );
    expect(slugs.rows.map((row) => row.slug)).toEqual([
      "lavadora-guia-completa",
      "lavadora-programa-corto",
    ]);

    // Replay del create original → duplicate, sin páginas nuevas.
    const replay = await processSyncBatch(appPool, ADMIN, [createEnvelope], HANDLERS);
    expect(replay.acknowledgements[0]).toMatchObject({
      operationId: createOp,
      status: "duplicate",
      resourceId: pageId,
    });
  });

  it("espacios: slug derivado desambigua con sufijos y el explícito duplicado se rechaza", async () => {
    const first = await createSpace(ADMIN, "Cocina");
    const second = await createSpace(ADMIN, "Cocina");
    const slugs = await adminPool.query(
      `select id, slug from app.wiki_spaces where id in ($1, $2) order by slug`,
      [first, second],
    );
    expect(slugs.rows.map((row) => row.slug)).toEqual(["cocina", "cocina-2"]);

    await expect(createSpace(ADMIN, "Otra cocina", "cocina")).rejects.toMatchObject({
      errorCode: "slug_taken",
    });

    // Los espacios son de la familia: ni la empleada ni el apoyo los crean.
    await expect(createSpace(EMPLOYEE, "Espacio de empleada")).rejects.toMatchObject({
      errorCode: "not_allowed",
    });
    await expect(createSpace(HELPER, "Espacio de apoyo")).rejects.toMatchObject({
      errorCode: "not_allowed",
    });
  });

  it("helper y viewer no escriben; helper lee lo publicado pero no un borrador", async () => {
    const spaceId = await createSpace(ADMIN, "Visibilidad");

    for (const principal of [HELPER, VIEWER]) {
      const denied = await processSyncBatch(
        appPool,
        principal,
        [
          pageEnvelope(randomUUID(), {
            action: "create",
            spaceId,
            title: "Intento sin permiso",
            bodyMarkdown: "No debería existir.",
          }),
        ],
        HANDLERS,
      );
      expect(denied.acknowledgements[0]).toMatchObject({ status: "rejected", errorCode: "not_allowed" });
    }

    const publishedId = await createPage(ADMIN, spaceId, "Guía visible para el apoyo", { publish: true });
    const draftId = await createPage(ADMIN, spaceId, "Borrador oculto al apoyo", { publish: false });

    const helperView = await withAuthorizedTransaction(appPool, HELPER, ROBLE_HOUSEHOLD, async (client) => {
      const pages = await client.query<{ id: string }>(
        `select id from app.wiki_pages where id = any($1::uuid[]) order by created_at`,
        [[publishedId, draftId]],
      );
      const revisions = await client.query<{ page_id: string }>(
        `select distinct page_id from app.wiki_revisions where page_id = any($1::uuid[])`,
        [[publishedId, draftId]],
      );
      return {
        pages: pages.rows.map((row) => row.id),
        revisionPages: revisions.rows.map((row) => row.page_id),
      };
    });
    expect(helperView.pages).toEqual([publishedId]);
    expect(helperView.revisionPages).toEqual([publishedId]);

    // La familia sí ve el borrador bajo el mismo contexto RLS.
    const adminView = await withAuthorizedTransaction(appPool, ADMIN, ROBLE_HOUSEHOLD, async (client) => {
      const pages = await client.query<{ id: string }>(
        `select id from app.wiki_pages where id = any($1::uuid[])`,
        [[publishedId, draftId]],
      );
      return pages.rows.map((row) => row.id).sort();
    });
    expect(adminView).toEqual([publishedId, draftId].sort());
  });

  it("set_state publica, despublica y fija en portada", async () => {
    const spaceId = await createSpace(ADMIN, "Estados");
    const pageId = await createPage(EMPLOYEE, spaceId, "Página de estados", { publish: false });

    const published = await processSyncBatch(
      appPool,
      ADMIN,
      [
        pageEnvelope(
          randomUUID(),
          { action: "set_state", pageId, status: "published", pinned: true },
          { aggregateId: pageId },
        ),
      ],
      HANDLERS,
    );
    expect(published.acknowledgements[0]).toMatchObject({ status: "accepted", resourceId: pageId });

    let row = await adminPool.query(`select status, pinned from app.wiki_pages where id = $1`, [pageId]);
    expect(row.rows[0]).toEqual({ status: "published", pinned: true });

    const unpinned = await processSyncBatch(
      appPool,
      ADMIN,
      [pageEnvelope(randomUUID(), { action: "set_state", pageId, pinned: false }, { aggregateId: pageId })],
      HANDLERS,
    );
    expect(unpinned.acknowledgements[0]).toMatchObject({ status: "accepted" });

    row = await adminPool.query(`select status, pinned from app.wiki_pages where id = $1`, [pageId]);
    expect(row.rows[0]).toEqual({ status: "published", pinned: false });
  });

  it("búsqueda: la errata 'lavadra' encuentra la lavadora y el alias 'vitro' trae la placa primero", async () => {
    const spaceId = await createSpace(ADMIN, "Guías de la casa");

    await createPage(EMPLOYEE, spaceId, "Lavadora · programa corto", {
      bodyMarkdown: "Programa corto de 30 minutos para ropa de diario. Detergente líquido, media dosis.",
      aliases: ["lavadora"],
    });
    const placaId = await createPage(EMPLOYEE, spaceId, "Placa de inducción", {
      bodyMarkdown: "Desbloquea la placa manteniendo pulsado el candado tres segundos.",
      aliases: ["vitro", "vitrocerámica"],
    });
    await createPage(EMPLOYEE, spaceId, "Se ha ido la luz", {
      bodyMarkdown: "Revisa el cuadro eléctrico de la entrada y sube el diferencial.",
    });
    await createPage(EMPLOYEE, spaceId, "Rutina de sueño", {
      bodyMarkdown: "Baño a las 19:30, cuento y luz apagada a las 20:15.",
    });

    // AC-16: errata sin coincidencia FTS resuelta por trigram sobre título/alias.
    const typo = await withAuthorizedTransaction(appPool, HELPER, ROBLE_HOUSEHOLD, (client) =>
      searchWiki(client, "lavadra"),
    );
    expect(typo.length).toBeGreaterThan(0);
    expect(
      typo.slice(0, 3).some((result) => result.title === "Lavadora · programa corto"),
    ).toBe(true);

    // AC-17: el alias 'vitro' coloca la placa en primera posición.
    const alias = await withAuthorizedTransaction(appPool, HELPER, ROBLE_HOUSEHOLD, (client) =>
      searchWiki(client, "vitro"),
    );
    expect(alias[0]).toMatchObject({
      id: placaId,
      title: "Placa de inducción",
      spaceSlug: "guias-de-la-casa",
      slug: "placa-de-induccion",
    });
    expect(alias[0]?.score).toBeGreaterThan(0);
    expect(typeof alias[0]?.excerpt).toBe("string");
  });

  it("registra huecos de búsqueda agregados por día y lecturas sin identidad", async () => {
    const missQuery = "Candelabros Dorados";

    await withAuthorizedTransaction(appPool, EMPLOYEE, ROBLE_HOUSEHOLD, async (client) => {
      const results = await searchWiki(client, missQuery);
      expect(results).toEqual([]);
      await recordSearchOutcome(client, missQuery, false);
    });

    const gap = await adminPool.query(
      `select miss_count, no_click_count from app.search_gap_events
        where household_id = $1 and query_normalized = $2 and occurred_on = current_date`,
      [ROBLE_HOUSEHOLD, "candelabros dorados"],
    );
    expect(gap.rows[0]).toEqual({ miss_count: 1, no_click_count: 0 });

    const spaceId = await createSpace(ADMIN, "Lecturas");
    const pageId = await createPage(ADMIN, spaceId, "Página muy leída", { publish: true });

    await withAuthorizedTransaction(appPool, HELPER, ROBLE_HOUSEHOLD, (client) =>
      recordWikiRead(client, pageId),
    );
    await withAuthorizedTransaction(appPool, EMPLOYEE, ROBLE_HOUSEHOLD, (client) =>
      recordWikiRead(client, pageId),
    );

    const reads = await adminPool.query(
      `select read_count from app.wiki_page_reads
        where household_id = $1 and page_id = $2 and read_on = current_date`,
      [ROBLE_HOUSEHOLD, pageId],
    );
    expect(reads.rows[0]).toEqual({ read_count: 2 });
  });
});
