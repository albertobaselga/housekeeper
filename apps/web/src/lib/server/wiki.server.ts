import type { Pool, PoolClient } from 'pg';

import { hasCapability, type Role } from '@casa-clara/contracts';
import { AuthorizationError, createLogger, errorCode, listSearchGapClusters, withAuthorizedTransaction } from '@casa-clara/server';

import { diffLines, type WikiDiffLine } from '$lib/wiki/diff';
import { getDatabasePool } from './db.server';

const log = createLogger('web:wiki');

/**
 * Escribir la Guía de la casa es de la administración y de nadie más. Un botón
 * que siempre falla es una mentira, así que la interfaz no lo dibuja; la RLS de
 * la migración 0026 lo impone igualmente por debajo.
 */
function canWriteGuide(role: Role): boolean {
  return hasCapability(role, 'guide.write');
}

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

/**
 * Las versiones importadas antes de la migración 0017 llevan la marca técnica
 * del importador («import:63b79e8c247a») en el resumen, y el resumen se pinta
 * como subtítulo de la nota. La migración la retira de la base; este filtro
 * garantiza que jamás llegue a la pantalla aunque se lea una base sin migrar.
 */
const IMPORT_MARKER = /^import:[0-9a-f]{12}$/;
function shownSummary(value: string): string {
  return IMPORT_MARKER.test(value.trim()) ? '' : value;
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
  isTemplate: boolean;
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

export interface WikiSearchGapView {
  representative: string;
  variants: string[];
  missTotal: number;
  noClickTotal: number;
  lastSeenOn: string;
  lastSeenLabel: string;
}

export interface WikiHome {
  householdId: string;
  role: Role;
  canWrite: boolean;
  spaces: WikiSpaceView[];
  /** Espacios marcados como plantilla, listados aparte de los espacios vivos. */
  templates: WikiSpaceView[];
  pinned: WikiHomeEntry[];
  recent: WikiHomeEntry[];
  /**
   * Huecos documentales (AC-18), solo para quien mantiene la Guía: clusters
   * deterministas de búsquedas sin resultado o sin clic de los últimos 30 días.
   */
  searchGaps: WikiSearchGapView[];
  /** Lo que le queda por leer a QUIEN MIRA. Nunca lo de otra persona. */
  reading: GuideReadingSummary;
}

/**
 * Estado de lectura de una nota para quien mira. `changed` no es «no leída»:
 * es «la leíste, y desde entonces cambiaron las palabras». La diferencia
 * importa porque decirle a alguien que nunca leyó algo que sí leyó es mentir.
 */
export type GuideNoteReadState = 'pending' | 'read' | 'changed';

export interface GuideNoteEntry {
  id: string;
  slug: string;
  title: string;
  /** Índice global dentro del libro, empezando en 1. */
  order: number;
  /** Profundidad en la jerarquía del apartado (0 = nota de primer nivel). */
  depth: number;
  state: GuideNoteReadState;
}

export interface GuideChapter {
  id: string;
  slug: string;
  name: string;
  description: string;
  notes: GuideNoteEntry[];
  total: number;
  read: number;
}

export interface GuideReadingSummary {
  total: number;
  read: number;
  /** Leídas cuyo texto ha cambiado desde entonces. */
  changed: number;
  complete: boolean;
  /** Por dónde seguir: la primera pendiente, o la primera que cambió. */
  nextSlug: string | null;
  nextTitle: string | null;
}

export interface GuideOutline {
  householdId: string;
  chapters: GuideChapter[];
  /** El libro entero en orden de lectura, capítulo a capítulo. */
  order: GuideNoteEntry[];
  summary: GuideReadingSummary;
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

interface OutlineRow {
  spaceId: string;
  spaceSlug: string;
  spaceName: string;
  spaceDescription: string;
  pageId: string;
  parentPageId: string | null;
  slug: string;
  title: string;
  readFingerprint: string | null;
  currentFingerprint: string;
}

/**
 * El libro entero tal y como se lee: capítulos en el orden que la casa les ha
 * dado y, dentro de cada uno, las notas de padres a hijas. Solo notas
 * PUBLICADAS de apartados de la GUÍA — un borrador no se puede pedir que se
 * lea, y el recetario no es el manual de la casa.
 *
 * El estado de lectura sale de `app.wiki_reading_progress`, que bajo RLS solo
 * devuelve las filas de quien pregunta: esta consulta no puede leer el
 * progreso de otra persona ni queriendo.
 */
async function loadGuideOutlineWith(
  client: PoolClient,
  householdId: string
): Promise<GuideOutline> {
  const rows = await client.query<OutlineRow>(
    `select space.id as "spaceId",
            space.slug as "spaceSlug",
            space.name as "spaceName",
            space.description as "spaceDescription",
            page.id as "pageId",
            page.parent_page_id as "parentPageId",
            page.current_slug as "slug",
            revision.title,
            progress.content_fingerprint as "readFingerprint",
            revision.reading_fingerprint as "currentFingerprint"
       from app.wiki_spaces as space
       join app.wiki_pages as page
         on page.household_id = space.household_id
        and page.space_id = space.id
        and page.archived_at is null
        and page.status = 'published'
       join app.wiki_revisions as revision
         on revision.household_id = page.household_id
        and revision.id = page.current_revision_id
       left join app.wiki_reading_progress as progress
         on progress.household_id = page.household_id
        and progress.page_id = page.id
      where space.household_id = $1
        and space.archived_at is null
        and space.kind = 'guide'
        and space.is_template = false
      order by space.position, space.name, page.position, revision.title`,
    [householdId]
  );

  const chapters: GuideChapter[] = [];
  const byChapter = new Map<string, GuideChapter>();
  const rowsByChapter = new Map<string, OutlineRow[]>();
  for (const row of rows.rows) {
    let chapter = byChapter.get(row.spaceId);
    if (!chapter) {
      chapter = {
        id: row.spaceId,
        slug: row.spaceSlug,
        name: row.spaceName,
        description: row.spaceDescription,
        notes: [],
        total: 0,
        read: 0
      };
      byChapter.set(row.spaceId, chapter);
      chapters.push(chapter);
      rowsByChapter.set(row.spaceId, []);
    }
    rowsByChapter.get(row.spaceId)!.push(row);
  }

  const order: GuideNoteEntry[] = [];
  for (const chapter of chapters) {
    const chapterRows = rowsByChapter.get(chapter.id) ?? [];
    const visible = new Set(chapterRows.map((row) => row.pageId));
    const children = new Map<string | null, OutlineRow[]>();
    for (const row of chapterRows) {
      // Si el padre no está publicado (o vive en otro apartado), la hija cuelga
      // de la raíz: nunca desaparece del libro por culpa de su padre.
      const parent = row.parentPageId && visible.has(row.parentPageId) ? row.parentPageId : null;
      const siblings = children.get(parent) ?? [];
      siblings.push(row);
      children.set(parent, siblings);
    }
    const walk = (parent: string | null, depth: number): void => {
      for (const row of children.get(parent) ?? []) {
        const state: GuideNoteReadState =
          row.readFingerprint === null
            ? 'pending'
            : row.readFingerprint === row.currentFingerprint
              ? 'read'
              : 'changed';
        const entry: GuideNoteEntry = {
          id: row.pageId,
          slug: row.slug,
          title: row.title,
          order: order.length + 1,
          depth,
          state
        };
        order.push(entry);
        chapter.notes.push(entry);
        chapter.total += 1;
        if (state !== 'pending') chapter.read += 1;
        walk(row.pageId, depth + 1);
      }
    };
    walk(null, 0);
  }

  const read = order.filter((note) => note.state !== 'pending').length;
  const changed = order.filter((note) => note.state === 'changed').length;
  const next = order.find((note) => note.state === 'pending') ?? order.find((note) => note.state === 'changed') ?? null;
  return {
    householdId,
    chapters,
    order,
    summary: {
      total: order.length,
      read,
      changed,
      complete: order.length > 0 && read === order.length,
      nextSlug: next?.slug ?? null,
      nextTitle: next?.title ?? null
    }
  };
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
      // Solo la GUÍA: el recetario tiene su propia pantalla y no es el manual
      // de la casa (migración 0026).
      const spaces = await client.query<{
        id: string;
        slug: string;
        name: string;
        description: string;
        isTemplate: boolean;
      }>(
        `select id, slug, name, description, is_template as "isTemplate"
           from app.wiki_spaces
          where household_id = $1 and archived_at is null and kind = 'guide'
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
           join app.wiki_spaces as space
             on space.household_id = page.household_id
            and space.id = page.space_id
            and space.kind = 'guide'
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

      // Las páginas de una plantilla no compiten en portada: solo cuentan las
      // de espacios vivos (fijadas y actividad reciente).
      const templateSpaceIds = new Set(
        spaces.rows.filter((space) => space.isTemplate).map((space) => space.id)
      );
      const liveRows = pages.rows.filter((row) => !templateSpaceIds.has(row.spaceId));
      const pinned = liveRows.filter((row) => row.pinned).map(toEntry);
      const recent = [...liveRows]
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
        .slice(0, 6)
        .map(toEntry);

      const canWrite = canWriteGuide(membership.role);

      // Huecos documentales: son la lista de tareas de quien mantiene la Guía,
      // así que solo se consultan para quien puede escribirla.
      const searchGaps: WikiSearchGapView[] = canWrite
        ? (await listSearchGapClusters(client, { days: 30, limit: 10 })).map((cluster) => ({
            representative: cluster.representative,
            variants: cluster.variants,
            missTotal: cluster.missTotal,
            noClickTotal: cluster.noClickTotal,
            lastSeenOn: cluster.lastSeenOn,
            lastSeenLabel: DATE_LABEL.format(new Date(`${cluster.lastSeenOn}T00:00:00Z`))
          }))
        : [];

      // Lo que le queda por leer a quien mira, nunca a otra persona: RLS solo
      // devuelve su propio progreso.
      const outline = await loadGuideOutlineWith(client, householdId);

      return {
        householdId,
        role: membership.role,
        canWrite,
        // Las plantillas se listan aparte: no son espacios "vivos" de lectura
        // sino orígenes de clonación (F4-01).
        spaces: spaceViews.filter((space) => !space.isTemplate),
        templates: spaceViews.filter((space) => space.isTemplate),
        pinned,
        recent,
        searchGaps,
        reading: outline.summary
      } satisfies WikiHome;
    });
  } catch (cause) {
    if (!(cause instanceof AuthorizationError)) {
      log.error('wiki home unavailable', { code: errorCode(cause) });
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
  /**
   * Estado de lectura de ESTA nota para quien mira, y si cuenta para la
   * acogida (una receta o un borrador no cuentan). `null` cuando la nota no
   * pertenece a la Guía.
   */
  reading: { state: GuideNoteReadState; counts: boolean } | null;
  /** Nota anterior y siguiente en el libro, para poder seguir leyendo. */
  neighbours: { previous: GuideNoteEntry | null; next: GuideNoteEntry | null };
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

      // El libro sirve también a la consulta suelta: una nota abierta desde la
      // búsqueda enseña por dónde iba y a dónde seguir, sin obligar a entrar
      // por el modo libro.
      const outline = await loadGuideOutlineWith(client, householdId);
      const position = outline.order.findIndex((note) => note.id === page.id);
      const reading = {
        state:
          position >= 0
            ? { state: outline.order[position]!.state, counts: true }
            : null,
        neighbours: {
          previous: position > 0 ? outline.order[position - 1]! : null,
          next: position >= 0 && position < outline.order.length - 1 ? outline.order[position + 1]! : null
        }
      };

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
          summary: shownSummary(current.summary),
          tags: current.tags,
          aliases: current.aliases
        },
        revisions: revisionRows.rows.map((row) => ({
          id: row.id,
          number: row.number,
          title: row.title,
          summary: shownSummary(row.summary),
          author: row.author,
          createdAt: row.createdAt.toISOString(),
          createdLabel: DATE_TIME_LABEL.format(row.createdAt)
        })),
        diff: previous ? diffLines(previous.bodyMarkdown, current.bodyMarkdown) : null,
        diffAgainst: previous?.number ?? null,
        canWrite: canWriteGuide(membership.role),
        reading: reading.state,
        neighbours: reading.neighbours
      } satisfies WikiPageView;
    });
  } catch (cause) {
    if (!(cause instanceof AuthorizationError)) {
      log.error('wiki page unavailable', { code: errorCode(cause) });
    }
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Modo libro y progreso de lectura
// ─────────────────────────────────────────────────────────────────────────────

export interface GuideBookPage {
  outline: GuideOutline;
  /** La nota abierta, con su cuerpo Markdown y su sitio en el libro. */
  note: {
    id: string;
    slug: string;
    title: string;
    bodyMarkdown: string;
    chapterName: string;
    chapterSlug: string;
    order: number;
    state: GuideNoteReadState;
  };
  previous: GuideNoteEntry | null;
  next: GuideNoteEntry | null;
}

export type GuideBookLoad =
  | { kind: 'book'; book: GuideBookPage }
  | { kind: 'redirect'; slug: string }
  | { kind: 'empty'; outline: GuideOutline }
  | { kind: 'not_found' };

/**
 * Índice del libro y, si se pide una nota, su contenido. Sin `slug` devuelve
 * un `redirect` a por dónde toca seguir (la primera pendiente, o la primera del
 * libro si ya está entera leída): el modo libro se entra por su portada y nunca
 * deja a nadie en una pantalla en blanco.
 */
export async function loadGuideBook(
  user: { id: string },
  householdId: string,
  slug: string | null,
  pool: Pool | null = getDatabasePool()
): Promise<GuideBookLoad | null> {
  if (!pool) return null;
  try {
    return await withAuthorizedTransaction(pool, { userId: user.id }, householdId, async (client) => {
      const outline = await loadGuideOutlineWith(client, householdId);
      if (outline.order.length === 0) return { kind: 'empty', outline } as const;

      if (slug === null) {
        const target = outline.summary.nextSlug ?? outline.order[0]!.slug;
        return { kind: 'redirect', slug: target } as const;
      }

      const normalized = slug.toLowerCase();
      const position = outline.order.findIndex((note) => note.slug === normalized);
      if (position < 0) {
        // Puede ser un slug histórico: se resuelve como en la vista de nota.
        const resolved = await client.query<{ slug: string }>(
          `select page.current_slug as slug
             from app.wiki_page_slugs as historic
             join app.wiki_pages as page
               on page.household_id = historic.household_id and page.id = historic.page_id
            where historic.household_id = $1 and historic.slug = $2`,
          [householdId, normalized]
        );
        const current = resolved.rows[0]?.slug;
        if (current && outline.order.some((note) => note.slug === current)) {
          return { kind: 'redirect', slug: current } as const;
        }
        return { kind: 'not_found' } as const;
      }

      const entry = outline.order[position]!;
      const chapter = outline.chapters.find((candidate) =>
        candidate.notes.some((note) => note.id === entry.id)
      )!;

      const body = await client.query<{ bodyMarkdown: string }>(
        `select revision.body_markdown as "bodyMarkdown"
           from app.wiki_pages as page
           join app.wiki_revisions as revision
             on revision.household_id = page.household_id and revision.id = page.current_revision_id
          where page.household_id = $1 and page.id = $2`,
        [householdId, entry.id]
      );
      if (!body.rows[0]) return { kind: 'not_found' } as const;

      // La lectura anónima agregada (0007) también cuenta aquí: el modo libro
      // no deja de ser gente leyendo la Guía.
      await client.query('select app.record_wiki_read($1)', [entry.id]);

      return {
        kind: 'book',
        book: {
          outline,
          note: {
            id: entry.id,
            slug: entry.slug,
            title: entry.title,
            bodyMarkdown: body.rows[0].bodyMarkdown,
            chapterName: chapter.name,
            chapterSlug: chapter.slug,
            order: entry.order,
            state: entry.state
          },
          previous: position > 0 ? outline.order[position - 1]! : null,
          next: position < outline.order.length - 1 ? outline.order[position + 1]! : null
        }
      } as const;
    });
  } catch (cause) {
    if (!(cause instanceof AuthorizationError)) {
      log.error('guide book unavailable', { code: errorCode(cause) });
    }
    return null;
  }
}

/**
 * Marca una nota como leída PARA QUIEN LLAMA. La función de la base no acepta
 * membresía, así que aquí tampoco hay forma de marcar por otro. Devuelve
 * `false` cuando la nota no cuenta para la acogida (borrador o receta), para
 * que la interfaz no diga que ha apuntado algo que no ha apuntado.
 */
export async function markGuideNoteRead(
  user: { id: string },
  householdId: string,
  pageId: string,
  pool: Pool | null = getDatabasePool()
): Promise<boolean | null> {
  if (!pool) return null;
  try {
    return await withAuthorizedTransaction(pool, { userId: user.id }, householdId, async (client) => {
      const marked = await client.query<{ fingerprint: string | null }>(
        'select app.mark_wiki_note_read($1) as fingerprint',
        [pageId]
      );
      return marked.rows[0]?.fingerprint !== null;
    });
  } catch (cause) {
    if (!(cause instanceof AuthorizationError)) {
      log.error('guide read not recorded', { code: errorCode(cause) });
    }
    return null;
  }
}

export interface GuideOverviewChapter {
  spaceId: string;
  name: string;
  total: number;
  read: number;
}

export interface GuideOverviewPerson {
  membershipId: string;
  name: string;
  roleLabel: string;
  total: number;
  read: number;
  complete: boolean;
  chapters: GuideOverviewChapter[];
}

export interface GuideProgressView {
  householdId: string;
  canWrite: boolean;
  /** Lo propio: siempre, para todo el mundo. */
  outline: GuideOutline;
  /**
   * Avance de la casa, solo para quien administra. Son CUENTAS por apartado:
   * ni qué nota abrió cada cual ni cuándo, porque la base no lo guarda.
   */
  household: GuideOverviewPerson[] | null;
}

const ROLE_LABELS: Readonly<Record<string, string>> = {
  family_admin: 'Administración',
  family_member: 'Familia',
  employee_live_in: 'Interna',
  helper: 'Apoyo',
  viewer: 'Acceso puntual'
};

export async function loadGuideProgress(
  user: { id: string },
  householdId: string,
  pool: Pool | null = getDatabasePool()
): Promise<GuideProgressView | null> {
  if (!pool) return null;
  try {
    return await withAuthorizedTransaction(pool, { userId: user.id }, householdId, async (client, membership) => {
      const outline = await loadGuideOutlineWith(client, householdId);
      const canWrite = canWriteGuide(membership.role);
      if (!canWrite) {
        return { householdId, canWrite, outline, household: null } satisfies GuideProgressView;
      }

      const rows = await client.query<{
        membershipId: string;
        displayName: string;
        membershipRole: string;
        spaceId: string;
        spaceName: string;
        notesTotal: string;
        notesRead: string;
      }>(
        `select membership_id as "membershipId",
                display_name as "displayName",
                membership_role::text as "membershipRole",
                space_id as "spaceId",
                space_name as "spaceName",
                notes_total as "notesTotal",
                notes_read as "notesRead"
           from app.wiki_reading_overview()
          order by display_name, space_position, space_name`
      );

      const people = new Map<string, GuideOverviewPerson>();
      for (const row of rows.rows) {
        let person = people.get(row.membershipId);
        if (!person) {
          person = {
            membershipId: row.membershipId,
            name: row.displayName,
            roleLabel: ROLE_LABELS[row.membershipRole] ?? row.membershipRole,
            total: 0,
            read: 0,
            complete: false,
            chapters: []
          };
          people.set(row.membershipId, person);
        }
        const total = Number(row.notesTotal);
        const read = Number(row.notesRead);
        person.chapters.push({ spaceId: row.spaceId, name: row.spaceName, total, read });
        person.total += total;
        person.read += read;
      }
      const household = [...people.values()].map((person) => ({
        ...person,
        complete: person.total > 0 && person.read === person.total
      }));

      return { householdId, canWrite, outline, household } satisfies GuideProgressView;
    });
  } catch (cause) {
    if (!(cause instanceof AuthorizationError)) {
      log.error('guide progress unavailable', { code: errorCode(cause) });
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
                    case when revision.summary <> ''
                          and revision.summary !~ '^import:[0-9a-f]{12}$'
                         then revision.summary
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
      log.error('wiki search unavailable', { code: errorCode(cause) });
    }
    return null;
  }
}
