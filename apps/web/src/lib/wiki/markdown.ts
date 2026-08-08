/**
 * Render Markdown mínimo y seguro, sin dependencias. No produce HTML: produce
 * una estructura de bloques que Svelte pinta con interpolación de texto (todo
 * queda escapado por construcción; no existe ningún `{@html}` en la wiki).
 *
 * Soporta: párrafos, encabezados (#), listas (-, *, 1.), citas (>) para los
 * avisos del manual, tablas (| celda |) con fila separadora, **negrita**,
 * *cursiva*, `código` y enlaces [texto](destino). Los destinos `wiki:slug`
 * se resuelven a la ruta interna del hogar; solo se admiten además https?,
 * tel: y mailto:. Cualquier otro destino (javascript:, data:, HTML crudo…)
 * degrada a texto plano.
 */

export type WikiInline =
  | { kind: 'text'; text: string }
  | { kind: 'strong'; text: string }
  | { kind: 'em'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'link'; text: string; href: string; internal: boolean };

export type WikiBlock =
  | { kind: 'heading'; level: number; inline: WikiInline[] }
  | { kind: 'paragraph'; inline: WikiInline[] }
  | { kind: 'list'; ordered: boolean; items: WikiInline[][] }
  | { kind: 'quote'; lines: WikiInline[][] }
  | { kind: 'table'; header: WikiInline[][]; rows: WikiInline[][][] };

const WIKI_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function resolveHref(
  raw: string,
  wikiBasePath: string
): { href: string; internal: boolean } | null {
  if (raw.startsWith('wiki:')) {
    const slug = raw.slice('wiki:'.length).toLowerCase();
    if (WIKI_SLUG_PATTERN.test(slug)) return { href: `${wikiBasePath}/${slug}`, internal: true };
    return null;
  }
  if (/^https?:\/\/\S+$/i.test(raw)) return { href: raw, internal: false };
  if (/^tel:\+?[\d\s().-]{3,}$/i.test(raw)) return { href: raw, internal: false };
  if (/^mailto:[^\s@]+@[^\s@]+$/i.test(raw)) return { href: raw, internal: false };
  return null;
}

function parseEmphasis(text: string, out: WikiInline[]): void {
  const pattern = /\*\*([^*]+)\*\*|\*([^*]+)\*|_([^_]+)_|`([^`]+)`/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    if (match.index > last) out.push({ kind: 'text', text: text.slice(last, match.index) });
    if (match[1] !== undefined) out.push({ kind: 'strong', text: match[1] });
    else if (match[2] !== undefined) out.push({ kind: 'em', text: match[2] });
    else if (match[3] !== undefined) out.push({ kind: 'em', text: match[3] });
    else out.push({ kind: 'code', text: match[4]! });
    last = match.index + match[0].length;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
}

function parseInline(text: string, wikiBasePath: string): WikiInline[] {
  const out: WikiInline[] = [];
  const linkPattern = /\[([^\]]+)\]\(([^()\s]+)\)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = linkPattern.exec(text))) {
    if (match.index > last) parseEmphasis(text.slice(last, match.index), out);
    const resolved = resolveHref(match[2]!, wikiBasePath);
    if (resolved) out.push({ kind: 'link', text: match[1]!, href: resolved.href, internal: resolved.internal });
    else out.push({ kind: 'text', text: match[1]! });
    last = match.index + match[0].length;
  }
  if (last < text.length) parseEmphasis(text.slice(last), out);
  return out;
}

/** Fila de tabla `| a | b |` → celdas; una barra escapada `\|` no corta celda. */
function splitTableRow(line: string): string[] {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return inner
    .split(/(?<!\\)\|/)
    .map((cell) => cell.replaceAll('\\|', '|').trim());
}

function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.length > 2;
}

/** Fila separadora de cabecera: | --- | :--- | ---: | */
function isTableSeparator(line: string): boolean {
  return isTableRow(line) && splitTableRow(line).every((cell) => /^:?-{3,}:?$/.test(cell));
}

export function parseWikiMarkdown(
  markdown: string,
  options: { wikiBasePath: string }
): WikiBlock[] {
  const { wikiBasePath } = options;
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: WikiBlock[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: WikiInline[][] } | null = null;
  let quote: WikiInline[][] | null = null;
  let table: { header: WikiInline[][]; rows: WikiInline[][][] } | null = null;

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    blocks.push({ kind: 'paragraph', inline: parseInline(paragraph.join(' '), wikiBasePath) });
    paragraph = [];
  };
  const flushList = (): void => {
    if (!list) return;
    blocks.push({ kind: 'list', ordered: list.ordered, items: list.items });
    list = null;
  };
  const flushQuote = (): void => {
    if (!quote) return;
    blocks.push({ kind: 'quote', lines: quote });
    quote = null;
  };
  const flushTable = (): void => {
    if (!table) return;
    blocks.push({ kind: 'table', header: table.header, rows: table.rows });
    table = null;
  };
  const flushAll = (): void => {
    flushParagraph();
    flushList();
    flushQuote();
    flushTable();
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trimEnd();
    if (line.trim() === '') {
      flushAll();
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      flushAll();
      blocks.push({
        kind: 'heading',
        level: heading[1]!.length,
        inline: parseInline(heading[2]!, wikiBasePath)
      });
      continue;
    }
    // Tabla: fila de cabecera seguida de separadora, y filas mientras duren.
    if (table && isTableRow(line)) {
      table.rows.push(splitTableRow(line).map((cell) => parseInline(cell, wikiBasePath)));
      continue;
    }
    if (!table && isTableRow(line) && isTableSeparator(lines[index + 1] ?? '')) {
      flushAll();
      table = {
        header: splitTableRow(line).map((cell) => parseInline(cell, wikiBasePath)),
        rows: []
      };
      index += 1; // la fila separadora no produce contenido
      continue;
    }
    const quoted = /^\s*>\s?(.*)$/.exec(line);
    if (quoted) {
      flushParagraph();
      flushList();
      flushTable();
      quote ??= [];
      if (quoted[1]!.trim() !== '') quote.push(parseInline(quoted[1]!, wikiBasePath));
      continue;
    }
    const unordered = /^\s*[-*]\s+(.+)$/.exec(line);
    const ordered = unordered ? null : /^\s*\d+[.)]\s+(.+)$/.exec(line);
    if (unordered || ordered) {
      flushParagraph();
      flushQuote();
      flushTable();
      const isOrdered = Boolean(ordered);
      if (!list || list.ordered !== isOrdered) {
        flushList();
        list = { ordered: isOrdered, items: [] };
      }
      list.items.push(parseInline((unordered ?? ordered)![1]!, wikiBasePath));
      continue;
    }
    flushList();
    flushQuote();
    flushTable();
    paragraph.push(line.trim());
  }
  flushAll();
  return blocks;
}
