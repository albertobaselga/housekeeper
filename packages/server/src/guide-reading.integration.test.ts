import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { API_VERSION, type CommandEnvelopeV1, type UUID } from "@housekeeper/contracts";

import { createWikiSpace, wikiCommandHandlers } from "./commands/wiki.js";
import { withAuthorizedTransaction, type AuthenticatedPrincipal } from "./database.js";
import { processSyncBatch } from "./sync.js";

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const ROBLE = "10000000-0000-4000-8000-000000000001";
const APP_LOGIN = "it_housekeeper_app_login";

const ADMIN: AuthenticatedPrincipal = { userId: "fixture:roble:admin" };
const FAMILY: AuthenticatedPrincipal = { userId: "fixture:roble:family" };
const EMPLOYEE: AuthenticatedPrincipal = { userId: "fixture:roble:employee" };
const EMPLOYEE_MEMBERSHIP = "11000000-0000-4000-8000-000000000003";

function envelope(payload: unknown, overrides: Partial<CommandEnvelopeV1> = {}): CommandEnvelopeV1 {
  return {
    apiVersion: API_VERSION,
    operationId: randomUUID(),
    householdId: ROBLE,
    schemaVersion: 1,
    aggregateType: "wiki_page",
    aggregateId: null,
    baseRevision: null,
    occurredAt: "2026-08-10T09:00:00.000Z",
    payload,
    ...overrides,
  };
}

