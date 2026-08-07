import type { Pool, PoolClient } from 'pg';

import type { Role } from '@casa-clara/contracts';
import { AuthorizationError, withAuthorizedTransaction } from '@casa-clara/server';

import { diffLines, type WikiDiffLine } from '$lib/wiki/diff';
import { getDatabasePool } from './db.server';

const WRITER_ROLES: readonly Role[] = ['family_admin', 'family_member', 'employee_live_in'];
const PUBLISHER_ROLES: readonly Role[] = ['family_admin', 'family_member'];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DATE_LABEL = new Intl.DateTimeFormat('es-ES', {
  day: 'numeric',
  month: 'short',
  timeZone: 'Europe/Madrid'
});
const DATE_TIME_LABEL = new Intl.DateTimeFormat('es-ES', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Europe/Madrid'
});

function isoAndLabel(value: Date): { iso: string; label: string } {
  return { iso: value.toISOString(), label: DATE_LABEL.format(value) };
}

export interface WikiPageNode {
  id: string;
  slug: string;
  title: string;
  status: 'draft' | 'published';
  pinned: boolean;
  updatedAt: string;
  updatedLabel: string;
  reads30d: number;
  children: WikiPageNode[];
}

export interface WikiSpaceView {
  id: string;
  slug: string;
  name: string;
  description: string;
  pages: WikiPageNode[];
}

export interface WikiHomeEntry {
  id: string;
  slug: string;
  title: string;
  status: 'draft' | 'published';
  spaceName: string;
  updatedAt: string;
  updatedLabel: string;
  reads30d: number;
  pinned: boolean;
}

export interface WikiHome {
  householdId: string;
  role: Role;
  canWrite: boolean;
  canPublish: boolean;
  spaces: WikiSpaceView[];
  pinned: WikiHomeEntry[];
  recent: WikiHomeEntry[];
}

interface PageRow {
  id: string;
  spaceId: string;
  parentPageId: string | null;
  status: 'draft' | 'published';
  slug: string;
  pinned: boolean;
  position: number;
  updatedAt: Date;
  title: string;
  reads30d: number;
}

/**
 * Portada de la wiki leída de Postgres bajo RLS: es la base de datos quien
 * decide qué ve cada rol (borradores solo para quien escribe; un viewer recibe
 * cero filas). Devuelve null solo sin pool (demo sin DATABASE_URL) o sin
 * membresía autorizada; en ese caso la página cae a la fixture.
 */
