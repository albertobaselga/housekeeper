// Importador por lotes de un corpus Markdown a la wiki (AC-14, ensayo reversible).
//
// Uso:
//   DATABASE_URL=postgresql://... node scripts/wiki-import.mjs \
//     --household <uuid> --membership <uuid> --dir <carpeta> [--dry-run]
//
// Estructura del corpus:
//   <dir>/<espacio>/           cada subcarpeta de primer nivel es un espacio;
//                              nombre desde la carpeta o su `_space.md`
//                              (front-matter: name, description).
//   <espacio>/pagina.md        cada .md es una página (slug = nombre de fichero
//                              o `slug` del front-matter).
//   <espacio>/carpeta/index.md la carpeta se convierte en jerarquía: index.md
//                              es la página padre y el resto de la carpeta
//                              cuelga de ella (parent_page_id).
//
// Front-matter YAML mínimo (parseado a mano, sin dependencias):
//   title (obligatorio), slug?, tags? (lista), aliases? (lista),
//   status? (draft|published; por defecto published),
//   pinned? (true|false; fijada en la portada de la Guía).
// El `_space.md` admite además `position` (orden del apartado en portada).
//
// Enlaces internos relativos `[texto](./otra.md)` se reescriben a
// `[texto](wiki:slug)` para que sobrevivan a renombrados (slug histórico).
//
// El resumen de cada revisión se rellena con la primera frase útil de la nota:
// es lo que la vista pinta como subtítulo, así que tiene que leerse como
// castellano y no como jerga.
//
// Idempotencia: sha-256 del contenido canónico (título+cuerpo+tags+aliases+
// resumen); el hash recortado a doce caracteres viaja en la columna propia
// `import_hash`, que ninguna vista lee. Una página cuyo contenido vigente da el
// mismo hash se omite; si difiere gana una revisión nueva (número consecutivo,
// validado por el trigger append-only).
//
// Lote reversible: TODO corre en una única transacción con
// `set local row_security = off` (patrón del propietario de migraciones);
// cualquier error → rollback completo señalando el fichero culpable. El modo
// --dry-run ejecuta el mismo lote y hace ROLLBACK al final: informa exactamente
// qué crearía/actualizaría/omitiría sin persistir nada.

import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

import matter from 'gray-matter';
import pg from 'pg';

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// Las dos vistas propias de la Guía (`/wiki/libro`, `/wiki/progreso`) cuelgan
// de la misma ruta que las notas: una nota con esos slugs quedaría inalcanzable
// para siempre. La base lo impide con un CHECK; aquí se dice antes y mejor.
const RESERVED_SLUGS = new Set(['libro', 'progreso']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_KEYS = new Set(['title', 'slug', 'tags', 'aliases', 'status', 'pinned']);
const SPACE_KEYS = new Set(['name', 'description', 'position']);

export function slugify(value) {
  const slug = value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!SLUG_RE.test(slug)) {
    throw new Error(`no se puede derivar un slug válido de «${value}»`);
  }
  return slug;
}

export function contentHash({ title, body, tags, aliases, summary }) {
  return createHash('sha256')
    .update(JSON.stringify({ title, body, tags, aliases, summary: summary ?? '' }))
    .digest('hex');
}

/** Longitud máxima del subtítulo: una frase, no un párrafo. */
const SUMMARY_MAX = 180;

/**
 * Primera frase útil de la nota, para el subtítulo que se enseña bajo el
 * título. Se salta lo que no es prosa (encabezados, separadores, código,
 * tablas, listas) y limpia el marcado ligero: comillas de cita, énfasis y
 * enlaces se quedan con su texto. Si la nota no empieza por prosa (las fichas
 * de datos pendientes arrancan con una cita), se usa esa primera línea igual,
 * ya limpia. Devuelve cadena vacía cuando no hay nada que resumir.
 */
