import { createHash } from 'node:crypto';

import type { Pool } from 'pg';
import { strToU8, zipSync } from 'fflate';

import { cadenceClause } from '@housekeeper/domain';
import { AuthorizationError, createLogger, withAuthorizedTransaction } from '@housekeeper/server';

import { CONTACT_KINDS, CONTACT_KIND_LABELS, type ContactKind } from '$lib/contacts/kinds';
import { mondayOf, weekDays, dayLabel } from '$lib/food/dates';
import { unreadable } from './data-source.server';
import { getDatabasePool } from './db.server';
import { routineScheduleFrom, type RoutineScheduleRow } from './routine-rules.server';

const log = createLogger('web:handover');

export type HandoverAudience = 'helper' | 'family';

export const HANDOVER_VERSION = 1;

/**
 * Fuentes permitidas del traspaso operativo (F4-02). El traspaso documenta el
 * funcionamiento de la casa; JAMÁS incluye el expediente laboral (acuerdos,
 * liquidaciones, saldos, gastos o pagos). Esta lista es la verificación
 * defensiva: cualquier entrada del ZIP que no encaje en uno de estos patrones
 * aborta la exportación antes de producir un solo byte.
 */
const ALLOWED_ENTRIES: readonly RegExp[] = [
  /^manifest\.json$/,
  /^wiki\/[a-z0-9]+(?:-[a-z0-9]+)*\/_space\.md$/,
  // Páginas wiki a cualquier profundidad: la jerarquía viaja como carpetas
  // (padre = carpeta con index.md), el formato exacto del importador.
  /^wiki\/[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)+\.md$/,
  /^rutinas\.md$/,
  /^menu-semana\.md$/,
  /^contactos\.md$/
];

function assertAllowedEntry(path: string): void {
  if (!ALLOWED_ENTRIES.some((pattern) => pattern.test(path))) {
    throw new Error(`entrada fuera de las fuentes permitidas del traspaso: ${path}`);
  }
}

const AUDIENCE_LABELS: Record<'family' | 'employee' | 'all', string> = {
  family: 'familia',
  employee: 'empleada',
  all: 'toda la casa'
};

const MEAL_ORDER_LABELS: Record<string, string> = {
  desayuno: 'Desayuno',
  almuerzo: 'Almuerzo',
  comida: 'Comida',
  merienda: 'Merienda',
  cena: 'Cena'
};

/** Escalar YAML seguro: una cadena JSON es una cadena YAML entre comillas. */
function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

function yamlList(values: readonly string[]): string {
  return `[${values.map((value) => yamlScalar(value)).join(', ')}]`;
}

interface WikiExportRow {
  pageId: string;
  parentPageId: string | null;
  spaceSlug: string;
  spaceName: string;
  spaceDescription: string;
  slug: string;
  title: string;
  bodyMarkdown: string;
  tags: string[];
  aliases: string[];
}

/**
 * Rutas del árbol wiki en el formato EXACTO del importador
 * (packages/db/scripts/wiki-import.mjs): una página con hijas se convierte en
 * carpeta `<slug>/` con su contenido en `index.md`, y las hijas cuelgan dentro
 * (a cualquier profundidad); una hoja es `<slug>.md`. El slug del front-matter
 * manda sobre el nombre de fichero, así que el `index.md` conserva su slug
 * real. Una página cuyo ancestro no se exporta (borrador/archivado) se ancla a
 * su ancestro exportado más cercano o a la raíz del espacio.
 */
function buildWikiPaths(rows: readonly WikiExportRow[]): Map<string, string> {
  const rowById = new Map(rows.map((row) => [row.pageId, row]));
  const parents = new Set(
    rows
      .map((row) => row.parentPageId)
      .filter((id): id is string => id !== null && rowById.has(id))
  );
  const paths = new Map<string, string>();
  for (const row of rows) {
    const segments: string[] = [];
    const visited = new Set<string>([row.pageId]);
    let ancestor = row.parentPageId ? rowById.get(row.parentPageId) : undefined;
    while (ancestor && !visited.has(ancestor.pageId)) {
      visited.add(ancestor.pageId);
      segments.unshift(ancestor.slug);
      ancestor = ancestor.parentPageId ? rowById.get(ancestor.parentPageId) : undefined;
    }
    const dir = [`wiki/${row.spaceSlug}`, ...segments].join('/');
    paths.set(
      row.pageId,
      parents.has(row.pageId) ? `${dir}/${row.slug}/index.md` : `${dir}/${row.slug}.md`
    );
  }
  return paths;
}

