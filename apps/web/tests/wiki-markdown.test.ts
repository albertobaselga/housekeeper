import { describe, expect, it } from 'vitest';

import { parseWikiMarkdown, type WikiInline } from '../src/lib/wiki/markdown';

const BASE = '/h/10000000-0000-4000-8000-000000000001/wiki';

function flatten(inline: WikiInline[]): string {
  return inline.map((part) => part.text).join('');
}

describe('render Markdown propio: estructura sin HTML', () => {
  it('separa párrafos, encabezados y listas', () => {
    const blocks = parseWikiMarkdown(
      '# Lavadora\n\nPrimera línea\nsigue el párrafo.\n\n- uno\n- dos\n\n1. primero\n2. segundo',
      { wikiBasePath: BASE }
    );
    expect(blocks.map((block) => block.kind)).toEqual(['heading', 'paragraph', 'list', 'list']);
    expect(blocks[0]).toMatchObject({ kind: 'heading', level: 1 });
    expect(flatten((blocks[1] as { inline: WikiInline[] }).inline)).toBe('Primera línea sigue el párrafo.');
    const [unordered, ordered] = blocks.slice(2) as Array<{ ordered: boolean; items: WikiInline[][] }>;
    expect(unordered.ordered).toBe(false);
    expect(unordered.items.map(flatten)).toEqual(['uno', 'dos']);
    expect(ordered.ordered).toBe(true);
    expect(ordered.items.map(flatten)).toEqual(['primero', 'segundo']);
  });

  it('el HTML crudo nunca se interpreta: queda como texto plano', () => {
    const blocks = parseWikiMarkdown('<script>alert(1)</script> y <b>negrita</b>', {
      wikiBasePath: BASE
    });
    expect(blocks).toHaveLength(1);
    const paragraph = blocks[0] as { inline: WikiInline[] };
    // Todos los fragmentos son texto: no hay ningún nodo que produzca HTML.
    expect(paragraph.inline.every((part) => part.kind === 'text')).toBe(true);
    expect(flatten(paragraph.inline)).toBe('<script>alert(1)</script> y <b>negrita</b>');
  });

  it('resuelve enlaces wiki: al slug dentro del hogar', () => {
    const blocks = parseWikiMarkdown('Mira [la lavadora](wiki:lavadora) antes.', {
      wikiBasePath: BASE
    });
    const paragraph = blocks[0] as { inline: WikiInline[] };
    const link = paragraph.inline.find((part) => part.kind === 'link');
    expect(link).toMatchObject({
      kind: 'link',
      text: 'la lavadora',
      href: `${BASE}/lavadora`,
      internal: true
    });
  });

  it('degrada a texto los destinos peligrosos y los slugs inválidos', () => {
    const blocks = parseWikiMarkdown(
      '[malo](javascript:alert(1)) [datos](data:text/html;x) [roto](wiki:No_Valido)',
      { wikiBasePath: BASE }
    );
    const paragraph = blocks[0] as { inline: WikiInline[] };
    expect(paragraph.inline.some((part) => part.kind === 'link')).toBe(false);
    expect(flatten(paragraph.inline)).toContain('malo');
    expect(flatten(paragraph.inline)).toContain('datos');
    expect(flatten(paragraph.inline)).toContain('roto');
  });

  it('admite https, tel y mailto además de negrita, cursiva y código', () => {
    const blocks = parseWikiMarkdown(
      '**Fuerte** y *suave* con `codigo`, [web](https://example.org/x) y [tel](tel:+34600000122)',
      { wikiBasePath: BASE }
    );
    const paragraph = blocks[0] as { inline: WikiInline[] };
    const kinds = paragraph.inline.map((part) => part.kind);
    expect(kinds).toContain('strong');
    expect(kinds).toContain('em');
    expect(kinds).toContain('code');
    const links = paragraph.inline.filter((part) => part.kind === 'link');
    expect(links.map((link) => (link as { href: string }).href)).toEqual([
      'https://example.org/x',
      'tel:+34600000122'
    ]);
    expect(links.every((link) => (link as { internal: boolean }).internal === false)).toBe(true);
  });
});