export function summaryFromBody(body) {
  let inFence = false;
  for (const rawLine of String(body ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || line === '') continue;
    if (/^#{1,6}\s/.test(line)) continue;
    if (/^(?:[-*_]\s*){3,}$/.test(line)) continue;
    if (line.startsWith('|')) continue;

    const clean = line
      .replace(/^>\s*/, '')
      .replace(/^(?:[-*+]|\d+\.)\s+/, '')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[*_`]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (clean === '') continue;

    // Corte por final de frase. El punto tiene que ir seguido de espacio o de
    // fin de línea («1.5 kg» no termina una frase) y la frase resultante ha de
    // tener cuerpo suficiente: un «Anexo D.» suelto no es un resumen.
    const sentence = /^(.+?[.!?])(?:\s|$)/.exec(clean);
    const picked = sentence && sentence[1].length >= 20 ? sentence[1] : clean;
    return picked.length > SUMMARY_MAX
      ? `${picked.slice(0, SUMMARY_MAX - 1).trimEnd()}…`
      : picked;
  }
  return '';
}

// gray-matter (js-yaml) parsea YAML real — multilínea, comillas, anidamiento —
// de cara al corpus representativo; aquí solo se conservan las validaciones del
// contrato del importador: front-matter obligatorio y cerrado, claves conocidas
// y valores escalares o listas de escalares.
export function parseFrontMatter(raw, { allowedKeys }) {
  const lines = raw.split(/\r?\n/);
  if ((lines[0] ?? '').trim() !== '---') {
    throw new Error('falta el front-matter (la primera línea debe ser «---»)');
  }
  if (!lines.slice(1).some((line) => line.trim() === '---')) {
    throw new Error('front-matter sin cerrar (falta la línea «---» final)');
  }
  let parsed;
  try {
    parsed = matter(raw);
  } catch (error) {
    throw new Error(`front-matter YAML inválido: ${error.reason ?? error.message}`);
  }
  const data = {};
  for (const [key, value] of Object.entries(parsed.data)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`clave de front-matter no soportada: «${key}»`);
    }
    if (Array.isArray(value)) {
      if (value.length === 0) {
        throw new Error(`la clave «${key}» no tiene valor ni elementos de lista`);
      }
      data[key] = value.map((item) => {
        if (typeof item !== 'string' && typeof item !== 'number') {
          throw new Error(`la lista «${key}» solo admite valores simples`);
        }
        return String(item).trim();
      });
    } else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      data[key] = String(value).trim();
    } else {
      throw new Error(`la clave «${key}» tiene un valor no soportado`);
    }
  }
  return { data, body: parsed.content.replace(/^\r?\n+/, '') };
}

function parsePageFile(raw, { fallbackSlug }) {
  const { data, body } = parseFrontMatter(raw, { allowedKeys: PAGE_KEYS });
  if (typeof data.title !== 'string' || data.title.trim() === '') {
    throw new Error('falta «title» en el front-matter');
  }
  for (const key of ['tags', 'aliases']) {
    if (key in data && !Array.isArray(data[key])) {
      throw new Error(`«${key}» debe ser una lista`);
    }
  }
  const status = data.status ?? 'published';
  if (status !== 'draft' && status !== 'published') {
    throw new Error(`«status» debe ser draft o published, llegó «${data.status}»`);
  }
  const pinnedRaw = data.pinned ?? 'false';
  if (pinnedRaw !== 'true' && pinnedRaw !== 'false') {
    throw new Error(`«pinned» debe ser true o false, llegó «${data.pinned}»`);
  }
  const pinned = pinnedRaw === 'true';
  let slug;
  if ('slug' in data) {
    if (Array.isArray(data.slug) || !SLUG_RE.test(data.slug)) {
      throw new Error(`«slug» inválido: «${data.slug}» (minúsculas, dígitos y guiones)`);
    }
    slug = data.slug;
  } else {
    slug = slugify(fallbackSlug);
  }
  if (RESERVED_SLUGS.has(slug)) {
    throw new Error(
      `«${slug}» es un slug reservado de la Guía (modo libro y progreso); dale otro título o un «slug» propio`
    );
  }
  return {
    title: data.title.trim(),
    slug,
    tags: data.tags ?? [],
    aliases: data.aliases ?? [],
    status,
    pinned,
    body,
  };
}

async function listEntries(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => !entry.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

// Fase de análisis: recorre el corpus y produce un plan (espacios y páginas en
// orden padre→hijo) más la lista de errores por fichero. No toca la base.
export async function buildPlan(rootDir) {
  const root = path.resolve(rootDir);
  const rootStat = await stat(root).catch(() => null);
  if (!rootStat?.isDirectory()) {
    throw new Error(`--dir no es una carpeta legible: ${root}`);
  }
  const spaces = [];
  const pages = [];
  const errors = [];
  const relative = (file) => path.relative(root, file);

  const addPage = async (file, spaceSlug, parentFile, fallbackSlug, position) => {
    try {
      const parsed = parsePageFile(await readFile(file, 'utf8'), { fallbackSlug });
      pages.push({ file, rel: relative(file), spaceSlug, parentFile, position, ...parsed });
    } catch (error) {
      errors.push({ file: relative(file), reason: error.message });
    }
  };

  const walk = async (dir, spaceSlug, parentFile) => {
    const entries = await listEntries(dir);
    const hasIndex = entries.some((entry) => entry.isFile() && entry.name === 'index.md');
    let nextParent = parentFile;
    let position = 0;
    if (hasIndex) {
      const indexFile = path.join(dir, 'index.md');
      await addPage(indexFile, spaceSlug, parentFile, path.basename(dir), position);
      nextParent = indexFile;
      position += 1;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'index.md' && entry.name !== '_space.md') {
        await addPage(
          path.join(dir, entry.name),
          spaceSlug,
          nextParent,
          entry.name.replace(/\.md$/, ''),
          position
        );
        position += 1;
      }
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name), spaceSlug, nextParent);
      }
    }
  };

  for (const entry of await listEntries(root)) {
    if (!entry.isDirectory()) continue;
    const spaceDir = path.join(root, entry.name);
    let spaceSlug;
    try {
      spaceSlug = slugify(entry.name);
    } catch (error) {
      errors.push({ file: relative(spaceDir), reason: error.message });
      continue;
    }
    let name = entry.name;
    let description = '';
    let position = 0;
    const spaceFile = path.join(spaceDir, '_space.md');
    if (await stat(spaceFile).then((s) => s.isFile(), () => false)) {
      try {
        const { data } = parseFrontMatter(await readFile(spaceFile, 'utf8'), {
          allowedKeys: SPACE_KEYS,
        });
        for (const key of ['name', 'description', 'position']) {
          if (key in data && typeof data[key] !== 'string') {
            throw new Error(`«${key}» debe ser un escalar`);
          }
        }
        if (data.name) name = data.name.trim();
        if (data.description) description = data.description.trim();
        if ('position' in data) {
          if (!/^\d+$/.test(data.position)) {
            throw new Error(`«position» debe ser un entero no negativo, llegó «${data.position}»`);
          }
          position = Number(data.position);
        }
      } catch (error) {
        errors.push({ file: relative(spaceFile), reason: error.message });
      }
    }
    spaces.push({ slug: spaceSlug, name, description, position, dir: entry.name });
    await walk(spaceDir, spaceSlug, null);
  }

  // Colisiones de slug dentro del lote (los slugs son únicos por hogar,
  // también entre espacios distintos).
  const bySlug = new Map();
  for (const page of pages) {
    const clash = bySlug.get(page.slug);
    if (clash) {
      errors.push({
        file: page.rel,
        reason: `slug «${page.slug}» duplicado en el lote (ya lo usa ${clash.rel})`,
      });
    } else {
      bySlug.set(page.slug, page);
    }
  }

  // Reescritura de enlaces internos relativos a `wiki:slug`.
  const slugByFile = new Map(pages.map((page) => [page.file, page.slug]));
  const linkRewrites = [];
  const LINK_RE = /(\[[^\]]*\]\()(\.{1,2}\/[^)\s]+?\.md)((?:#[^)]*)?\))/g;
  for (const page of pages) {
    page.body = page.body.replace(LINK_RE, (whole, prefix, target, suffix) => {
      const resolved = path.resolve(path.dirname(page.file), target);
      const slug = slugByFile.get(resolved);
      if (!slug) {
        errors.push({
          file: page.rel,
          reason: `enlace interno roto: «${target}» no apunta a ninguna página del corpus`,
        });
        return whole;
      }
      linkRewrites.push({ file: page.rel, target, slug });
      return `${prefix}wiki:${slug}${suffix}`;
    });
    // El resumen se calcula sobre el cuerpo YA reescrito y entra en el hash:
    // así, cambiar la regla del resumen se comporta como cualquier otro cambio
    // de contenido (una revisión nueva) en vez de quedarse a medias.
    page.summary = summaryFromBody(page.body);
    page.hash = contentHash(page);
  }

  return { root, spaces, pages, errors, linkRewrites };
}

class ImportAbort extends Error {
  constructor(message, failures) {
    super(message);
    this.name = 'ImportAbort';
    this.failures = failures;
  }
}

// Ejecuta el plan contra la base en UNA transacción. `dryRun` hace ROLLBACK al
// final (ensayo); cualquier error hace ROLLBACK e identifica el fichero.
export async function importCorpus(client, { householdId, membershipId, dir, dryRun = false }) {
  const plan = await buildPlan(dir);
  const report = {
    dryRun,
    spaces: { created: [], updated: [], skipped: [] },
    pages: { created: [], updated: [], skipped: [] },
    revisions: 0,
    linkRewrites: plan.linkRewrites,
    errors: plan.errors,
  };

  await client.query('begin');
  try {
    await client.query('set local row_security = off');

    if (plan.errors.length > 0) {
      throw new ImportAbort(
        `corpus inválido; nada se ha importado:\n${plan.errors
          .map((e) => `  - ${e.file}: ${e.reason}`)
          .join('\n')}`,
        plan.errors
      );
    }

    const membership = await client.query(
      `select 1 from app.household_memberships
        where household_id = $1 and id = $2 and revoked_at is null`,
      [householdId, membershipId]
    );
    if (membership.rowCount === 0) {
      throw new Error(`la membresía ${membershipId} no existe (o está revocada) en el hogar ${householdId}`);
    }

    const spaceIdBySlug = new Map();
    for (const space of plan.spaces) {
      const existing = await client.query(
        `select id, name, description, position from app.wiki_spaces
          where household_id = $1 and slug = $2`,
        [householdId, space.slug]
      );
      if (existing.rowCount === 0) {
        const inserted = await client.query(
          `insert into app.wiki_spaces (household_id, slug, name, description, position, created_by_membership_id)
           values ($1, $2, $3, $4, $5, $6)
           returning id`,
          [householdId, space.slug, space.name, space.description, space.position, membershipId]
        );
        spaceIdBySlug.set(space.slug, inserted.rows[0].id);
        report.spaces.created.push(space.slug);
      } else {
        const row = existing.rows[0];
        spaceIdBySlug.set(space.slug, row.id);
        if (
          row.name !== space.name ||
          row.description !== space.description ||
          row.position !== space.position
        ) {
          await client.query(
            `update app.wiki_spaces set name = $3, description = $4, position = $5
              where household_id = $1 and id = $2`,
            [householdId, row.id, space.name, space.description, space.position]
          );
          report.spaces.updated.push(space.slug);
        } else {
          report.spaces.skipped.push(space.slug);
        }
      }
    }

    const pageIdByFile = new Map();
    for (const page of plan.pages) {
      try {
        const spaceId = spaceIdBySlug.get(page.spaceSlug);
        const parentId = page.parentFile ? pageIdByFile.get(page.parentFile) ?? null : null;
        const existing = await client.query(
          `select p.id, p.space_id, p.status, p.parent_page_id, p.current_slug, p.pinned,
                  r.title, r.body_markdown, r.tags, r.aliases, r.summary, r.import_hash
             from app.wiki_page_slugs s
             join app.wiki_pages p on p.household_id = s.household_id and p.id = s.page_id
             left join app.wiki_revisions r
               on r.household_id = p.household_id and r.id = p.current_revision_id
            where s.household_id = $1 and s.slug = $2`,
          [householdId, page.slug]
        );

        if (existing.rowCount === 0) {
          const inserted = await client.query(
            `insert into app.wiki_pages
               (household_id, space_id, parent_page_id, status, current_slug, pinned, position, created_by_membership_id)
             values ($1, $2, $3, $4, $5, $6, $7, $8)
             returning id`,
            [householdId, spaceId, parentId, page.status, page.slug, page.pinned, page.position, membershipId]
          );
          const pageId = inserted.rows[0].id;
          pageIdByFile.set(page.file, pageId);
          await client.query(
            `insert into app.wiki_page_slugs (household_id, page_id, slug) values ($1, $2, $3)`,
            [householdId, pageId, page.slug]
          );
          await insertRevision(client, { householdId, membershipId, pageId, page });
          report.revisions += 1;
          report.pages.created.push(page.slug);
          continue;
        }

        const row = existing.rows[0];
        pageIdByFile.set(page.file, row.id);
        if (row.space_id !== spaceId) {
          throw new Error(
            `colisión de slug entre espacios: «${page.slug}» ya pertenece a otro espacio de este hogar`
          );
        }
        // `import_hash` es la marca que dejó este mismo importador: si coincide,
        // la revisión vigente ES la del corpus y no hay nada que hacer. Si no
        // (revisión escrita a mano desde la aplicación, o base anterior a la
        // migración 0017), se rehashea el contenido almacenado para decidir.
        const existingHash =
          row.title === null
            ? null
            : contentHash({
                title: row.title,
                body: row.body_markdown,
                tags: row.tags,
                aliases: row.aliases,
                summary: row.summary,
              });
        const sameContent =
          row.import_hash === page.hash.slice(0, 12) || existingHash === page.hash;
        const sameMeta =
          row.status === page.status &&
          (row.parent_page_id ?? null) === parentId &&
          row.pinned === page.pinned;

        if (sameContent && sameMeta) {
          report.pages.skipped.push(page.slug);
          continue;
        }
        if (!sameContent) {
          await insertRevision(client, { householdId, membershipId, pageId: row.id, page });
          report.revisions += 1;
        }
        if (!sameMeta || !sameContent) {
          await client.query(
            `update app.wiki_pages set status = $3, parent_page_id = $4, pinned = $5
              where household_id = $1 and id = $2`,
            [householdId, row.id, page.status, parentId, page.pinned]
          );
        }
        report.pages.updated.push(page.slug);
      } catch (error) {
        if (error instanceof ImportAbort) throw error;
        throw new ImportAbort(
          `fallo importando ${page.rel}: ${error.message}\nRollback completo; nada se ha importado.`,
          [{ file: page.rel, reason: error.message }]
        );
      }
    }

    if (dryRun) {
      await client.query('rollback');
    } else {
      await client.query('commit');
    }
    return report;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    if (error instanceof ImportAbort && dryRun) {
      // El ensayo informa de los errores sin lanzar: nada se ha escrito.
      for (const failure of error.failures) {
        if (!report.errors.includes(failure)) report.errors.push(failure);
      }
      return report;
    }
    throw error;
  }
}

async function insertRevision(client, { householdId, membershipId, pageId, page }) {
  const next = await client.query(
    `select coalesce(max(revision_number), 0) + 1 as n
       from app.wiki_revisions where household_id = $1 and page_id = $2`,
    [householdId, pageId]
  );
  const inserted = await client.query(
    `insert into app.wiki_revisions
       (household_id, page_id, revision_number, title, body_markdown, summary, import_hash,
        tags, aliases, authored_by_membership_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     returning id`,
    [
      householdId,
      pageId,
      next.rows[0].n,
      page.title,
      page.body,
      page.summary ?? '',
      page.hash.slice(0, 12),
      page.tags,
      page.aliases,
      membershipId,
    ]
  );
  await client.query(
    `update app.wiki_pages set current_revision_id = $3, status = $4
      where household_id = $1 and id = $2`,
    [householdId, pageId, inserted.rows[0].id, page.status]
  );
}

function parseArgs(argv) {
  const args = { dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case '--household':
        args.householdId = argv[++i];
        break;
      case '--membership':
        args.membershipId = argv[++i];
        break;
      case '--dir':
        args.dir = argv[++i];
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      default:
        throw new Error(`argumento desconocido: ${argv[i]}`);
    }
  }
  if (!UUID_RE.test(args.householdId ?? '')) throw new Error('--household debe ser un uuid');
  if (!UUID_RE.test(args.membershipId ?? '')) throw new Error('--membership debe ser un uuid');
  if (!args.dir) throw new Error('--dir es obligatorio');
  return args;
}

function printReport(report) {
  const mode = report.dryRun ? '[dry-run] ' : '';
  for (const slug of report.spaces.created) console.log(`${mode}espacio nuevo: ${slug}`);
  for (const slug of report.spaces.updated) console.log(`${mode}espacio actualizado: ${slug}`);
  for (const slug of report.pages.created) console.log(`${mode}página nueva: ${slug}`);
  for (const slug of report.pages.updated) console.log(`${mode}página actualizada: ${slug}`);
  for (const link of report.linkRewrites) {
    console.log(`${mode}enlace reescrito en ${link.file}: ${link.target} -> wiki:${link.slug}`);
  }
  for (const error of report.errors) {
    console.error(`${mode}ERROR ${error.file}: ${error.reason}`);
  }
  console.log(
    `${mode}resumen: espacios ${report.spaces.created.length} nuevos / ${report.spaces.updated.length} actualizados / ` +
      `${report.spaces.skipped.length} omitidos; páginas ${report.pages.created.length} nuevas / ` +
      `${report.pages.updated.length} actualizadas / ${report.pages.skipped.length} omitidas; ` +
      `${report.revisions} revisiones; ${report.linkRewrites.length} enlaces reescritos; ` +
      `${report.errors.length} errores`
  );
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  let client;
  try {
    const args = parseArgs(process.argv.slice(2));
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL es obligatoria (rol admin/propietario de migraciones)');
    client = new pg.Client({ connectionString: url });
    await client.connect();
    const report = await importCorpus(client, args);
    printReport(report);
    if (report.errors.length > 0) process.exitCode = 1;
  } catch (error) {
    console.error(error.message ?? error);
    process.exitCode = 1;
  } finally {
    await client?.end();
  }
}