describe.runIf(Boolean(adminUrl))("Guía de la casa: autoría y progreso de lectura", () => {
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

  async function createGuideSpace(name: string): Promise<UUID> {
    return withAuthorizedTransaction(appPool, ADMIN, ROBLE, async (client, membership) =>
      (await createWikiSpace(client, membership, ROBLE, { name })).resourceId,
    );
  }

  async function createRecipeSpace(name: string): Promise<UUID> {
    return withAuthorizedTransaction(appPool, ADMIN, ROBLE, async (client, membership) =>
      (await createWikiSpace(client, membership, ROBLE, { name, kind: "recipes" })).resourceId,
    );
  }

  async function createNote(
    principal: AuthenticatedPrincipal,
    spaceId: UUID,
    title: string,
    options: { publish?: boolean; body?: string } = {},
  ): Promise<{ status: string; pageId: UUID | undefined; errorCode?: string }> {
    const result = await processSyncBatch(
      appPool,
      principal,
      [
        envelope({
          action: "create",
          spaceId,
          title,
          bodyMarkdown: options.body ?? `Contenido de ${title}.`,
          publish: options.publish ?? true,
        }),
      ],
      wikiCommandHandlers,
    );
    const ack = result.acknowledgements[0]!;
    return { status: ack.status, pageId: ack.resourceId as UUID | undefined, ...(ack.errorCode ? { errorCode: ack.errorCode } : {}) };
  }

  it("el recetario sigue siendo de la familia aunque la Guía ya no lo sea", async () => {
    const guide = await createGuideSpace("Acogida integración");
    const recipes = await createRecipeSpace("Recetario integración");

    // La Guía: solo la administración.
    expect(await createNote(FAMILY, guide, "Nota de la familiar")).toMatchObject({
      status: "rejected",
      errorCode: "not_allowed",
    });
    // El recetario: la familia lo mantiene (flujo «Nueva receta desde el hueco»).
    expect(await createNote(FAMILY, recipes, "Croquetas de la familiar")).toMatchObject({
      status: "accepted",
    });
    // La interna no escribe en ninguno de los dos.
    expect(await createNote(EMPLOYEE, recipes, "Receta de la interna")).toMatchObject({
      status: "rejected",
      errorCode: "not_allowed",
    });
  });

  it("«libro» y «progreso» son slugs reservados: la nota se desambigua sola", async () => {
    const guide = await createGuideSpace("Reservados integración");
    const libro = await createNote(ADMIN, guide, "Libro");
    const progreso = await createNote(ADMIN, guide, "Progreso");
    expect(libro.status).toBe("accepted");
    expect(progreso.status).toBe("accepted");

    const slugs = await adminPool.query<{ current_slug: string }>(
      `select current_slug from app.wiki_pages where id = any($1::uuid[]) order by current_slug`,
      [[libro.pageId, progreso.pageId]],
    );
    expect(slugs.rows.map((row) => row.current_slug)).toEqual(["libro-2", "progreso-2"]);
  });

  it("el progreso es del lector: nadie marca por otro y la casa solo ve cuentas", async () => {
    const guide = await createGuideSpace("Progreso integración");
    const first = await createNote(ADMIN, guide, "Primera nota de acogida");
    const second = await createNote(ADMIN, guide, "Segunda nota de acogida");
    const draft = await createNote(ADMIN, guide, "Borrador de acogida", { publish: false });
    const recipes = await createRecipeSpace("Recetario progreso");
    const recipe = await createNote(ADMIN, recipes, "Receta que no es acogida");

    // La interna marca la primera; repetir no duplica.
    const marked = await withAuthorizedTransaction(appPool, EMPLOYEE, ROBLE, async (client) => {
      const once = await client.query<{ mark_wiki_note_read: string | null }>(
        "select app.mark_wiki_note_read($1)",
        [first.pageId],
      );
      await client.query("select app.mark_wiki_note_read($1)", [first.pageId]);
      // Ni el borrador ni la receta cuentan para la acogida.
      const onDraft = await client.query<{ mark_wiki_note_read: string | null }>(
        "select app.mark_wiki_note_read($1)",
        [draft.pageId],
      );
      const onRecipe = await client.query<{ mark_wiki_note_read: string | null }>(
        "select app.mark_wiki_note_read($1)",
        [recipe.pageId],
      );
      const own = await client.query<{ page_id: string }>(
        "select page_id from app.wiki_reading_progress where page_id = any($1::uuid[])",
        [[first.pageId, second.pageId, draft.pageId, recipe.pageId]],
      );
      return {
        fingerprint: once.rows[0]?.mark_wiki_note_read ?? null,
        draft: onDraft.rows[0]?.mark_wiki_note_read ?? null,
        recipe: onRecipe.rows[0]?.mark_wiki_note_read ?? null,
        pages: own.rows.map((row) => row.page_id),
      };
    });
    expect(marked.fingerprint).toMatch(/^[0-9a-f]{32}$/);
    expect(marked.draft).toBeNull();
    expect(marked.recipe).toBeNull();
    expect(marked.pages).toEqual([first.pageId]);

    // La administración no lee una sola fila ajena, y su resumen son cuentas.
    const overview = await withAuthorizedTransaction(appPool, ADMIN, ROBLE, async (client) => {
      const rows = await client.query<{ page_id: string }>(
        "select page_id from app.wiki_reading_progress",
      );
      const summary = await client.query<{
        membership_id: string;
        notes_total: string;
        notes_read: string;
      }>(
        `select membership_id, notes_total, notes_read
           from app.wiki_reading_overview()
          where space_id = $1 and membership_id = $2`,
        [guide, EMPLOYEE_MEMBERSHIP],
      );
      return { leaked: rows.rowCount ?? 0, summary: summary.rows[0] };
    });
    expect(overview.leaked).toBe(0);
    expect(overview.summary).toMatchObject({ notes_total: "2", notes_read: "1" });

    // El resumen es de la administración y de nadie más.
    await expect(
      withAuthorizedTransaction(appPool, EMPLOYEE, ROBLE, (client) =>
        client.query("select * from app.wiki_reading_overview()"),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("invalida con criterio: la coma no cuenta, la palabra sí", async () => {
    const guide = await createGuideSpace("Huella integración");
    const note = await createNote(ADMIN, guide, "Nota con huella", {
      body: "La llave del agua está bajo el fregadero.",
    });

    const original = await withAuthorizedTransaction(appPool, EMPLOYEE, ROBLE, async (client) => {
      const row = await client.query<{ mark_wiki_note_read: string }>(
        "select app.mark_wiki_note_read($1)",
        [note.pageId],
      );
      return row.rows[0]!.mark_wiki_note_read;
    });

    async function editTo(body: string, baseRevision: number): Promise<string> {
      const result = await processSyncBatch(
        appPool,
        ADMIN,
        [
          envelope(
            { action: "edit", pageId: note.pageId, title: "Nota con huella", bodyMarkdown: body },
            { aggregateId: note.pageId as UUID, baseRevision },
          ),
        ],
        wikiCommandHandlers,
      );
      expect(result.acknowledgements[0]).toMatchObject({ status: "accepted" });
      const row = await adminPool.query<{ reading_fingerprint: string }>(
        `select revision.reading_fingerprint
           from app.wiki_pages as page
           join app.wiki_revisions as revision on revision.id = page.current_revision_id
          where page.id = $1`,
        [note.pageId],
      );
      return row.rows[0]!.reading_fingerprint;
    }

    // Cosmética: negrita, otra puntuación, otro salto de línea, acento perdido.
    expect(await editTo("La **llave** del agua, está bajo el fregadero!\n", 1)).toBe(original);
    // Palabras distintas: la nota vuelve a la lista de pendientes.
    expect(await editTo("La llave del agua está en el armario del pasillo.", 2)).not.toBe(original);

    // Y el recuerdo de la lectura NO se borra: sigue constando, con la huella
    // vieja, para poder decir «cambió desde que la leíste».
    const still = await withAuthorizedTransaction(appPool, EMPLOYEE, ROBLE, async (client) => {
      const row = await client.query<{ content_fingerprint: string }>(
        "select content_fingerprint from app.wiki_reading_progress where page_id = $1",
        [note.pageId],
      );
      return row.rows[0]?.content_fingerprint ?? null;
    });
    expect(still).toBe(original);
  });
});
