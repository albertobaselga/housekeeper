import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { API_VERSION, type CommandEnvelopeV1, type UUID } from "@housekeeper/contracts";

import { wikiCommandHandlers } from "./commands/wiki.js";
import { withAuthorizedTransaction, type AuthenticatedPrincipal } from "./database.js";
import { processSyncBatch } from "./sync.js";

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const ROBLE_HOUSEHOLD = "10000000-0000-4000-8000-000000000001";
const OLIVO_HOUSEHOLD = "20000000-0000-4000-8000-000000000001";
const ROBLE_ADMIN_MEMBERSHIP = "11000000-0000-4000-8000-000000000001";
const APP_LOGIN = "it_housekeeper_app_login";

const ROBLE_ADMIN: AuthenticatedPrincipal = { userId: "fixture:roble:admin" };
const ROBLE_EMPLOYEE: AuthenticatedPrincipal = { userId: "fixture:roble:employee" };
const OLIVO_ADMIN: AuthenticatedPrincipal = { userId: "fixture:olivo:admin" };

const HANDLERS = wikiCommandHandlers;

function envelope(
  aggregateType: "wiki_space" | "wiki_page",
  operationId: string,
  payload: unknown,
  overrides: Partial<CommandEnvelopeV1> = {},
): CommandEnvelopeV1 {
  return {
    apiVersion: API_VERSION,
    operationId,
    householdId: ROBLE_HOUSEHOLD,
    schemaVersion: 1,
    aggregateType,
    aggregateId: null,
    baseRevision: null,
    occurredAt: "2026-08-07T10:00:00.000Z",
    payload,
    ...overrides,
  };
}