/**
 * Página wiki como Markdown con front-matter compatible con el importador:
 * claves title/slug/tags/aliases; el espacio viaja en la ruta `wiki/<espacio>/`
 * y en el `_space.md` de la carpeta, y la jerarquía padre→hija en la estructura
 * de carpetas (round-trip sin pérdidas).
 */
function renderWikiPage(row: WikiExportRow): string {
  const lines = ['---', `title: ${yamlScalar(row.title)}`, `slug: ${yamlScalar(row.slug)}`];
  if (row.tags.length > 0) lines.push(`tags: ${yamlList(row.tags)}`);
  if (row.aliases.length > 0) lines.push(`aliases: ${yamlList(row.aliases)}`);
  lines.push('---', '');
  // Una sola nueva línea final: así un export→import→export repetido es
  // estable (el hash de contenido del importador no cambia entre ciclos).
  const body = row.bodyMarkdown.endsWith('\n') ? row.bodyMarkdown : `${row.bodyMarkdown}\n`;
  return `${lines.join('\n')}${body}`;
}

function renderSpaceFile(name: string, description: string): string {
  const lines = ['---', `name: ${yamlScalar(name)}`];
  if (description) lines.push(`description: ${yamlScalar(description)}`);
  lines.push('---', '');
  return lines.join('\n');
}

interface RoutineExportRow extends RoutineScheduleRow {
  title: string;
  details: string;
  audience: 'family' | 'employee' | 'all';
  nextDueHint: string | null;
}

/**
 * La cadencia se dice con la frase del motor puro, no con las columnas
 * heredadas. Hasta la 0033 esto leía `frequency`/`interval_count` y escribía
 * «frecuencia: Semanal (cada 2)»; eran columnas SOMBRA que mentían en cuanto la
 * cadencia no cabía en aquel vocabulario de cuatro palabras —«cada 15 días» se
 * leía como «Diaria (cada 12)»— y un documento de traspaso es justo donde una
 * frecuencia falsa hace más daño: alguien la lee y organiza su semana con ella.
 *
 * Una rutina sin cadencia confirmada se exporta igualmente, diciendo que no
 * tiene día: existe, se hace, y quien recibe el traspaso debe saberlo.
 */
function renderRoutines(rows: RoutineExportRow[], audience: HandoverAudience): string {
  const lines = ['# Rutinas de la casa', ''];
  if (audience === 'helper') {
    lines.push('> Traspaso para persona de apoyo: solo las rutinas de toda la casa.', '');
  }
  if (rows.length === 0) {
    lines.push('No hay rutinas activas.');
  }
  for (const row of rows) {
    const cadence = cadenceClause(routineScheduleFrom(row));
    const next = row.nextDueHint ? ` · próxima: ${row.nextDueHint}` : '';
    lines.push(
      `- **${row.title}** — audiencia: ${AUDIENCE_LABELS[row.audience]} · cadencia: ${cadence}${next}`
    );
    if (row.details) lines.push(`  - ${row.details}`);
  }
  return `${lines.join('\n')}\n`;
}

interface MenuExportRow {
  onDate: string;
  meal: string;
  groupName: string;
  recipeTitle: string | null;
  freeText: string;
  notes: string;
}

