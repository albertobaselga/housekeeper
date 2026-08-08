import type { PoolClient } from "pg";

import type { UUID } from "@casa-clara/contracts";
import {
  wikiPageCommandPayloadSchema,
  wikiSpaceCommandPayloadSchema,
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
 * Slug del espacio nuevo: explícito → la colisión se rechaza (fue una elección
 * deliberada); derivado del nombre → se desambigua con sufijos `-2`, `-3`…
 */
async function resolveSpaceSlug(
  client: PoolClient,
  householdId: UUID,
  name: string,
  explicitSlug: string | undefined,
): Promise<string> {
  if (explicitSlug !== undefined) {
    const clash = await client.query(
      `select 1 from app.wiki_spaces where household_id = $1 and slug = $2`,
      [householdId, explicitSlug],
    );
    if ((clash.rowCount ?? 0) > 0) {
      throw new CommandRejectedError("slug_taken", `El slug ${explicitSlug} ya existe en este hogar`);
    }
    return explicitSlug;
  }
  return availableSpaceSlug(client, householdId, slugifyWikiTitle(name));
}

/**
 * Creación de espacio con slug desambiguado. Exportada para que el flujo
 * «Nueva receta desde el menú» pueda crear el espacio «Recetas» del hogar la
 * primera vez, con el mismo camino que el comando `wiki_space.create`.
 */
export async function createWikiSpace(
  client: PoolClient,
  membership: ActiveMembership,
  householdId: UUID,
  payload: { name: string; slug?: string | undefined; description?: string | undefined },
): Promise<{ resourceId: UUID }> {
  const slug = await resolveSpaceSlug(client, householdId, payload.name, payload.slug);
  const inserted = await client.query<{ id: string }>(
    `insert into app.wiki_spaces (household_id, slug, name, description, created_by_membership_id)
     values ($1, $2, $3, $4, $5)
     returning id`,
    [householdId, slug, payload.name, payload.description ?? "", membership.id],
  );
  const spaceId = inserted.rows[0]?.id;
  if (!spaceId) throw new Error("La inserción del espacio no devolvió identificador");
  return { resourceId: spaceId };
}

/** Marca o desmarca un espacio como plantilla clonable (solo familia). */
async function setSpaceTemplate(
  client: PoolClient,
  householdId: UUID,
  payload: { spaceId: UUID; isTemplate: boolean },
): Promise<{ resourceId: UUID }> {
  const updated = await client.query(
    `update app.wiki_spaces
        set is_template = $3
      where household_id = $1 and id = $2 and archived_at is null`,
    [householdId, payload.spaceId, payload.isTemplate],
  );
  if ((updated.rowCount ?? 0) === 0) {
    throw new CommandRejectedError("space_not_found", "El espacio no existe o no es visible");
  }
  return { resourceId: payload.spaceId };
}

interface TemplatePageRow {
  id: string;
  parent_page_id: string | null;
  status: "draft" | "published";
  pinned: boolean;
  position: number;
  current_revision_id: string | null;
}

interface TemplateRevisionRow {
  id: string;
  page_id: string;
  title: string;
  body_markdown: string;
  tags: string[];
  aliases: string[];
}

/**
 * Enlaces internos `[texto](wiki:slug)` del cuerpo: los que resuelven a una
 * página del espacio ORIGEN (por cualquiera de sus slugs, vigente o histórico)
 * se reescriben al slug de la página clonada; el resto (otras wikis del hogar,
 * externos) se conserva tal cual.
 */
function rewriteWikiLinks(body: string, slugMap: ReadonlyMap<string, string>): string {
  return body.replace(/\]\(wiki:([a-z0-9]+(?:-[a-z0-9]+)*)\)/g, (match, slug: string) => {
    const target = slugMap.get(slug);
    return target === undefined ? match : `](wiki:${target})`;
  });
}

/**
 * Clona un espacio plantilla DEL MISMO HOGAR como espacio nuevo editable:
 * copia toda la jerarquía de páginas (parent remapeado al clon, mismo
 * status/pinned/position) y, por página, una revisión 1 con el contenido de la
 * revisión VIGENTE del origen firmada por la membresía actora. Los slugs de
 * las páginas clonadas se desambiguan con los sufijos habituales (son únicos
 * por hogar) sin tocar los del origen. RLS acota el SELECT del origen al
 * hogar del contexto: una plantilla de otro hogar simplemente "no existe".
 */
