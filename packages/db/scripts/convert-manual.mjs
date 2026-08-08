// Conversión del «Manual de convivencia y operaciones v0.1» (Word) al corpus
// Markdown de la Guía de la casa (Ola A del plan de pendientes).
//
// Uso:
//   node scripts/convert-manual.mjs --docx <Manual.docx> [--out content/manual]
//
// Produce un árbol compatible con wiki-import.mjs: una carpeta por apartado
// (con `_space.md`: name, description, position) y una nota por ficha con
// front-matter (title, slug, status, pinned, tags). Reglas del plan
// (docs/plan-import-manual-convivencia.md):
//
//   · una nota por Heading2 del manual, fusionando los apartados menores de
//     seis líneas con su hermano (el mapa NOTES de abajo deja la fusión
//     explícita y revisable);
//   · tablas Word → tablas Markdown; avisos (ManualCallout/ManualRule) →
//     citas destacadas `> **…**`;
//   · cada campo «Pendiente de completar por la familia» → cita
//     `> **Pendiente de completar por la familia:** …` y la nota queda en
//     `status: draft`; las notas sin pendientes se publican;
//   · se genera la nota índice «Pendientes de completar» (draft, fijada) con
//     enlace a cada nota con huecos;
//   · NO se importan: portada, índice del Word, control de versiones, «Ruta
//     de consulta» ni los Anexos G/H/I/J (contactos y compra personal van a
//     sus módulos; el registro de incidencias está descartado).
//
// La salida es determinista: mismo .docx → mismos ficheros byte a byte, para
// que el corpus commiteado y el hash idempotente del importador se mantengan.

import { readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

import { unzipSync, strFromU8 } from 'fflate';
import matter from 'gray-matter';

const PLACEHOLDER = 'pendiente de completar por la familia';
const PENDIENTE_PREFIX = '> **Pendiente de completar por la familia:**';

// ─────────────────────────────────────────────────────────────────────────────
// 1 · Lectura del .docx: word/document.xml → lista plana de párrafos (con
// estilo y negritas por run) y tablas (matriz de celdas de texto).
// ─────────────────────────────────────────────────────────────────────────────

function decodeEntities(text) {
  return text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

/** Runs de un párrafo con su negrita: [{ text, bold }] */
function parseRuns(pXml) {
  const runs = [];
  const runRe = /<w:r(?: [^>]*)?>([\s\S]*?)<\/w:r>/g;
  let match;
  while ((match = runRe.exec(pXml))) {
    const inner = match[1];
    const bold = /<w:rPr>[\s\S]*?<w:b\/>[\s\S]*?<\/w:rPr>/.test(inner);
    const texts = [...inner.matchAll(/<w:t(?: [^>]*)?>([\s\S]*?)<\/w:t>/g)].map((m) =>
      decodeEntities(m[1])
    );
    const text = texts.join('');
    if (text.length > 0) runs.push({ text, bold });
  }
  return runs;
}

function plainText(runs) {
  return runs.map((run) => run.text).join('');
}

/** Runs → Markdown en línea con **negrita** por tramos contiguos. */
function runsToMarkdown(runs) {
  let out = '';
  let index = 0;
  while (index < runs.length) {
    if (!runs[index].bold) {
      out += runs[index].text;
      index += 1;
      continue;
    }
    let boldText = '';
    while (index < runs.length && runs[index].bold) {
      boldText += runs[index].text;
      index += 1;
    }
    // La negrita Markdown no admite espacios pegados a los asteriscos.
    const leading = boldText.match(/^\s*/)[0];
    const trailing = boldText.match(/\s*$/)[0];
    const core = boldText.trim();
    out += core.length > 0 ? `${leading}**${core}**${trailing}` : boldText;
  }
  return out;
}

function paragraphStyle(pXml) {
  const match = /<w:pStyle w:val="([^"]+)"/.exec(pXml);
  return match ? match[1] : 'Normal';
}

/** document.xml → items [{ kind: 'p', style, runs } | { kind: 'table', rows }] */
export function parseDocumentXml(xml) {
  const bodyStart = xml.indexOf('<w:body>');
  const body = bodyStart === -1 ? xml : xml.slice(bodyStart);
  const items = [];
  let cursor = 0;
  for (;;) {
    const pMatch = /<w:p[ >]/.exec(body.slice(cursor));
    const tableAt = body.indexOf('<w:tbl>', cursor);
    const paragraphAt = pMatch ? cursor + pMatch.index : -1;
    if (paragraphAt === -1 && tableAt === -1) break;
    if (tableAt === -1 || (paragraphAt !== -1 && paragraphAt < tableAt)) {
      const end = body.indexOf('</w:p>', paragraphAt) + '</w:p>'.length;
      const pXml = body.slice(paragraphAt, end);
      items.push({ kind: 'p', style: paragraphStyle(pXml), runs: parseRuns(pXml) });
      cursor = end;
    } else {
      const end = body.indexOf('</w:tbl>', tableAt) + '</w:tbl>'.length;
      const tableXml = body.slice(tableAt, end);
      const rows = [...tableXml.matchAll(/<w:tr[ >][\s\S]*?<\/w:tr>/g)].map((rowMatch) =>
        [...rowMatch[0].matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)].map((cellMatch) =>
          plainText(parseRuns(cellMatch[0])).replace(/\s+/g, ' ').trim()
        )
      );
      items.push({ kind: 'table', rows });
      cursor = end;
    }
  }
  return items;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2 · Modelo de secciones: preámbulo + (Heading1 → Heading2 → contenido).
