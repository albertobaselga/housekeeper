import type { PoolClient } from "pg";

import type { UUID } from "@casa-clara/contracts";
import {
  wikiPageCommandPayloadSchema,
  wikiSpaceCreatePayloadSchema,
} from "@casa-clara/contracts/schemas";

import type { ActiveMembership } from "../database.js";
import {
  CommandConflictError,
  CommandRejectedError,
  type CommandHandler,
  type CommandHandlers,
} from "../sync.js";

const WIKI_WRITER_ROLES = new Set(["family_admin", "family_member", "employee_live_in"]);
const SPACE_ADMIN_ROLES = new Set(["family_admin", "family_member"]);

/**
 * Slug estable: minúsculas, sin acentos (NFKD + eliminación de diacríticos) y
 * guiones como único separador. Coincide con el CHECK de la base
 * (`^[a-z0-9]+(?:-[a-z0-9]+)*$`); si el título no deja nada usable se recurre a
 * un genérico para no rechazar títulos como "···".
 */
export function slugifyWikiTitle(value: string): string {
  const base = value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base.length > 0 ? base : "pagina";
}

function nextFreeSlug(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

async function availableSpaceSlug(
  client: PoolClient,
  householdId: UUID,
  base: string,
): Promise<string> {
  const existing = await client.query<{ slug: string }>(
    `select slug from app.wiki_spaces
      where household_id = $1 and (slug = $2 or slug like $2 || '-%')`,
    [householdId, base],
  );
  return nextFreeSlug(base, new Set(existing.rows.map((row) => row.slug)));
}

/**
 * Slug de página con desambiguación por hogar. Los slugs históricos nunca se
 * liberan (AC-15): si un candidato ya pertenece a ESTA página se reutiliza sin
 * insertar (renombrar A→B→A recupera el slug original); si pertenece a otra se
 * prueba el siguiente sufijo; si está libre se registra en `wiki_page_slugs`.
 */
async function ensurePageSlug(
  client: PoolClient,
  householdId: UUID,
  pageId: UUID,
  title: string,
): Promise<string> {
  const base = slugifyWikiTitle(title);
  const existing = await client.query<{ slug: string; page_id: string }>(
    `select slug, page_id from app.wiki_page_slugs
      where household_id = $1 and (slug = $2 or slug like $2 || '-%')`,
    [householdId, base],
  );
  const owners = new Map(existing.rows.map((row) => [row.slug, row.page_id]));
  let candidate = base;
  for (let suffix = 2; owners.has(candidate); suffix += 1) {
    if (owners.get(candidate) === pageId) return candidate;
    candidate = `${base}-${suffix}`;
  }
  await client.query(
    `insert into app.wiki_page_slugs (household_id, page_id, slug) values ($1, $2, $3)`,
    [householdId, pageId, candidate],
  );
  return candidate;
}

interface CurrentRevision {
  id: UUID;
  revisionNumber: number;
  title: string;
}

async function insertRevision(
  client: PoolClient,
  householdId: UUID,
  pageId: UUID,
  revisionNumber: number,
  authoredBy: UUID,
  content: {
    title: string;
    bodyMarkdown: string;
    summary?: string | undefined;
    tags?: string[] | undefined;
    aliases?: string[] | undefined;
  },
): Promise<UUID> {
  const inserted = await client.query<{ id: string }>(
    `insert into app.wiki_revisions
       (household_id, page_id, revision_number, title, body_markdown, summary,
        tags, aliases, authored_by_membership_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     returning id`,
    [
      householdId,
      pageId,
      revisionNumber,
      content.title,
      content.bodyMarkdown,
      content.summary ?? "",
      content.tags ?? [],
      content.aliases ?? [],
      authoredBy,
    ],
  );
  const revisionId = inserted.rows[0]?.id;
  if (!revisionId) throw new Error("La inserción de la revisión no devolvió identificador");
  return revisionId;
}

/**
 * `wiki_space` — solo creación, reservada a la familia (RLS lo respalda con
 * `wiki_spaces_admin_write`; aquí se rechaza antes con un código claro). El
 * slug llega explícito o se deriva del nombre; la colisión con un slug
 * derivado se resuelve con sufijos `-2`, `-3`… y la de un slug explícito se
 * rechaza porque fue una elección deliberada del usuario.
 */
export const wikiSpaceCommandHandler: CommandHandler = async (client, membership, envelope) => {
  if (!SPACE_ADMIN_ROLES.has(membership.role)) {
    throw new CommandRejectedError("not_allowed", "Solo la familia administra espacios de la wiki");
  }
  const parsed = wikiSpaceCreatePayloadSchema.safeParse(envelope.payload);
  if (!parsed.success) {
    throw new CommandRejectedError("invalid_payload", parsed.error.issues[0]?.message);
  }
  const payload = parsed.data;
  const householdId = envelope.householdId;

  let slug: string;
  if (payload.slug !== undefined) {
    const clash = await client.query(
      `select 1 from app.wiki_spaces where household_id = $1 and slug = $2`,
      [householdId, payload.slug],
    );
    if ((clash.rowCount ?? 0) > 0) {
      throw new CommandRejectedError("slug_taken", `El slug ${payload.slug} ya existe en este hogar`);
    }
    slug = payload.slug;
  } else {
    slug = await availableSpaceSlug(client, householdId, slugifyWikiTitle(payload.name));
  }

  const inserted = await client.query<{ id: string }>(
    `insert into app.wiki_spaces (household_id, slug, name, description, created_by_membership_id)
     values ($1, $2, $3, $4, $5)
     returning id`,
    [householdId, slug, payload.name, payload.description ?? "", membership.id],
  );
  const spaceId = inserted.rows[0]?.id;
  if (!spaceId) throw new Error("La inserción del espacio no devolvió identificador");
  return { resourceId: spaceId };
};

async function createPage(
  client: PoolClient,
  membership: ActiveMembership,
  householdId: UUID,
  payload: {
    spaceId: UUID;
    parentPageId?: UUID | null | undefined;
    title: string;
    bodyMarkdown: string;
    tags?: string[] | undefined;
    aliases?: string[] | undefined;
    publish?: boolean | undefined;
  },
): Promise<{ resourceId: UUID; revision: number }> {
  const space = await client.query(
    `select 1 from app.wiki_spaces where household_id = $1 and id = $2 and archived_at is null`,
    [householdId, payload.spaceId],
  );
  if ((space.rowCount ?? 0) === 0) {
    throw new CommandRejectedError("space_not_found", "El espacio no existe o no es visible");
  }

  // El slug se calcula antes de insertar porque `current_slug` es NOT NULL; el
  // registro en wiki_page_slugs llega justo después, en la misma transacción.
  const base = slugifyWikiTitle(payload.title);
  const existing = await client.query<{ slug: string }>(
    `select slug from app.wiki_page_slugs
      where household_id = $1 and (slug = $2 or slug like $2 || '-%')`,
    [householdId, base],
  );
  const slug = nextFreeSlug(base, new Set(existing.rows.map((row) => row.slug)));

  const inserted = await client.query<{ id: string }>(
    `insert into app.wiki_pages
       (household_id, space_id, parent_page_id, status, current_slug, created_by_membership_id)
     values ($1, $2, $3, $4, $5, $6)
     returning id`,
    [
      householdId,
      payload.spaceId,
      payload.parentPageId ?? null,
      payload.publish === true ? "published" : "draft",
      slug,
      membership.id,
    ],
  );
  const pageId = inserted.rows[0]?.id;
  if (!pageId) throw new Error("La inserción de la página no devolvió identificador");

  await client.query(
    `insert into app.wiki_page_slugs (household_id, page_id, slug) values ($1, $2, $3)`,
    [householdId, pageId, slug],
  );

  const revisionId = await insertRevision(client, householdId, pageId, 1, membership.id, payload);
  await client.query(
    `update app.wiki_pages set current_revision_id = $3 where household_id = $1 and id = $2`,
    [householdId, pageId, revisionId],
  );
  return { resourceId: pageId, revision: 1 };
}

async function loadPageForUpdate(
  client: PoolClient,
  householdId: UUID,
  pageId: UUID,
): Promise<{ currentSlug: string; currentRevision: CurrentRevision | null }> {
  const loaded = await client.query<{ current_slug: string; current_revision_id: string | null }>(
    `select current_slug, current_revision_id
       from app.wiki_pages
      where household_id = $1 and id = $2
      for update`,
    [householdId, pageId],
  );
  const page = loaded.rows[0];
  if (!page) {
    throw new CommandRejectedError("page_not_found", "La página no existe o no es visible");
  }
  if (page.current_revision_id === null) {
    return { currentSlug: page.current_slug, currentRevision: null };
  }
  const revision = await client.query<{ id: string; revision_number: number; title: string }>(
    `select id, revision_number, title
       from app.wiki_revisions
      where household_id = $1 and id = $2`,
    [householdId, page.current_revision_id],
  );
  const row = revision.rows[0];
  return {
    currentSlug: page.current_slug,
    currentRevision: row ? { id: row.id, revisionNumber: row.revision_number, title: row.title } : null,
  };
}

async function editPage(
  client: PoolClient,
  membership: ActiveMembership,
  householdId: UUID,
  baseRevision: number | null,
  payload: {
    pageId: UUID;
    title: string;
    bodyMarkdown: string;
    summary?: string | undefined;
    tags?: string[] | undefined;
    aliases?: string[] | undefined;
  },
): Promise<{ resourceId: UUID; revision: number }> {
  const { currentRevision } = await loadPageForUpdate(client, householdId, payload.pageId);
  const currentNumber = currentRevision?.revisionNumber ?? 0;

  // Edición a ciegas (baseRevision null) o sobre una revisión superada: ambas
  // requieren que una persona compare y decida; nunca se fusiona en silencio.
  if (baseRevision === null || baseRevision !== currentNumber) {
    throw new CommandConflictError(
      "wiki_revision_conflict",
      `La página va por la revisión ${currentNumber}; la edición partía de ${baseRevision ?? "ninguna"}`,
    );
  }

  const revisionNumber = currentNumber + 1;
  const revisionId = await insertRevision(
    client,
    householdId,
    payload.pageId,
    revisionNumber,
    membership.id,
    payload,
  );

  const titleChanged = currentRevision === null || currentRevision.title !== payload.title;
  if (titleChanged) {
    // El título nuevo genera slug nuevo; los anteriores se conservan en
    // wiki_page_slugs para que ningún enlace guardado se rompa (AC-15).
    const slug = await ensurePageSlug(client, householdId, payload.pageId, payload.title);
    await client.query(
      `update app.wiki_pages
          set current_revision_id = $3, current_slug = $4
        where household_id = $1 and id = $2`,
      [householdId, payload.pageId, revisionId, slug],
    );
  } else {
    await client.query(
      `update app.wiki_pages set current_revision_id = $3 where household_id = $1 and id = $2`,
      [householdId, payload.pageId, revisionId],
    );
  }
  return { resourceId: payload.pageId, revision: revisionNumber };
}

async function setPageState(
  client: PoolClient,
  householdId: UUID,
  payload: { pageId: UUID; status?: "draft" | "published" | undefined; pinned?: boolean | undefined },
): Promise<{ resourceId: UUID }> {
  await loadPageForUpdate(client, householdId, payload.pageId);
  await client.query(
    `update app.wiki_pages
        set status = coalesce($3::app.wiki_page_status, status),
            pinned = coalesce($4, pinned)
      where household_id = $1 and id = $2`,
    [householdId, payload.pageId, payload.status ?? null, payload.pinned ?? null],
  );
  return { resourceId: payload.pageId };
}

/**
 * `wiki_page` — create / edit / set_state. La escritura pertenece a familia y
 * empleada (viewer y helper se rechazan aquí con `not_allowed`, además del
 * respaldo RLS). `edit` exige `envelope.baseRevision` igual a la revisión
 * vigente; en caso contrario el ACK es `conflict` con resolución humana.
 */
export const wikiPageCommandHandler: CommandHandler = async (client, membership, envelope) => {
  if (!WIKI_WRITER_ROLES.has(membership.role)) {
    throw new CommandRejectedError("not_allowed", "Este rol no puede escribir en la wiki");
  }
  const parsed = wikiPageCommandPayloadSchema.safeParse(envelope.payload);
  if (!parsed.success) {
    throw new CommandRejectedError("invalid_payload", parsed.error.issues[0]?.message);
  }
  const payload = parsed.data;
  const householdId = envelope.householdId;

  switch (payload.action) {
    case "create":
      return createPage(client, membership, householdId, payload);
    case "edit":
      return editPage(client, membership, householdId, envelope.baseRevision, payload);
    case "set_state":
      return setPageState(client, householdId, payload);
  }
};

/** Handlers de la wiki listos para `processSyncBatch`. */
export const wikiCommandHandlers: CommandHandlers = {
  wiki_page: wikiPageCommandHandler,
  wiki_space: wikiSpaceCommandHandler,
};