function renderMenuWeek(rows: MenuExportRow[], days: string[]): string {
  const lines = [`# Menú de la semana (${days[0]} → ${days[6]})`, ''];
  for (const day of days) {
    const label = dayLabel(day);
    lines.push(`## ${label.day} ${label.date} (${day})`, '');
    const dayRows = rows.filter((row) => row.onDate === day);
    if (dayRows.length === 0) {
      lines.push('Sin menú planificado.', '');
      continue;
    }
    for (const row of dayRows) {
      const dish = row.recipeTitle ?? row.freeText;
      const note = row.notes ? ` — ${row.notes}` : '';
      lines.push(`- ${MEAL_ORDER_LABELS[row.meal] ?? row.meal} · ${row.groupName}: ${dish}${note}`);
    }
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

interface ContactExportRow {
  name: string;
  roleLabel: string;
  phone: string;
  kind: ContactKind;
}

/**
 * Contactos de la casa, los REALES, leídos bajo RLS en la misma transacción
 * que el resto del traspaso.
 *
 * Antes salían de la maqueta compartida, siempre, también con un hogar real
 * detrás: el ZIP que se entrega a quien va a llevar la casa mezclaba la guía y
 * las rutinas verdaderas con seis teléfonos inventados, sin ninguna marca
 * (auditoría §R8). Una casa sin contactos guardados lo dice; no los rellena.
 */
function renderContacts(rows: ContactExportRow[]): string {
  const lines = ['# Contactos de la casa', ''];
  if (rows.length === 0) {
    lines.push('_Esta casa todavía no tiene contactos guardados._');
  }
  for (const contact of rows) {
    lines.push(`- **${contact.name}** — ${contact.roleLabel || CONTACT_KIND_LABELS[contact.kind]} · ${contact.phone}`);
  }
  return `${lines.join('\n')}\n`;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Traspaso operativo del hogar (F4-02) como ZIP determinista y verificable.
 *
 * SOLO family_admin puede invocarlo: cualquier otro rol (o membresía
 * inexistente) recibe null. La lectura corre bajo la sesión RLS del propio
 * administrador; el contenido se limita a las fuentes operativas permitidas
 * (wiki publicada, rutinas, menú de la semana y contactos) y nunca toca el
 * expediente laboral.
 *
 * Determinismo (patrón buildEmployeeExport del worker): entradas ordenadas por
 * nombre, mtime fijo 1980-01-01 y `generatedAt` inyectable; dos builds con el
 * mismo instante producen bytes idénticos. El manifest lista cada fichero con
 * su sha-256 y un hash global del conjunto para verificar el paquete entero.
 */
export async function buildHandoverExport(
  user: { id: string },
  householdId: string,
  audience: HandoverAudience,
  pool: Pool | null = getDatabasePool(),
  generatedAt: Date = new Date()
): Promise<Uint8Array | null> {
  if (!pool) return null;
  try {
    return await withAuthorizedTransaction(pool, { userId: user.id }, householdId, async (client, membership) => {
      if (membership.role !== 'family_admin') {
        throw new AuthorizationError('El traspaso solo puede generarlo la administración del hogar');
      }

      const household = await client.query<{ name: string }>(
        'select display_name as "name" from app.households where id = $1',
        [householdId]
      );
      const householdName = household.rows[0]?.name ?? 'Hogar';

      const wikiResult = await client.query<WikiExportRow>(
        `select page.id as "pageId",
                page.parent_page_id as "parentPageId",
                space.slug as "spaceSlug",
                space.name as "spaceName",
                space.description as "spaceDescription",
                page.current_slug as "slug",
                revision.title,
                revision.body_markdown as "bodyMarkdown",
                revision.tags,
                revision.aliases
           from app.wiki_pages as page
           join app.wiki_spaces as space
             on space.household_id = page.household_id and space.id = page.space_id
           join app.wiki_revisions as revision
             on revision.household_id = page.household_id and revision.id = page.current_revision_id
          where page.household_id = $1
            and page.status = 'published'
            and page.archived_at is null
            and space.archived_at is null
          order by space.slug, page.current_slug`,
        [householdId]
      );

      const routineResult = await client.query<RoutineExportRow>(
        `select title,
                details,
                audience::text as "audience",
                next_due_hint::text as "nextDueHint",
                pattern::text as "pattern",
                anchor_on::text as "anchorOn",
                repeat_every as "repeatEvery",
                weekdays::int[] as "weekdays",
                month_day::int as "monthDay",
                months::int[] as "months",
                ends_on::text as "endsOn"
           from app.routines
          where household_id = $1 and archived_at is null
          order by next_due_hint nulls last, title`,
        [householdId]
      );
      // La persona de apoyo solo recibe las rutinas de toda la casa (mismo
      // recorte que aplica RLS al rol helper); la familia las recibe todas.
      const routines =
        audience === 'helper'
          ? routineResult.rows.filter((row) => row.audience === 'all')
          : routineResult.rows;

      const days = weekDays(mondayOf(generatedAt.toISOString().slice(0, 10)));
      const menuResult = await client.query<MenuExportRow>(
        `select slot.on_date::text as "onDate",
                slot.meal::text as "meal",
                grp.name as "groupName",
                revision.title as "recipeTitle",
                slot.free_text as "freeText",
                slot.notes
           from app.menu_slots as slot
           join app.menu_groups as grp
             on grp.household_id = slot.household_id and grp.id = slot.group_id
           left join app.wiki_pages as page
             on page.household_id = slot.household_id and page.id = slot.recipe_page_id
           left join app.wiki_revisions as revision
             on revision.household_id = page.household_id and revision.id = page.current_revision_id
          where slot.household_id = $1 and slot.on_date between $2 and $3
          order by slot.on_date, slot.meal, grp.name`,
        [householdId, days[0], days[6]]
      );

      // Mismo orden y mismo recorte que el directorio de la aplicación: los
      // archivados no viajan.
      const contactResult = await client.query<ContactExportRow>(
        `select name, role_label as "roleLabel", phone, kind
           from app.contacts
          where household_id = $1 and archived_at is null
          order by array_position($2::text[], kind), position, name`,
        [householdId, CONTACT_KINDS]
      );

      const files = new Map<string, Uint8Array>();
      const put = (path: string, content: string): void => {
        assertAllowedEntry(path);
        files.set(path, strToU8(content));
      };

      const seenSpaces = new Set<string>();
      const wikiPaths = buildWikiPaths(wikiResult.rows);
      for (const row of wikiResult.rows) {
        if (!seenSpaces.has(row.spaceSlug)) {
          seenSpaces.add(row.spaceSlug);
          put(`wiki/${row.spaceSlug}/_space.md`, renderSpaceFile(row.spaceName, row.spaceDescription));
        }
        put(wikiPaths.get(row.pageId)!, renderWikiPage(row));
      }
      put('rutinas.md', renderRoutines(routines, audience));
      put('menu-semana.md', renderMenuWeek(menuResult.rows, days));
      put('contactos.md', renderContacts(contactResult.rows));

      const sortedPaths = [...files.keys()].sort((left, right) => left.localeCompare(right, 'en'));
      const fileHashes = sortedPaths.map((path) => ({ path, sha256: sha256(files.get(path)!) }));
      const filesHash = sha256(strToU8(fileHashes.map((file) => `${file.path}\n${file.sha256}\n`).join('')));

      const manifest = {
        version: HANDOVER_VERSION,
        household: { name: householdName },
        audience,
        generatedAt: generatedAt.toISOString(),
        files: fileHashes,
        filesHash
      };
      put('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);

      const entries: Record<string, Uint8Array> = {};
      for (const path of [...files.keys()].sort((left, right) => left.localeCompare(right, 'en'))) {
        entries[path] = files.get(path)!;
      }
      return zipSync(entries, { level: 6, mtime: new Date('1980-01-01T00:00:00.000Z') });
    });
  } catch (cause) {
    return unreadable(log, 'handover export', cause);
  }
}

/**
 * Puerta de la interfaz: true solo si la membresía RLS del usuario en este
 * hogar es family_admin con base de datos real (sin pool → false y la página
 * no ofrece la descarga).
 */
export async function canDownloadHandover(
  user: { id: string },
  householdId: string,
  pool: Pool | null = getDatabasePool()
): Promise<boolean> {
  if (!pool) return false;
  try {
    return await withAuthorizedTransaction(
      pool,
      { userId: user.id },
      householdId,
      async (_client, membership) => membership.role === 'family_admin'
    );
  } catch (cause) {
    unreadable(log, 'handover gate', cause);
    return false;
  }
}