export async function loadWikiHome(
  user: { id: string },
  householdId: string,
  pool: Pool | null = getDatabasePool()
): Promise<WikiHome | null> {
  if (!pool) return null;
  try {
    return await withAuthorizedTransaction(pool, { userId: user.id }, householdId, async (client, membership) => {
      const spaces = await client.query<{ id: string; slug: string; name: string; description: string }>(
        `select id, slug, name, description
           from app.wiki_spaces
          where household_id = $1 and archived_at is null
          order by position, name`,
        [householdId]
      );

      const pages = await client.query<PageRow>(
        `select page.id,
                page.space_id as "spaceId",
                page.parent_page_id as "parentPageId",
                page.status::text as "status",
                page.current_slug as "slug",
                page.pinned,
                page.position,
                page.updated_at as "updatedAt",
                coalesce(revision.title, page.current_slug) as "title",
                coalesce(reads.total, 0)::int as "reads30d"
           from app.wiki_pages as page
           left join app.wiki_revisions as revision
             on revision.household_id = page.household_id
            and revision.id = page.current_revision_id
           left join (
                 select page_id, sum(read_count) as total
                   from app.wiki_page_reads
                  where household_id = $1 and read_on >= current_date - 29
                  group by page_id
               ) as reads on reads.page_id = page.id
          where page.household_id = $1 and page.archived_at is null
          order by page.position, "title"`,
        [householdId]
      );

      const nodes = new Map<string, WikiPageNode>();
      for (const row of pages.rows) {
        const updated = isoAndLabel(row.updatedAt);
        nodes.set(row.id, {
          id: row.id,
          slug: row.slug,
          title: row.title,
          status: row.status,
          pinned: row.pinned,
          updatedAt: updated.iso,
          updatedLabel: updated.label,
          reads30d: row.reads30d,
          children: []
        });
      }

      const spaceViews: WikiSpaceView[] = spaces.rows.map((space) => ({
        ...space,
        pages: []
      }));
      const spaceById = new Map(spaceViews.map((space) => [space.id, space]));
      const spaceNameByPage = new Map<string, string>();

      // Jerarquía por parent_page_id; si RLS oculta al padre (p. ej. borrador),
      // el hijo publicado cuelga de la raíz del espacio para no desaparecer.
      for (const row of pages.rows) {
        const node = nodes.get(row.id)!;
        const space = spaceById.get(row.spaceId);
        spaceNameByPage.set(row.id, space?.name ?? '');
        const parent = row.parentPageId ? nodes.get(row.parentPageId) : undefined;
        if (parent) parent.children.push(node);
        else space?.pages.push(node);
      }

      const toEntry = (row: PageRow): WikiHomeEntry => {
        const updated = isoAndLabel(row.updatedAt);
        return {
          id: row.id,
          slug: row.slug,
          title: row.title,
          status: row.status,
          spaceName: spaceNameByPage.get(row.id) ?? '',
          updatedAt: updated.iso,
          updatedLabel: updated.label,
          reads30d: row.reads30d,
          pinned: row.pinned
        };
      };

      const pinned = pages.rows.filter((row) => row.pinned).map(toEntry);
      const recent = [...pages.rows]
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
        .slice(0, 6)
        .map(toEntry);

      return {
        householdId,
        role: membership.role,
        canWrite: WRITER_ROLES.includes(membership.role),
        canPublish: PUBLISHER_ROLES.includes(membership.role),
        spaces: spaceViews,
        pinned,
        recent
      } satisfies WikiHome;
    });
  } catch (cause) {
    if (!(cause instanceof AuthorizationError)) {
      console.error('wiki home unavailable', cause);
    }
    return null;
  }
}

export interface WikiRevisionMeta {
  id: string;
  number: number;
  title: string;
  summary: string;
  author: string;
  createdAt: string;
  createdLabel: string;
}

export interface WikiPageView {
  kind: 'page';
  page: {
    id: string;
    slug: string;
    spaceId: string;
    spaceName: string;
    status: 'draft' | 'published';
    pinned: boolean;
    updatedAt: string;
    updatedLabel: string;
    reads30d: number;
  };
  revision: {
    id: string;
    number: number;
    title: string;
    bodyMarkdown: string;
    summary: string;
    tags: string[];
    aliases: string[];
  };
  revisions: WikiRevisionMeta[];
  /** Diff vigente ↔ anterior (null si solo hay una revisión). */
  diff: WikiDiffLine[] | null;
  diffAgainst: number | null;
  canWrite: boolean;
  canPublish: boolean;
}

export type WikiPageLoad =
  | WikiPageView
  | { kind: 'redirect'; slug: string }
  | { kind: 'not_found' };

/**
 * Carga una página por slug (vigente o histórico, resolviendo en
 * wiki_page_slugs) o por id. Un slug histórico devuelve `redirect` al slug
 * vigente para que ningún enlace interno se rompa. Registra la lectura vía
 * app.record_wiki_read dentro de la misma transacción, solo si la página está
 * publicada (los borradores no cuentan lecturas).
 */