// ─────────────────────────────────────────────────────────────────────────────

export function buildSections(items) {
  const sections = new Map(); // 'h1|h2' → items[]
  const keyOf = (h1, h2) => `${h1}|${h2 ?? ''}`;
  let h1 = null;
  let h2 = null;
  const preamble = [];
  for (const item of items) {
    if (item.kind === 'p' && item.style === 'Heading1') {
      h1 = plainText(item.runs).trim();
      h2 = null;
      sections.set(keyOf(h1, null), []);
      continue;
    }
    if (item.kind === 'p' && item.style === 'Heading2') {
      h2 = plainText(item.runs).trim();
      sections.set(keyOf(h1, h2), []);
      continue;
    }
    if (h1 === null) {
      // Preámbulo del documento: solo interesan el aviso y los párrafos
      // introductorios que siguen a la tabla de control de versiones
      // (portada, índice y la propia tabla se descartan).
      if (item.kind === 'table') {
        preamble.length = 0;
        continue;
      }
      if (item.kind === 'p' && (item.style === 'Normal' || item.style === 'ManualCallout')) {
        if (plainText(item.runs).trim().length > 0) preamble.push(item);
      }
      continue;
    }
    sections.get(keyOf(h1, h2)).push(item);
  }
  return { sections, preamble, keyOf };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3 · Render Markdown con la regla de pendientes.
// ─────────────────────────────────────────────────────────────────────────────

function isPlaceholder(cell) {
  return cell.trim().toLowerCase().replace(/\.$/, '') === PLACEHOLDER;
}

function escapeCell(text) {
  return text.replaceAll('|', '\\|');
}

/**
 * Tabla Word → bloques Markdown. Las filas reales quedan como tabla; las filas
 * «Pendiente de completar por la familia» se convierten en citas destacadas:
 * con etiqueta (primera celda real) o, si toda la fila es placeholder, una
 * única cita con las columnas de la cabecera.
 */
function renderTable(rows) {
  if (rows.length === 0) return { lines: [], pendientes: [], rawPlaceholders: 0 };
  const [header, ...dataRows] = rows;
  const realRows = [];
  const pendientes = [];
  let anonymous = false;
  let rawPlaceholders = 0;
  for (const row of dataRows) {
    const placeholderCount = row.filter((cell) => isPlaceholder(cell)).length;
    rawPlaceholders += placeholderCount;
    if (placeholderCount === 0) {
      realRows.push(row);
    } else if (placeholderCount === row.length) {
      anonymous = true;
    } else if (!isPlaceholder(row[0]) && row.slice(1).every((cell) => isPlaceholder(cell))) {
      pendientes.push(row[0]);
    } else {
      // Fila mixta: se conserva como fila real marcando los huecos.
      realRows.push(row.map((cell) => (isPlaceholder(cell) ? '*pendiente*' : cell)));
    }
  }
  const lines = [];
  if (realRows.length > 0) {
    lines.push(`| ${header.map(escapeCell).join(' | ')} |`);
    lines.push(`| ${header.map(() => '---').join(' | ')} |`);
    for (const row of realRows) lines.push(`| ${row.map(escapeCell).join(' | ')} |`);
  }
  const pendienteLines = pendientes.map((label) => `${PENDIENTE_PREFIX} ${label}.`);
  if (anonymous) {
    pendienteLines.push(`${PENDIENTE_PREFIX} ${header.join(' · ')}.`);
  }
  return { lines, pendientes: pendienteLines, rawPlaceholders };
}

function renderCallout(text) {
  // «Aviso previo. Antes de…» → primera oración en negrita.
  const match = /^([^.:]{1,60}[.:])\s*([\s\S]*)$/.exec(text.trim());
  if (match) return `> **${match[1]}** ${match[2]}`.trim();
  return `> ${text.trim()}`;
}

/**
 * Items de una sección → líneas Markdown. Devuelve también las citas de
 * pendientes generadas (para el estado draft y el índice).
 */
function renderSection(sectionItems, { dropTables = [] } = {}) {
  const lines = [];
  const pendientes = [];
  let rawPlaceholders = 0;
  let listNumber = 0;
  let tableIndex = -1;
  const push = (line) => {
    if (lines.length > 0 && lines[lines.length - 1] !== '' && line !== '') lines.push('');
    if (!(line === '' && lines[lines.length - 1] === '')) lines.push(line);
  };
  const pushListItem = (line) => {
    // Los elementos de lista van contiguos, sin línea en blanco entre ellos.
    if (lines.length > 0 && /^(?:- |\d+\. )/.test(lines[lines.length - 1])) lines.push(line);
    else push(line);
  };
  for (const item of sectionItems) {
    if (item.kind === 'table') {
      tableIndex += 1;
      const rendered = renderTable(item.rows);
      rawPlaceholders += rendered.rawPlaceholders;
      if (dropTables.includes(tableIndex)) continue;
      if (rendered.lines.length > 0) {
        push(rendered.lines[0]);
        for (const line of rendered.lines.slice(1)) lines.push(line);
      }
      for (const pendiente of rendered.pendientes) {
        push(pendiente);
        pendientes.push(pendiente);
      }
      listNumber = 0;
      continue;
    }
    const text = runsToMarkdown(item.runs).trim();
    if (text.length === 0) continue;
    switch (item.style) {
      case 'ListBullet':
        pushListItem(`- ${text}`);
        listNumber = 0;
        break;
      case 'ListNumber':
        listNumber += 1;
        pushListItem(`${listNumber}. ${text}`);
        break;
      case 'ManualRule':
      case 'ManualCallout': {
        push(renderCallout(plainText(item.runs)));
        listNumber = 0;
        break;
      }
      default: {
        // Párrafo normal; un «Campo: Pendiente de completar…» suelto también
        // se convierte en cita destacada.
        const standalone = /^(.{1,80}):\s*Pendiente de completar por la familia\.?$/i.exec(text);
        if (standalone) {
          const pendiente = `${PENDIENTE_PREFIX} ${standalone[1]}.`;
          push(pendiente);
          pendientes.push(pendiente);
          rawPlaceholders += 1;
        } else {
          push(text);
        }
        listNumber = 0;
      }
    }
  }
  return { lines, pendientes, rawPlaceholders };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4 · Mapa editorial: 7 apartados y sus notas (fusiones explícitas).
//     `sources` referencia H1/H2 del Word; `preamble: true` inserta el aviso
//     y los párrafos introductorios del documento.
// ─────────────────────────────────────────────────────────────────────────────

const SPACES = [
  {
    dir: 'la-casa-y-sus-zonas',
    name: 'La casa y sus zonas',
    description: 'Distribución, almacenaje, jornada y rutinas de referencia.',
    position: 10,
    tag: 'casa',
  },
  {
    dir: 'limpieza',
    name: 'Limpieza',
    description: 'Método general, fichas por superficie y particularidades por zona.',
    position: 20,
    tag: 'limpieza',
  },
  {
    dir: 'cocina',
    name: 'Cocina',
    description: 'Higiene, cocción, sobras, aparatos y compra de alimentos.',
    position: 30,
    tag: 'cocina',
  },
  {
    dir: 'ropa-y-colada',
    name: 'Ropa y colada',
    description: 'Secuencia de la colada, cuidados por prenda y guardado.',
    position: 40,
    tag: 'colada',
  },
  {
    dir: 'los-ninos',
    name: 'Los niños',
    description: 'Pautas, salud, descanso y qué comunicar a la familia.',
    position: 50,
    tag: 'niños',
  },
  {
    dir: 'convivencia',
    name: 'Convivencia',
    description: 'Principios, comunicación, privacidad y espacios privados.',
    position: 60,
    tag: 'convivencia',
  },
  {
    dir: 'mantenimiento',
    name: 'Mantenimiento',
    description: 'Qué vigilar, límites de actuación y actuación ante riesgo.',
    position: 70,
    tag: 'mantenimiento',
  },
];

const H1 = {
  como: 'Cómo utilizar este manual',
  principios: 'Principios generales',
  casa: 'La casa y sus zonas',
  guia: 'Guía rápida',
  rutinas: 'Rutinas generales',
  limpieza: 'Limpieza',
  cocina: 'Cocina y alimentación',
  colada: 'Colada y organización de la ropa',
  ninos: 'Convivencia con los niños',
  convivencia: 'Convivencia, comunicación y espacios privados',
  mantenimiento: 'Mantenimiento e incidencias',
  faq: 'Preguntas frecuentes',
  anexos: 'Anexos',
};

const NOTES = [
  // ── La casa y sus zonas ────────────────────────────────────────────────────
  {
    space: 'la-casa-y-sus-zonas',
    file: '010-distribucion-y-mapa-funcional.md',
    slug: 'distribucion-y-mapa-funcional',
    title: 'Distribución y mapa funcional',
    sources: [
      { h1: H1.casa, h2: 'Distribución' },
      { h1: H1.casa, h2: 'Mapa funcional', heading: 'Mapa funcional' },
    ],
  },
  {
    space: 'la-casa-y-sus-zonas',
    file: '020-almacenaje-y-reglas-de-colocacion.md',
    slug: 'almacenaje-y-reglas-de-colocacion',
    title: 'Almacenaje y reglas de colocación',
    sources: [
      { h1: H1.casa, h2: 'Almacenaje principal' },
      { h1: H1.casa, h2: 'Reglas de colocación', heading: 'Reglas de colocación' },
    ],
  },
  {
    space: 'la-casa-y-sus-zonas',
    file: '030-guia-rapida-inicio-de-jornada.md',
    slug: 'guia-rapida-inicio-de-jornada',
    title: 'Guía rápida: inicio de jornada',
    pinned: true,
    sources: [{ h1: H1.guia, h2: 'Inicio de la jornada' }],
  },
  {
    space: 'la-casa-y-sus-zonas',
    file: '040-guia-rapida-durante-la-jornada.md',
    slug: 'guia-rapida-durante-la-jornada',
    title: 'Guía rápida: durante la jornada',
    sources: [{ h1: H1.guia, h2: 'Durante la jornada' }],
  },
  {
    space: 'la-casa-y-sus-zonas',
    file: '050-guia-rapida-cierre-de-jornada.md',
    slug: 'guia-rapida-cierre-de-jornada',
    title: 'Guía rápida: cierre de jornada',
    pinned: true,
    sources: [{ h1: H1.guia, h2: 'Cierre de la jornada' }],
  },
  {
    space: 'la-casa-y-sus-zonas',
    file: '060-rutina-diaria-de-referencia.md',
    slug: 'rutina-diaria-de-referencia',
    title: 'Rutina diaria de referencia',
    sources: [{ h1: H1.rutinas, h2: 'Rutina diaria de referencia' }],
  },
  {
    space: 'la-casa-y-sus-zonas',
    file: '070-ventilacion-orden-y-residuos.md',
    slug: 'ventilacion-orden-y-residuos',
    title: 'Ventilación, orden y residuos',
    sources: [
      { h1: H1.rutinas, h2: 'Ventilación', heading: 'Ventilación' },
      { h1: H1.rutinas, h2: 'Orden y residuos', heading: 'Orden y residuos' },
    ],
  },
  {
    space: 'la-casa-y-sus-zonas',
    file: '080-planes-semanal-quincenal-y-periodico.md',
    slug: 'planes-semanal-quincenal-y-periodico',
    title: 'Planes semanal, quincenal y periódico',
    sources: [
      { h1: H1.rutinas, h2: 'Plan semanal', heading: 'Plan semanal' },
      { h1: H1.rutinas, h2: 'Plan quincenal', heading: 'Plan quincenal' },
      { h1: H1.rutinas, h2: 'Plan periódico', heading: 'Plan periódico' },
    ],
    append: [
      'Las rutinas correspondientes ya existen en la página de Rutinas de la app; al concretar cada plan, edítalas allí y completa esta nota.',
    ],
  },

  // ── Limpieza ───────────────────────────────────────────────────────────────
  {
    space: 'limpieza',
    file: '010-metodo-general-de-limpieza.md',
    slug: 'metodo-general-de-limpieza',
    title: 'Método general de limpieza',
    sources: [{ h1: H1.limpieza, h2: 'Método general' }],
  },
  {
    space: 'limpieza',
    file: '020-ficha-operativa-marmol.md',
    slug: 'ficha-operativa-marmol',
    title: 'Ficha operativa: mármol',
    sources: [{ h1: H1.limpieza, h2: 'Ficha operativa: mármol' }],
  },
  {
    space: 'limpieza',
    file: '030-ficha-operativa-tarima.md',
    slug: 'ficha-operativa-tarima',
    title: 'Ficha operativa: tarima',
    sources: [{ h1: H1.limpieza, h2: 'Ficha operativa: tarima' }],
  },
  {
    space: 'limpieza',
    file: '040-ficha-operativa-terrazo.md',
    slug: 'ficha-operativa-terrazo',
    title: 'Ficha operativa: terrazo',
    sources: [{ h1: H1.limpieza, h2: 'Ficha operativa: terrazo' }],
  },
  {
    space: 'limpieza',
    file: '050-particularidades-por-zona.md',
    slug: 'particularidades-por-zona',
    title: 'Particularidades por zona',
    sources: [{ h1: H1.limpieza, h2: 'Particularidades por zona' }],
  },
  {
    space: 'limpieza',
    file: '060-datos-pendientes-de-limpieza.md',
    slug: 'datos-pendientes-de-limpieza',
    title: 'Datos pendientes de limpieza y almacenaje',
    sources: [
      { h1: H1.limpieza, h2: 'Datos pendientes por zona' },
      {
        h1: H1.anexos,
        h2: 'Anexo B. Productos autorizados',
        heading: 'Productos autorizados (Anexo B)',
      },
    ],
    // Único dato propio del Anexo A (el resto duplica Distribución y
    // Almacenaje, que ya son notas publicadas).
    extraSections: [
      {
        heading: 'Mapa de zonas (Anexo A)',
        pendientes: ['Ubicaciones y cuidados adicionales del mapa de zonas'],
      },
    ],
  },

  // ── Cocina ─────────────────────────────────────────────────────────────────
  {
    space: 'cocina',
    file: '010-criterio-general-de-cocina.md',
    slug: 'criterio-general-de-cocina',
    title: 'Criterio general de cocina y alimentación',
    sources: [{ h1: H1.cocina, h2: 'Criterio general' }],
  },
  {
    space: 'cocina',
    file: '020-higiene-y-separacion-de-alimentos.md',
    slug: 'higiene-y-separacion-de-alimentos',
    title: 'Higiene y separación de alimentos',
    sources: [
      { h1: H1.cocina, h2: 'Higiene personal antes de cocinar' },
      { h1: H1.cocina, h2: 'Separación de alimentos', heading: 'Separación de alimentos' },
    ],
  },
  {
    space: 'cocina',
    file: '030-coccion-frio-y-recalentado.md',
    slug: 'coccion-frio-y-recalentado',
    title: 'Cocción, frío y recalentado',
    sources: [{ h1: H1.cocina, h2: 'Cocción, frío y recalentado' }],
  },
  {
    space: 'cocina',
    file: '040-sobras-y-etiquetado.md',
    slug: 'sobras-y-etiquetado',
    title: 'Sobras y etiquetado',
    sources: [{ h1: H1.cocina, h2: 'Sobras y etiquetado' }],
  },
  {
    space: 'cocina',
    file: '050-superficies-y-utensilios.md',
    slug: 'superficies-y-utensilios',
    title: 'Superficies y utensilios',
    sources: [{ h1: H1.cocina, h2: 'Superficies y utensilios' }],
  },
  {
    space: 'cocina',
    file: '060-alergias-intolerancias-y-restricciones.md',
    slug: 'alergias-intolerancias-y-restricciones',
    title: 'Alergias, intolerancias y restricciones',
    sources: [{ h1: H1.cocina, h2: 'Alergias, intolerancias y restricciones' }],
    append: [
      'Las restricciones confirmadas se registran por comensal en la app (Comida → Comensales); las alertas de incompatibilidad del menú se alimentan de ahí.',
    ],
  },
  {
    space: 'cocina',
    file: '070-menu-y-recetas-familiares.md',
    slug: 'menu-y-recetas-familiares',
    title: 'Menú y recetas familiares',
    sources: [{ h1: H1.cocina, h2: 'Menú y recetas familiares' }],
    append: [
      'El menú semanal y el recetario viven en la app (Comida); esta ficha recoge las pautas de uso.',
    ],
  },
  {
    space: 'cocina',
    file: '080-thermomix-horno-e-induccion.md',
    slug: 'thermomix-horno-e-induccion',
    title: 'Thermomix, horno e inducción',
    sources: [{ h1: H1.cocina, h2: 'Thermomix, horno e inducción' }],
  },
  {
    space: 'cocina',
    file: '090-sartenes-de-acero.md',
    slug: 'sartenes-de-acero',
    title: 'Sartenes de acero sin antiadherente',
    sources: [
      { h1: H1.cocina, h2: 'Uso de sartenes de acero sin recubrimiento antiadherente' },
    ],
  },
  {
    space: 'cocina',
    file: '100-cierre-de-cocina.md',
    slug: 'cierre-de-cocina',
    title: 'Cierre de cocina',
    sources: [{ h1: H1.cocina, h2: 'Cierre de cocina' }],
  },
  {
    space: 'cocina',
    file: '110-compra-personal-de-alimentos.md',
    slug: 'compra-personal-de-alimentos',
    title: 'Compra personal de alimentos',
    sources: [{ h1: H1.cocina, h2: 'Compra personal de alimentos' }],
  },
  {
    space: 'cocina',
    file: '120-datos-pendientes-de-cocina.md',
    slug: 'datos-pendientes-de-cocina',
    title: 'Datos pendientes de cocina (Anexos D y F)',
    sources: [
      { h1: H1.anexos, h2: 'Anexo D. Menú y recetas', heading: 'Menú y recetas (Anexo D)' },
      { h1: H1.anexos, h2: 'Anexo F. Electrodomésticos', heading: 'Electrodomésticos (Anexo F)' },
    ],
    append: [
      'Las recetas confirmadas se dan de alta en el Recetario de la app y las semanas tipo como plantillas del menú; las fichas de cada aparato se completan en esta Guía.',
    ],
  },

  // ── Ropa y colada ──────────────────────────────────────────────────────────
  {
    space: 'ropa-y-colada',
    file: '010-secuencia-de-la-colada.md',
    slug: 'secuencia-de-la-colada',
    title: 'Secuencia de la colada',
    sources: [{ h1: H1.colada, h2: 'Secuencia de trabajo' }],
  },
  {
    space: 'ropa-y-colada',
    file: '020-recogida-y-clasificacion.md',
    slug: 'recogida-y-clasificacion',
    title: 'Recogida y clasificación',
    sources: [{ h1: H1.colada, h2: 'Recogida y clasificación' }],
  },
  {
    space: 'ropa-y-colada',
    file: '030-manchas-y-prendas-delicadas.md',
    slug: 'manchas-y-prendas-delicadas',
    title: 'Manchas y prendas delicadas',
    sources: [{ h1: H1.colada, h2: 'Manchas y prendas delicadas' }],
  },
  {
    space: 'ropa-y-colada',
    file: '040-lavado-y-secado.md',
    slug: 'lavado-y-secado',
    title: 'Lavado y secado',
    sources: [{ h1: H1.colada, h2: 'Lavado y secado' }],
  },
  {
    space: 'ropa-y-colada',
    file: '050-planchado.md',
    slug: 'planchado',
    title: 'Planchado',
    sources: [{ h1: H1.colada, h2: 'Planchado' }],
  },
  {
    space: 'ropa-y-colada',
    file: '060-doblado-y-guardado.md',
    slug: 'doblado-y-guardado',
    title: 'Doblado y guardado',
    sources: [{ h1: H1.colada, h2: 'Doblado y guardado' }],
  },
  {
    space: 'ropa-y-colada',
    file: '070-incidencias-de-ropa.md',
    slug: 'incidencias-de-ropa',
    title: 'Incidencias de ropa',
    sources: [{ h1: H1.colada, h2: 'Incidencias de ropa' }],
  },
  {
    space: 'ropa-y-colada',
    file: '080-programas-de-lavado.md',
    slug: 'programas-de-lavado',
    title: 'Programas de lavado y separación',
    sources: [
      // La tabla de programas del cuerpo duplica el Anexo C: se conserva la
      // del anexo (con «Notas» para delicadas) y los criterios de separación.
      { h1: H1.colada, h2: 'Tabla de programas y productos', dropTables: [0] },
      {
        h1: H1.anexos,
        h2: 'Anexo C. Programas de lavado',
        heading: 'Programas de lavado (Anexo C)',
      },
    ],
  },

  // ── Los niños ──────────────────────────────────────────────────────────────
  {
    space: 'los-ninos',
    file: '010-pautas-basicas-con-los-ninos.md',
    slug: 'pautas-basicas-con-los-ninos',
    title: 'Pautas básicas con los niños',
    sources: [
      { h1: H1.ninos, h2: 'Pautas básicas' },
      { h1: H1.ninos, h2: 'Descanso', heading: 'Descanso' },
    ],
  },
  {
    space: 'los-ninos',
    file: '020-cuando-un-nino-no-cumple.md',
    slug: 'cuando-un-nino-no-cumple',
    title: 'Cuando un niño no cumple una instrucción',
    sources: [{ h1: H1.ninos, h2: 'Cuando un niño no cumple una instrucción' }],
  },
  {
    space: 'los-ninos',
    file: '030-salud-medicacion-y-cambios.md',
    slug: 'salud-medicacion-y-cambios',
    title: 'Salud, medicación y cambios',
    sources: [{ h1: H1.ninos, h2: 'Salud, medicación y cambios' }],
  },
  {
    space: 'los-ninos',
    file: '040-que-comunicar-de-los-ninos.md',
    slug: 'que-comunicar-de-los-ninos',
    title: 'Qué comunicar sobre los niños',
    sources: [{ h1: H1.ninos, h2: 'Qué comunicar' }],
  },
  {
    space: 'los-ninos',
    file: '050-horarios-y-pautas-de-los-ninos.md',
    slug: 'horarios-y-pautas-de-los-ninos',
    title: 'Horarios y pautas de los niños (Anexo E)',
    sources: [{ h1: H1.anexos, h2: 'Anexo E. Horarios y pautas de los niños' }],
  },

  // ── Convivencia ────────────────────────────────────────────────────────────
  {
    space: 'convivencia',
    file: '010-principios-generales.md',
    slug: 'principios-generales',
    title: 'Principios generales',
    pinned: true,
    sources: [
      { preamble: true },
      { h1: H1.principios, h2: null },
      { h1: H1.como, h2: 'Método', heading: 'Método de trabajo' },
    ],
    append: [
      'En la app, el historial de revisiones de cada nota sustituye al control de versiones del documento.',
    ],
  },
  {
    space: 'convivencia',
    file: '020-comunicacion-temprana.md',
    slug: 'comunicacion-temprana',
    title: 'Comunicación temprana',
    sources: [{ h1: H1.convivencia, h2: 'Comunicación temprana' }],
  },
  {
    space: 'convivencia',
    file: '030-jornada-descansos-y-ruido.md',
    slug: 'jornada-descansos-y-ruido',
    title: 'Jornada, prioridades, descansos y ruido',
    sources: [
      { h1: H1.convivencia, h2: 'Jornada, prioridades y descansos' },
      { h1: H1.convivencia, h2: 'Ruido', heading: 'Ruido' },
    ],
  },
  {
    space: 'convivencia',
    file: '040-privacidad-reciproca.md',
    slug: 'privacidad-reciproca',
    title: 'Privacidad recíproca',
    sources: [{ h1: H1.convivencia, h2: 'Privacidad recíproca' }],
  },
  {
    space: 'convivencia',
    file: '050-conducta-discreta.md',
    slug: 'conducta-discreta',
    title: 'Conducta discreta',
    sources: [{ h1: H1.convivencia, h2: 'Conducta discreta' }],
  },
  {
    space: 'convivencia',
    file: '060-espacios-privados-y-compra-personal.md',
    slug: 'espacios-privados-y-compra-personal',
    title: 'Espacios privados de la persona interna',
    sources: [
      { h1: H1.convivencia, h2: 'Espacios privados de la persona interna' },
      {
        h1: H1.convivencia,
        h2: 'Compra personal verificable',
        heading: 'Compra personal verificable',
      },
    ],
    append: [
      'El proceso completo está en [Compra personal de alimentos](../cocina/110-compra-personal-de-alimentos.md).',
    ],
  },
  {
    space: 'convivencia',
    file: '070-parametros-de-organizacion.md',
    slug: 'parametros-de-organizacion',
    title: 'Parámetros de jornada y organización',
    sources: [{ h1: H1.rutinas, h2: 'Parámetros familiares de organización' }],
    append: [
      'Los horarios y la jornada acordados viven en Empleo (Acuerdos y pagos); esta nota solo recoge los campos del manual aún sin confirmar.',
    ],
  },
  {
    space: 'convivencia',
    file: '080-preguntas-frecuentes.md',
    slug: 'preguntas-frecuentes',
    title: 'Preguntas frecuentes',
    sources: [{ h1: H1.faq, h2: null }],
  },

  // ── Mantenimiento ──────────────────────────────────────────────────────────
  {
    space: 'mantenimiento',
    file: '010-que-revisar-comunicar-y-consumibles.md',
    slug: 'que-revisar-comunicar-y-consumibles',
    title: 'Qué revisar, comunicar y consumibles',
    sources: [
      { h1: H1.mantenimiento, h2: 'Qué revisar y comunicar' },
      { h1: H1.mantenimiento, h2: 'Consumibles', heading: 'Consumibles' },
    ],
  },
  {
    space: 'mantenimiento',
    file: '020-limites-de-actuacion.md',
    slug: 'limites-de-actuacion',
    title: 'Límites de actuación',
    sources: [{ h1: H1.mantenimiento, h2: 'Límites de actuación' }],
  },
  {
    space: 'mantenimiento',
    file: '030-incidencia-ordinaria-o-urgente.md',
    slug: 'incidencia-ordinaria-o-urgente',
    title: 'Incidencia ordinaria o urgente: actuación',
    sources: [
      { h1: H1.mantenimiento, h2: 'Incidencia ordinaria o urgente' },
      { h1: H1.mantenimiento, h2: 'Actuación ante riesgo', heading: 'Actuación ante riesgo' },
    ],
  },
  {
    space: 'mantenimiento',
    file: '040-que-anotar-de-una-incidencia.md',
    slug: 'que-anotar-de-una-incidencia',
    title: 'Qué anotar de una incidencia',
    sources: [{ h1: H1.mantenimiento, h2: 'Registro de incidencia' }],
  },
];

const INDEX_NOTE = {
  space: 'convivencia',
  file: '090-pendientes-de-completar.md',
  slug: 'pendientes-de-completar',
  title: 'Pendientes de completar',
  pinned: true,
};

// ─────────────────────────────────────────────────────────────────────────────
// 5 · Composición de cada nota y escritura del árbol.
// ─────────────────────────────────────────────────────────────────────────────

export function composeNote(note, model) {
  const { sections, preamble } = model;
  const lines = [];
  const pendientes = [];
  let rawPlaceholders = 0;
  const pushBlock = (blockLines) => {
    if (blockLines.length === 0) return;
    if (lines.length > 0) lines.push('');
    lines.push(...blockLines);
  };
  for (const source of note.sources) {
    let sectionItems;
    if (source.preamble) {
      sectionItems = preamble;
    } else {
      const key = `${source.h1}|${source.h2 ?? ''}`;
      sectionItems = sections.get(key);
      if (!sectionItems) {
        throw new Error(`la sección «${source.h1} › ${source.h2 ?? ''}» no existe en el manual`);
      }
    }
    const rendered = renderSection(sectionItems, { dropTables: source.dropTables ?? [] });
    if (source.heading) pushBlock([`## ${source.heading}`]);
    pushBlock(rendered.lines);
    pendientes.push(...rendered.pendientes);
    rawPlaceholders += rendered.rawPlaceholders;
  }
  for (const extra of note.extraSections ?? []) {
    if (extra.heading) pushBlock([`## ${extra.heading}`]);
    for (const label of extra.pendientes) {
      const pendiente = `${PENDIENTE_PREFIX} ${label}.`;
      pushBlock([pendiente]);
      pendientes.push(pendiente);
    }
  }
  // Citas de pendiente idénticas (tablas duplicadas del Word) se colapsan.
  const seen = new Set();
  const uniquePendientes = pendientes.filter((line) => {
    if (seen.has(line)) return false;
    seen.add(line);
    return true;
  });
  if (note.append?.length) pushBlock(note.append);
  return {
    body: `${lines.join('\n')}\n`,
    pendientes: uniquePendientes,
    rawPlaceholders,
    status: uniquePendientes.length > 0 ? 'draft' : 'published',
  };
}

function frontMatter(note, status, tag) {
  const data = { title: note.title, slug: note.slug, status };
  if (note.pinned) data.pinned = true;
  data.tags = ['manual', tag];
  return data;
}

function buildIndexBody(draftNotes) {
  const lines = [
    'El manual v0.1 llegó con campos «Pendiente de completar por la familia».',
    'Cada nota enlazada conserva sus huecos como citas destacadas y está sin',
    'publicar: al completarla, publícala con un toque y desaparecerá de este',
    'índice en la siguiente revisión.',
    '',
    '## Notas con huecos',
  ];
  for (const entry of draftNotes) {
    const relative = `../${entry.spaceDir}/${entry.file}`;
    const count = entry.pendientes.length;
    lines.push(`- [${entry.title}](${relative}) — ${count} ${count === 1 ? 'campo' : 'campos'}.`);
  }
  lines.push(
    '',
    '## Pendientes que viven en la app, no en la Guía',
    '- Contactos y emergencias (Anexo G): completar el primer y segundo contacto familiar, pediatría y mantenimiento en Contactos.',
    '- Alergias, intolerancias y restricciones: por comensal, en Comida → Comensales.',
    '- Recetas y semanas tipo (Anexo D): en el Recetario y las plantillas del menú.',
    '- Horarios y jornada: en Empleo → Acuerdos y pagos.'
  );
  return `${lines.join('\n')}\n`;
}

async function convert({ docxPath, outDir }) {
  const zip = unzipSync(new Uint8Array(await readFile(docxPath)));
  const documentXml = zip['word/document.xml'];
  if (!documentXml) throw new Error(`${docxPath} no contiene word/document.xml (¿es un .docx?)`);
  const items = parseDocumentXml(strFromU8(documentXml));
  const model = buildSections(items);

  const spaceByDir = new Map(SPACES.map((space) => [space.dir, space]));
  const summary = {
    notes: 0,
    published: 0,
    drafts: 0,
    pendientes: 0,
    rawPlaceholders: 0,
    bySpace: new Map(),
  };
  const draftEntries = [];
  const files = new Map(); // ruta relativa → contenido

  for (const space of SPACES) {
    files.set(
      path.join(space.dir, '_space.md'),
      matter.stringify('', {
        name: space.name,
        description: space.description,
        position: space.position,
      })
    );
  }

  for (const note of NOTES) {
    const space = spaceByDir.get(note.space);
    const composed = composeNote(note, model);
    files.set(
      path.join(space.dir, note.file),
      matter.stringify(`\n${composed.body}`, frontMatter(note, composed.status, space.tag))
    );
    summary.notes += 1;
    summary.rawPlaceholders += composed.rawPlaceholders;
    summary.bySpace.set(space.dir, (summary.bySpace.get(space.dir) ?? 0) + 1);
    if (composed.status === 'draft') {
      summary.drafts += 1;
      summary.pendientes += composed.pendientes.length;
      draftEntries.push({
        title: note.title,
        file: note.file,
        spaceDir: space.dir,
        pendientes: composed.pendientes,
      });
    } else {
      summary.published += 1;
    }
  }

  // Nota índice, generada al final para conocer todos los borradores.
  const indexSpace = spaceByDir.get(INDEX_NOTE.space);
  files.set(
    path.join(indexSpace.dir, INDEX_NOTE.file),
    matter.stringify(
      `\n${buildIndexBody(draftEntries)}`,
      frontMatter(INDEX_NOTE, 'draft', indexSpace.tag)
    )
  );
  summary.notes += 1;
  summary.drafts += 1;
  summary.bySpace.set(indexSpace.dir, (summary.bySpace.get(indexSpace.dir) ?? 0) + 1);

  await rm(outDir, { recursive: true, force: true });
  for (const [relativePath, content] of files) {
    const target = path.join(outDir, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
  return summary;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case '--docx':
        args.docxPath = argv[++i];
        break;
      case '--out':
        args.outDir = argv[++i];
        break;
      default:
        throw new Error(`argumento desconocido: ${argv[i]}`);
    }
  }
  if (!args.docxPath) throw new Error('--docx es obligatorio (ruta al Manual .docx)');
  args.outDir ??= path.join(
    path.dirname(path.dirname(fileURLToPath(import.meta.url))),
    'content',
    'manual'
  );
  return args;
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const summary = await convert(args);
    for (const [dir, count] of summary.bySpace) console.log(`${dir}: ${count} notas`);
    console.log(
      `total: ${summary.notes} notas (${summary.published} publicadas, ${summary.drafts} sin publicar); ` +
        `${summary.pendientes} citas de pendiente (${summary.rawPlaceholders} campos del Word); ` +
        `salida en ${args.outDir}`
    );
  } catch (error) {
    console.error(error.message ?? error);
    process.exitCode = 1;
  }
}

export { convert, NOTES, SPACES };