async function cloneTemplateSpace(
  client: PoolClient,
  membership: ActiveMembership,
  householdId: UUID,
  payload: { templateSpaceId: UUID; name: string; slug?: string | undefined },
): Promise<{ resourceId: UUID }> {
  const origin = await client.query<{ description: string }>(
    `select description from app.wiki_spaces
      where household_id = $1 and id = $2 and is_template = true and archived_at is null`,
    [householdId, payload.templateSpaceId],
  );
  if ((origin.rowCount ?? 0) === 0) {
    throw new CommandRejectedError(
      "template_not_found",
      "La plantilla no existe en este hogar o no está marcada como plantilla",
    );
  }

  const spaceSlug = await resolveSpaceSlug(client, householdId, payload.name, payload.slug);
  const insertedSpace = await client.query<{ id: string }>(
    `insert into app.wiki_spaces (household_id, slug, name, description, created_by_membership_id)
     values ($1, $2, $3, $4, $5)
     returning id`,
    [householdId, spaceSlug, payload.name, origin.rows[0]?.description ?? "", membership.id],
  );
  const newSpaceId = insertedSpace.rows[0]?.id;
  if (!newSpaceId) throw new Error("La inserción del espacio clonado no devolvió identificador");

  const pages = await client.query<TemplatePageRow>(
    `select id, parent_page_id, status::text as status, pinned, position, current_revision_id
       from app.wiki_pages
      where household_id = $1 and space_id = $2 and archived_at is null
      order by position, created_at, id`,
    [householdId, payload.templateSpaceId],
  );

  // Solo se clona lo que tiene contenido vigente (toda página creada por
  // comando lo tiene; una sin revisión sería un resto inconsistente).
  const clonable = pages.rows.filter((row) => row.current_revision_id !== null);
  if (clonable.length === 0) return { resourceId: newSpaceId };

  const revisionRows = await client.query<TemplateRevisionRow>(
    `select id, page_id, title, body_markdown, tags, aliases
       from app.wiki_revisions
      where household_id = $1 and id = any($2::uuid[])`,
    [householdId, clonable.map((row) => row.current_revision_id)],
  );
  const currentRevisionByPage = new Map(revisionRows.rows.map((row) => [row.page_id, row]));

  // Fase 1 — páginas y slugs, de padres a hijas (la FK exige el padre antes):
  // por página, slug nuevo desambiguado a partir del título vigente.
  const clonableIds = new Set(clonable.map((row) => row.id));
  const childrenOf = new Map<string | null, TemplatePageRow[]>();
  for (const row of clonable) {
    // Si el padre no es clonable (fuera del espacio no puede estar; sin
    // revisión vigente sí), la hija cuelga de la raíz del clon.
    const parentKey = row.parent_page_id !== null && clonableIds.has(row.parent_page_id) ? row.parent_page_id : null;
    const siblings = childrenOf.get(parentKey) ?? [];
    siblings.push(row);
    childrenOf.set(parentKey, siblings);
  }

  const newPageIdByOrigin = new Map<string, string>();
  const newSlugByOriginPage = new Map<string, string>();
  const queue: TemplatePageRow[] = [...(childrenOf.get(null) ?? [])];
  while (queue.length > 0) {
    const originPage = queue.shift()!;
    const revision = currentRevisionByPage.get(originPage.id);
    if (!revision) continue;

    const base = slugifyWikiTitle(revision.title);
    const existing = await client.query<{ slug: string }>(
      `select slug from app.wiki_page_slugs
        where household_id = $1 and (slug = $2 or slug like $2 || '-%')`,
      [householdId, base],
    );
    const slug = nextFreeSlug(base, new Set(existing.rows.map((row) => row.slug)));

    const parentId =
      originPage.parent_page_id !== null
        ? newPageIdByOrigin.get(originPage.parent_page_id) ?? null
        : null;
    const insertedPage = await client.query<{ id: string }>(
      `insert into app.wiki_pages
         (household_id, space_id, parent_page_id, status, current_slug, pinned, position,
          created_by_membership_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       returning id`,
      [
        householdId,
        newSpaceId,
        parentId,
        originPage.status,
        slug,
        originPage.pinned,
        originPage.position,
        membership.id,
      ],
    );
    const newPageId = insertedPage.rows[0]?.id;
    if (!newPageId) throw new Error("La inserción de la página clonada no devolvió identificador");
    await client.query(
      `insert into app.wiki_page_slugs (household_id, page_id, slug) values ($1, $2, $3)`,
      [householdId, newPageId, slug],
    );
    newPageIdByOrigin.set(originPage.id, newPageId);
    newSlugByOriginPage.set(originPage.id, slug);
    queue.push(...(childrenOf.get(originPage.id) ?? []));
  }

  // Fase 2 — contenido: todos los slugs del origen (vigentes e históricos)
  // resuelven al slug del clon para que los enlaces internos no apunten atrás.
  const originSlugs = await client.query<{ slug: string; page_id: string }>(
    `select slug, page_id from app.wiki_page_slugs
      where household_id = $1 and page_id = any($2::uuid[])`,
    [householdId, [...newSlugByOriginPage.keys()]],
  );
  const slugMap = new Map<string, string>();
  for (const row of originSlugs.rows) {
    const target = newSlugByOriginPage.get(row.page_id);
    if (target !== undefined && !slugMap.has(row.slug)) slugMap.set(row.slug, target);
  }

  for (const [originPageId, newPageId] of newPageIdByOrigin) {
    const revision = currentRevisionByPage.get(originPageId);
    if (!revision) continue;
    const revisionId = await insertRevision(client, householdId, newPageId, 1, membership.id, {
      title: revision.title,
      bodyMarkdown: rewriteWikiLinks(revision.body_markdown, slugMap),
      summary: "clonada de plantilla",
      tags: revision.tags,
      aliases: revision.aliases,
    });
    await client.query(
      `update app.wiki_pages set current_revision_id = $3 where household_id = $1 and id = $2`,
      [householdId, newPageId, revisionId],
    );
  }

  return { resourceId: newSpaceId };
}