export async function loadWikiPage(
  user: { id: string },
  householdId: string,
  slugOrId: string,
  pool: Pool | null = getDatabasePool()
): Promise<WikiPageLoad | null> {
  if (!pool) return null;
  try {
    return await withAuthorizedTransaction(pool, { userId: user.id }, householdId, async (client, membership) => {
      let pageId: string | null = null;
      if (UUID_PATTERN.test(slugOrId)) {
        pageId = slugOrId;
      } else {
        const slugRow = await client.query<{ pageId: string }>(
          `select page_id as "pageId" from app.wiki_page_slugs
            where household_id = $1 and slug = $2`,
          [householdId, slugOrId.toLowerCase()]
        );
        pageId = slugRow.rows[0]?.pageId ?? null;
      }
      if (!pageId) return { kind: 'not_found' } as const;

      const pageResult = await client.query<{
        id: string;
        slug: string;
        spaceId: string;
        spaceName: string;
        status: 'draft' | 'published';
        pinned: boolean;
        updatedAt: Date;
        currentRevisionId: string | null;
        reads30d: number;
      }>(
        `select page.id,
                page.current_slug as "slug",
                page.space_id as "spaceId",
                space.name as "spaceName",
                page.status::text as "status",
                page.pinned,
                page.updated_at as "updatedAt",
                page.current_revision_id as "currentRevisionId",
                coalesce((
                  select sum(read_count)
                    from app.wiki_page_reads as reads
                   where reads.household_id = page.household_id
                     and reads.page_id = page.id
                     and reads.read_on >= current_date - 29
                ), 0)::int as "reads30d"
           from app.wiki_pages as page
           join app.wiki_spaces as space
             on space.household_id = page.household_id and space.id = page.space_id
          where page.household_id = $1 and page.id = $2 and page.archived_at is null`,
        [householdId, pageId]
      );
      const page = pageResult.rows[0];
      // RLS oculta borradores a quien no escribe: para ese rol la página no existe.
      if (!page || !page.currentRevisionId) return { kind: 'not_found' } as const;
      if (!UUID_PATTERN.test(slugOrId) && page.slug !== slugOrId.toLowerCase()) {
        return { kind: 'redirect', slug: page.slug } as const;
      }

      // El perfil del autor solo es visible para sí mismo o administradores;
      // cualquier otro rol recibe la etiqueta neutra.
      const revisionRows = await client.query<{
        id: string;
        number: number;
        title: string;
        summary: string;
        author: string;
        createdAt: Date;
      }>(
        `select revision.id,
                revision.revision_number as "number",
                revision.title,
                revision.summary,
                coalesce(profile.display_name, 'Alguien de la casa') as "author",
                revision.created_at as "createdAt"
           from app.wiki_revisions as revision
           left join app.household_memberships as membership
             on membership.household_id = revision.household_id
            and membership.id = revision.authored_by_membership_id
           left join app.user_profiles as profile on profile.user_id = membership.user_id
          where revision.household_id = $1 and revision.page_id = $2
          order by revision.revision_number desc`,
        [householdId, pageId]
      );

      const bodies = await client.query<{
        id: string;
        number: number;
        title: string;
        bodyMarkdown: string;
        summary: string;
        tags: string[];
        aliases: string[];
      }>(
        `select id,
                revision_number as "number",
                title,
                body_markdown as "bodyMarkdown",
                summary,
                tags,
                aliases
           from app.wiki_revisions
          where household_id = $1 and page_id = $2
          order by revision_number desc
          limit 2`,
        [householdId, pageId]
      );
      const current = bodies.rows.find((row) => row.id === page.currentRevisionId) ?? bodies.rows[0];
      if (!current) return { kind: 'not_found' } as const;
      const previous = bodies.rows.find((row) => row.number === current.number - 1) ?? null;

      if (page.status === 'published') {
        await client.query('select app.record_wiki_read($1)', [page.id]);
      }

      const updated = isoAndLabel(page.updatedAt);
      return {
        kind: 'page',
        page: {
          id: page.id,
          slug: page.slug,
          spaceId: page.spaceId,
          spaceName: page.spaceName,
          status: page.status,
          pinned: page.pinned,
          updatedAt: updated.iso,
          updatedLabel: updated.label,
          reads30d: page.reads30d
        },
        revision: {
          id: current.id,
          number: current.number,
          title: current.title,
          bodyMarkdown: current.bodyMarkdown,
          summary: current.summary,
          tags: current.tags,
          aliases: current.aliases
        },
        revisions: revisionRows.rows.map((row) => ({
          id: row.id,
          number: row.number,
          title: row.title,
          summary: row.summary,
          author: row.author,
          createdAt: row.createdAt.toISOString(),
          createdLabel: DATE_TIME_LABEL.format(row.createdAt)
        })),
        diff: previous ? diffLines(previous.bodyMarkdown, current.bodyMarkdown) : null,
        diffAgainst: previous?.number ?? null,
        canWrite: WRITER_ROLES.includes(membership.role),
        canPublish: PUBLISHER_ROLES.includes(membership.role)
      } satisfies WikiPageView;
    });
  } catch (cause) {
    if (!(cause instanceof AuthorizationError)) {
      console.error('wiki page unavailable', cause);
    }
    return null;
  }
}