describe.runIf(Boolean(adminUrl))("plantillas de espacios wiki (F4-01) sobre Postgres real", () => {
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

  async function accepted(
    principal: AuthenticatedPrincipal,
    command: CommandEnvelopeV1,
  ): Promise<UUID> {
    const result = await processSyncBatch(appPool, principal, [command], HANDLERS);
    expect(result.acknowledgements[0]).toMatchObject({
      operationId: command.operationId,
      status: "accepted",
    });
    return result.acknowledgements[0]?.resourceId as UUID;
  }

  async function createSpace(name: string): Promise<UUID> {
    return accepted(ROBLE_ADMIN, envelope("wiki_space", randomUUID(), { action: "create", name }));
  }

  async function createPage(
    spaceId: UUID,
    title: string,
    options: { bodyMarkdown?: string; parentPageId?: UUID; publish?: boolean } = {},
  ): Promise<UUID> {
    return accepted(
      ROBLE_ADMIN,
      envelope("wiki_page", randomUUID(), {
        action: "create",
        spaceId,
        ...(options.parentPageId ? { parentPageId: options.parentPageId } : {}),
        title,
        bodyMarkdown: options.bodyMarkdown ?? `Contenido de ${title}.`,
        publish: options.publish ?? true,
      }),
    );
  }

  interface ClonedPage {
    id: string;
    parent_page_id: string | null;
    status: string;
    current_slug: string;
    pinned: boolean;
  }

  async function pagesOfSpace(spaceId: UUID): Promise<ClonedPage[]> {
    const rows = await adminPool.query<ClonedPage>(
      `select id, parent_page_id, status::text as status, current_slug, pinned
         from app.wiki_pages where space_id = $1 order by current_slug`,
      [spaceId],
    );
    return rows.rows;
  }

  it("set_template marca y desmarca; clone_template copia jerarquía, revisión vigente, slugs y enlaces", async () => {
    // Espacio origen con jerarquía de tres niveles y otro espacio de referencia.
    const templateSpaceId = await createSpace("Manual de la casa");
    const otherSpaceId = await createSpace("Referencias");
    await createPage(otherSpaceId, "Página externa");

    const parentId = await createPage(templateSpaceId, "Cafetera", {
      bodyMarkdown:
        "Consulta [el filtro](wiki:filtro-de-la-cafetera), " +
        "[otra guía](wiki:pagina-externa) y [la web](https://example.com/guia).",
    });
    const childId = await createPage(templateSpaceId, "Filtro de la cafetera", {
      parentPageId: parentId,
      publish: false,
      bodyMarkdown: "Vuelve a [la cafetera](wiki:cafetera).",
    });
    await createPage(templateSpaceId, "Junta del filtro", {
      parentPageId: childId,
      bodyMarkdown: "Cambia la junta cada año.",
    });

    // Revisión 2 del padre (renombrado): el clon debe copiar ESTE contenido,
    // no la revisión 1, y el slug histórico 'cafetera' debe seguir remapeando.
    await accepted(
      ROBLE_ADMIN,
      envelope(
        "wiki_page",
        randomUUID(),
        {
          action: "edit",
          pageId: parentId,
          title: "Cafetera nueva",
          bodyMarkdown:
            "Rev2: [el filtro](wiki:filtro-de-la-cafetera), " +
            "[otra guía](wiki:pagina-externa) y [la web](https://example.com/guia).",
        },
        { aggregateId: parentId, baseRevision: 1 },
      ),
    );
    await accepted(
      ROBLE_ADMIN,
      envelope(
        "wiki_page",
        randomUUID(),
        { action: "set_state", pageId: parentId, pinned: true },
        { aggregateId: parentId },
      ),
    );

    // set_template: marca el origen como plantilla.
    await accepted(
      ROBLE_ADMIN,
      envelope(
        "wiki_space",
        randomUUID(),
        { action: "set_template", spaceId: templateSpaceId, isTemplate: true },
        { aggregateId: templateSpaceId },
      ),
    );
    let flag = await adminPool.query(`select is_template from app.wiki_spaces where id = $1`, [
      templateSpaceId,
    ]);
    expect(flag.rows[0]).toEqual({ is_template: true });

    const originSlugsBefore = await adminPool.query<{ slug: string }>(
      `select slug from app.wiki_page_slugs
        where household_id = $1
          and page_id in (select id from app.wiki_pages where space_id = $2)
        order by slug`,
      [ROBLE_HOUSEHOLD, templateSpaceId],
    );
    expect(originSlugsBefore.rows.map((row) => row.slug)).toEqual([
      "cafetera",
      "cafetera-nueva",
      "filtro-de-la-cafetera",
      "junta-del-filtro",
    ]);

    // clone_template: espacio nuevo con toda la jerarquía.
    const cloneEnvelope = envelope("wiki_space", randomUUID(), {
      action: "clone_template",
      templateSpaceId,
      name: "Manual clonado",
    });
    const cloneSpaceId = await accepted(ROBLE_ADMIN, cloneEnvelope);
    expect(cloneSpaceId).not.toBe(templateSpaceId);

    const cloneSpace = await adminPool.query(
      `select slug, name, is_template from app.wiki_spaces where id = $1`,
      [cloneSpaceId],
    );
    expect(cloneSpace.rows[0]).toEqual({
      slug: "manual-clonado",
      name: "Manual clonado",
      is_template: false,
    });

    const cloned = await pagesOfSpace(cloneSpaceId);
    expect(cloned.map((page) => page.current_slug)).toEqual([
      "cafetera-nueva-2",
      "filtro-de-la-cafetera-2",
      "junta-del-filtro-2",
    ]);

    // Jerarquía remapeada al clon: padre raíz, hija del padre, nieta de la hija.
    const cloneParent = cloned.find((page) => page.current_slug === "cafetera-nueva-2")!;
    const cloneChild = cloned.find((page) => page.current_slug === "filtro-de-la-cafetera-2")!;
    const cloneGrandchild = cloned.find((page) => page.current_slug === "junta-del-filtro-2")!;
    expect(cloneParent.parent_page_id).toBeNull();
    expect(cloneChild.parent_page_id).toBe(cloneParent.id);
    expect(cloneGrandchild.parent_page_id).toBe(cloneChild.id);

    // status y pinned copiados del origen.
    expect(cloneParent).toMatchObject({ status: "published", pinned: true });
    expect(cloneChild).toMatchObject({ status: "draft", pinned: false });
    expect(cloneGrandchild).toMatchObject({ status: "published", pinned: false });

    // Contenido: una única revisión (la 1) por página clonada, con el cuerpo de
    // la revisión VIGENTE del origen, firmada por la actora y con el summary
    // de clonación; los enlaces al propio espacio origen (incluido el slug
    // histórico 'cafetera') apuntan al clon y el resto queda intacto.
    const cloneRevisions = await adminPool.query<{
      page_id: string;
      revision_number: number;
      title: string;
      body_markdown: string;
      summary: string;
      authored_by_membership_id: string;
    }>(
      `select page_id, revision_number, title, body_markdown, summary, authored_by_membership_id
         from app.wiki_revisions where page_id = any($1::uuid[])`,
      [[cloneParent.id, cloneChild.id, cloneGrandchild.id]],
    );
    expect(cloneRevisions.rows).toHaveLength(3);
    for (const revision of cloneRevisions.rows) {
      expect(revision.revision_number).toBe(1);
      expect(revision.summary).toBe("clonada de plantilla");
      expect(revision.authored_by_membership_id).toBe(ROBLE_ADMIN_MEMBERSHIP);
    }
    const parentRevision = cloneRevisions.rows.find((row) => row.page_id === cloneParent.id)!;
    expect(parentRevision.title).toBe("Cafetera nueva");
    expect(parentRevision.body_markdown).toBe(
      "Rev2: [el filtro](wiki:filtro-de-la-cafetera-2), " +
        "[otra guía](wiki:pagina-externa) y [la web](https://example.com/guia).",
    );
    const childRevision = cloneRevisions.rows.find((row) => row.page_id === cloneChild.id)!;
    expect(childRevision.body_markdown).toBe("Vuelve a [la cafetera](wiki:cafetera-nueva-2).");

    // Slugs nuevos registrados para el clon; los del origen quedan intactos.
    const cloneSlugs = await adminPool.query<{ slug: string; page_id: string }>(
      `select slug, page_id from app.wiki_page_slugs
        where household_id = $1 and page_id = any($2::uuid[]) order by slug`,
      [ROBLE_HOUSEHOLD, [cloneParent.id, cloneChild.id, cloneGrandchild.id]],
    );
    expect(cloneSlugs.rows.map((row) => row.slug)).toEqual([
      "cafetera-nueva-2",
      "filtro-de-la-cafetera-2",
      "junta-del-filtro-2",
    ]);
    const originSlugsAfter = await adminPool.query<{ slug: string }>(
      `select slug from app.wiki_page_slugs
        where household_id = $1
          and page_id in (select id from app.wiki_pages where space_id = $2)
        order by slug`,
      [ROBLE_HOUSEHOLD, templateSpaceId],
    );
    expect(originSlugsAfter.rows).toEqual(originSlugsBefore.rows);
    const originRevisions = await adminPool.query(
      `select count(*)::int as total from app.wiki_revisions where page_id = $1`,
      [parentId],
    );
    expect(originRevisions.rows[0]).toEqual({ total: 2 });

    // Replay del mismo envelope → duplicate, sin espacio ni páginas nuevas.
    const replay = await processSyncBatch(appPool, ROBLE_ADMIN, [cloneEnvelope], HANDLERS);
    expect(replay.acknowledgements[0]).toMatchObject({
      operationId: cloneEnvelope.operationId,
      status: "duplicate",
      resourceId: cloneSpaceId,
    });
    const spacesNamed = await adminPool.query(
      `select count(*)::int as total from app.wiki_spaces where household_id = $1 and name = 'Manual clonado'`,
      [ROBLE_HOUSEHOLD],
    );
    expect(spacesNamed.rows[0]).toEqual({ total: 1 });

    // set_template false: la plantilla vuelve a ser un espacio normal.
    await accepted(
      ROBLE_ADMIN,
      envelope(
        "wiki_space",
        randomUUID(),
        { action: "set_template", spaceId: templateSpaceId, isTemplate: false },
        { aggregateId: templateSpaceId },
      ),
    );
    flag = await adminPool.query(`select is_template from app.wiki_spaces where id = $1`, [
      templateSpaceId,
    ]);
    expect(flag.rows[0]).toEqual({ is_template: false });
  });

  it("clonar un espacio que no es plantilla responde template_not_found", async () => {
    const spaceId = await createSpace("Espacio normal");
    const result = await processSyncBatch(
      appPool,
      ROBLE_ADMIN,
      [
        envelope("wiki_space", randomUUID(), {
          action: "clone_template",
          templateSpaceId: spaceId,
          name: "Copia imposible",
        }),
      ],
      HANDLERS,
    );
    expect(result.acknowledgements[0]).toMatchObject({
      status: "rejected",
      errorCode: "template_not_found",
    });
  });

  it("la empleada no administra plantillas: set_template y clone_template → not_allowed", async () => {
    const spaceId = await createSpace("Solo familia");
    await accepted(
      ROBLE_ADMIN,
      envelope(
        "wiki_space",
        randomUUID(),
        { action: "set_template", spaceId, isTemplate: true },
        { aggregateId: spaceId },
      ),
    );

    for (const payload of [
      { action: "set_template", spaceId, isTemplate: false },
      { action: "clone_template", templateSpaceId: spaceId, name: "Copia de empleada" },
    ]) {
      const result = await processSyncBatch(
        appPool,
        ROBLE_EMPLOYEE,
        [envelope("wiki_space", randomUUID(), payload)],
        HANDLERS,
      );
      expect(result.acknowledgements[0]).toMatchObject({
        status: "rejected",
        errorCode: "not_allowed",
      });
    }
  });

  it("F4-01 multi-tenant: olivo no clona la plantilla de roble y no ve nada del clon", async () => {
    const templateSpaceId = await createSpace("Plantilla de roble");
    await createPage(templateSpaceId, "Secreto de roble", {
      bodyMarkdown: "Contenido que olivo jamás debe ver.",
    });
    await accepted(
      ROBLE_ADMIN,
      envelope(
        "wiki_space",
        randomUUID(),
        { action: "set_template", spaceId: templateSpaceId, isTemplate: true },
        { aggregateId: templateSpaceId },
      ),
    );

    // El admin de olivo intenta clonar la plantilla de roble desde su hogar:
    // RLS hace que el origen "no exista" → template_not_found.
    const crossClone = await processSyncBatch(
      appPool,
      OLIVO_ADMIN,
      [
        envelope(
          "wiki_space",
          randomUUID(),
          { action: "clone_template", templateSpaceId, name: "Robo de plantilla" },
          { householdId: OLIVO_HOUSEHOLD },
        ),
      ],
      HANDLERS,
    );
    expect(crossClone.acknowledgements[0]).toMatchObject({
      status: "rejected",
      errorCode: "template_not_found",
    });

    // Roble sí clona; después olivo sigue sin ver ni el espacio ni las páginas.
    const cloneSpaceId = await accepted(
      ROBLE_ADMIN,
      envelope("wiki_space", randomUUID(), {
        action: "clone_template",
        templateSpaceId,
        name: "Clon de roble",
      }),
    );
    const clonedPages = await pagesOfSpace(cloneSpaceId);
    expect(clonedPages).toHaveLength(1);

    const olivoView = await withAuthorizedTransaction(
      appPool,
      OLIVO_ADMIN,
      OLIVO_HOUSEHOLD,
      async (client) => {
        const spaces = await client.query(
          `select id from app.wiki_spaces where id = any($1::uuid[])`,
          [[templateSpaceId, cloneSpaceId]],
        );
        const pages = await client.query(
          `select id from app.wiki_pages where id = any($1::uuid[])`,
          [clonedPages.map((page) => page.id)],
        );
        const revisions = await client.query(
          `select id from app.wiki_revisions where page_id = any($1::uuid[])`,
          [clonedPages.map((page) => page.id)],
        );
        return {
          spaces: spaces.rowCount ?? 0,
          pages: pages.rowCount ?? 0,
          revisions: revisions.rowCount ?? 0,
        };
      },
    );
    expect(olivoView).toEqual({ spaces: 0, pages: 0, revisions: 0 });
  });
});