/**
 * `wiki_space` — create / set_template / clone_template, reservado a la
 * familia (RLS lo respalda con `wiki_spaces_admin_write`; aquí se rechaza
 * antes con un código claro). `clone_template` exige un origen del MISMO
 * hogar con `is_template = true`; en cualquier otro caso responde
 * `template_not_found`.
 */
export const wikiSpaceCommandHandler: CommandHandler = async (client, membership, envelope) => {
  if (!SPACE_ADMIN_ROLES.has(membership.role)) {
    throw new CommandRejectedError("not_allowed", "Solo la familia administra espacios de la wiki");
  }
  const parsed = wikiSpaceCommandPayloadSchema.safeParse(envelope.payload);
  if (!parsed.success) {
    throw new CommandRejectedError("invalid_payload", parsed.error.issues[0]?.message);
  }
  const payload = parsed.data;
  const householdId = envelope.householdId;

  switch (payload.action) {
    case "create":
      return createWikiSpace(client, membership, householdId, payload);
    case "set_template":
      return setSpaceTemplate(client, householdId, payload);
    case "clone_template":
      return cloneTemplateSpace(client, membership, householdId, payload);
  }
};

/**
 * Creación de página con su revisión 1 y su slug registrado. Exportada porque
 * el flujo «Nueva receta desde el hueco del menú» (menu.ts) crea la página
 * wiki de la receta con EXACTAMENTE este camino, dentro de su misma
 * transacción de comando.
 */
/**
 * Apartado donde va la nota. Con `spaceId` se exige que exista. Con
 * `spaceSlug` se busca por slug y, si el hogar aún no lo tiene, se CREA en la
 * misma transacción (alta implícita, solo familia): así se puede escribir la
 * primera instrucción sin conexión, porque el cliente ya no depende de un
 * identificador que antes solo llegaba con el ACK del apartado.
 */
async function resolvePageSpace(
  client: PoolClient,
  membership: ActiveMembership,
  householdId: UUID,
  payload: { spaceId?: UUID | undefined; spaceSlug?: string | undefined; spaceName?: string | undefined },
): Promise<UUID> {
  if (payload.spaceId !== undefined) {
    const space = await client.query(
      `select 1 from app.wiki_spaces where household_id = $1 and id = $2 and archived_at is null`,
      [householdId, payload.spaceId],
    );
    if ((space.rowCount ?? 0) === 0) {
      throw new CommandRejectedError("space_not_found", "El espacio no existe o no es visible");
    }
    return payload.spaceId;
  }

  const slug = payload.spaceSlug;
  if (slug === undefined) {
    throw new CommandRejectedError("invalid_payload", "La nota necesita un apartado");
  }
  const existing = await client.query<{ id: string; archived: boolean }>(
    `select id, (archived_at is not null) as archived
       from app.wiki_spaces where household_id = $1 and slug = $2`,
    [householdId, slug],
  );
  const row = existing.rows[0];
  if (row) {
    if (row.archived) {
      throw new CommandRejectedError("space_not_found", "Ese apartado está archivado");
    }
    return row.id;
  }
  if (!SPACE_ADMIN_ROLES.has(membership.role)) {
    throw new CommandRejectedError("not_allowed", "Solo la familia crea apartados nuevos");
  }
  const created = await createWikiSpace(client, membership, householdId, {
    name: payload.spaceName ?? slug,
    slug,
  });
  return created.resourceId;
}

export async function createWikiPage(
  client: PoolClient,
  membership: ActiveMembership,
  householdId: UUID,
  payload: {
    spaceId?: UUID | undefined;
    spaceSlug?: string | undefined;
    spaceName?: string | undefined;
    parentPageId?: UUID | null | undefined;
    title: string;
    bodyMarkdown: string;
    tags?: string[] | undefined;
    aliases?: string[] | undefined;
    publish?: boolean | undefined;
  },
): Promise<{ resourceId: UUID; revision: number }> {
  const spaceId = await resolvePageSpace(client, membership, householdId, payload);

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
      spaceId,
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
      return createWikiPage(client, membership, householdId, payload);
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
