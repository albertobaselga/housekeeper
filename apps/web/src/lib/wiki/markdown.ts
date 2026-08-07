/**
 * Render Markdown mínimo y seguro, sin dependencias. No produce HTML: produce
 * una estructura de bloques que Svelte pinta con interpolación de texto (todo
 * queda escapado por construcción; no existe ningún `{@html}` en la wiki).
 *
 * Soporta: párrafos, encabezados (#), listas (-, *, 1.), **negrita**,
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
  | { kind: 'list'; ordered: boolean; items: WikiInline[][] };

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

export function parseWikiMarkdown(
  markdown: string,
  options: { wikiBasePath: string }
): WikiBlock[] {
  const { wikiBasePath } = options;
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: WikiBlock[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: WikiInline[][] } | null = null;

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

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line.trim() === '') {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({
        kind: 'heading',
        level: heading[1]!.length,
        inline: parseInline(heading[2]!, wikiBasePath)
      });
      continue;
    }
    const unordered = /^\s*[-*]\s+(.+)$/.exec(line);
    const ordered = unordered ? null : /^\s*\d+[.)]\s+(.+)$/.exec(line);
    if (unordered || ordered) {
      flushParagraph();
      const isOrdered = Boolean(ordered);
      if (!list || list.ordered !== isOrdered) {
        flushList();
        list = { ordered: isOrdered, items: [] };
      }
      list.items.push(parseInline((unordered ?? ordered)![1]!, wikiBasePath));
      continue;
    }
    flushList();
    paragraph.push(line.trim());
  }
  flushParagraph();
  flushList();
  return blocks;
}