export interface WikiSearchResult {
  id: string;
  slug: string;
  title: string;
  excerpt: string;
  spaceName: string;
  status: 'draft' | 'published';
  score: number;
}

async function recordSearchGap(client: PoolClient, query: string, hadResults: boolean): Promise<void> {
  await client.query('select app.record_search_gap($1, $2)', [query, hadResults]);
}

/**
 * Búsqueda directa en SQL sobre las páginas visibles (RLS decide qué ve cada
 * rol): websearch_to_tsquery en español sobre el search_document sin acentos,
 * más similitud de trigramas (word_similarity) sobre título y aliases para
 * tolerar erratas ('lavadra' → lavadora). Registra el resultado (hueco o
 * búsqueda sin clic) en app.record_search_gap dentro de la misma transacción;
 * `extraResultsFound` permite contar resultados de otros orígenes (contactos)
 * antes de declarar hueco.
 */
export async function searchWikiPages(
  user: { id: string },
  householdId: string,
  rawQuery: string,
  options: { extraResultsFound?: boolean } = {},
  pool: Pool | null = getDatabasePool()
): Promise<WikiSearchResult[] | null> {
  if (!pool) return null;
  const query = rawQuery.trim();
  if (!query) return [];
  try {
    return await withAuthorizedTransaction(pool, { userId: user.id }, householdId, async (client) => {
      const result = await client.query<WikiSearchResult & { score: number }>(
        `select id, slug, title, excerpt, "spaceName", status, greatest(rank, "titleSimilarity", "aliasSimilarity")::float8 as score
           from (
             select page.id,
                    page.current_slug as slug,
                    revision.title,
                    case when revision.summary <> '' then revision.summary
                         else left(revision.body_markdown, 240) end as excerpt,
                    space.name as "spaceName",
                    page.status::text as status,
                    ts_rank(revision.search_document,
                            websearch_to_tsquery('spanish', app.unaccent_es($2)))::float8 as rank,
                    word_similarity(lower(app.unaccent_es($2)), app.unaccent_es(revision.title))::float8 as "titleSimilarity",
                    coalesce((
                      select max(word_similarity(lower(app.unaccent_es($2)), app.unaccent_es(alias)))
                        from unnest(revision.aliases) as alias
                    ), 0)::float8 as "aliasSimilarity"
               from app.wiki_pages as page
               join app.wiki_revisions as revision
                 on revision.household_id = page.household_id
                and revision.id = page.current_revision_id
               join app.wiki_spaces as space
                 on space.household_id = page.household_id and space.id = page.space_id
              where page.household_id = $1 and page.archived_at is null
           ) as candidate
          where rank > 0 or "titleSimilarity" >= 0.4 or "aliasSimilarity" >= 0.4
          order by score desc, title
          limit 12`,
        [householdId, query]
      );
      const hadResults = result.rows.length > 0 || Boolean(options.extraResultsFound);
      await recordSearchGap(client, query, hadResults);
      return result.rows;
    });
  } catch (cause) {
    if (!(cause instanceof AuthorizationError)) {
      console.error('wiki search unavailable', cause);
    }
    return null;
  }
}
