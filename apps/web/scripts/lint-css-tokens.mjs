// Guardián de las dos escalas.
//
// Housekeeper no tenía sistema: tenía 529 reglas acumuladas. `app.css` declaraba
// 33 tokens —23 de color, 4 de radio, 3 de sombra, 3 de layout— y CERO de
// espaciado y CERO de tipografía. Los dos ejes que deciden la densidad en un
// teléfono eran exactamente los dos que nadie había tokenizado, así que cada
// componente inventó los suyos: 40 valores distintos de espaciado y 39 tamaños
// de letra, 21 de ellos por debajo de 14 px con saltos de 0,16 px. Y como nada
// estaba tokenizado, ningún punto de ruptura podía cambiar la densidad.
//
// Este script existe para que eso no pueda volver sin que salte algo:
//
//   L1 — ningún valor de longitud a pelo en `gap`, `padding`, `margin`,
//        `border-radius` ni `font-size` fuera de `:root`: todo resuelve a
//        `--space-*`, `--r-*` o `--text-*`.
//   L2 — ningún `font-weight` fuera de 400/500/700, y ningún color literal
//        fuera de `:root`.
//
// Cubre `src/app.css` y los bloques `<style>` de los `.svelte`, que es donde
// vive el resto del CSS del producto.

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = fileURLToPath(new URL('../', import.meta.url));
const srcRoot = path.join(webRoot, 'src');

/** Propiedades cuyo valor DEBE salir de la escala. */
const SCALED = /^(gap|row-gap|column-gap|margin|margin-(top|right|bottom|left|inline|block)(-(start|end))?|padding|padding-(top|right|bottom|left|inline|block)(-(start|end))?|border-radius|font-size)$/;

/**
 * Valores que no son «un número inventado» y por tanto no infringen L1.
 *
 * - `1rem` en `font-size` es el suelo de 16 px contra el zoom automático de
 *   iOS al enfocar un control: lo conserva la especificación de forma
 *   explícita («las reglas de componente pueden subirlo, nunca bajarlo»).
 * - Las medidas de una CAJA que no es espaciado (el ancho de un campo
 *   numérico, el alto de una barra de progreso) van por `width`/`height` y ni
 *   siquiera entran aquí.
 */
const ALLOWED_LITERALS = new Set([
  '0', 'auto', 'inherit', 'initial', 'unset', 'revert', 'none', '100%', '0px',
  // El suelo de 16 px contra el zoom de iOS, en sus dos formas.
  '1rem', 'max(1em,1rem)',
  // Tamaños RELATIVOS al texto que ya salió de la escala: un `code` dentro de
  // un párrafo o el triángulo de un `summary` se dimensionan contra su padre,
  // no contra la escala, y por eso no la infringen.
  '1em', '.85em', '.7em'
]);

/** Un valor está bien si cada uno de sus términos es token, cero o palabra clave. */
function violatesL1(property, value) {
  if (!SCALED.test(property)) return false;
  // `max(1em, 1rem)` es UN término, no dos: sin esto el corte por espacios
  // partiría toda función en trozos que no significan nada.
  const compact = value.replace(/\(\s*([^()]*)\s*\)/g, (_, inner) => `(${inner.replace(/\s+/g, '')})`);
  const cleaned = compact.replace(/var\(--[a-z0-9-]+(?:,[^)]*)?\)/g, ' TOKEN ');
  const terms = cleaned.split(/\s+/).filter(Boolean);
  for (const term of terms) {
    if (term === 'TOKEN') continue;
    if (ALLOWED_LITERALS.has(term)) continue;
    // `calc(...)`, `max(...)`, `min(...)`, `clamp(...)` y `env(...)` ya vienen
    // con sus var() sustituidas por TOKEN; si aún les queda una longitud
    // desnuda dentro, cae en el mismo cedazo.
    if (/^(calc|max|min|clamp|env)\(/.test(term) && !/\d+(\.\d+)?(rem|em|px|vw|vh)/.test(term)) continue;
    if (/^-?\d*\.?\d+(rem|em|px|vw|vh|ch)$/.test(term)) return `«${term}» no sale de ninguna escala`;
    if (/\d+(\.\d+)?(rem|em|px)/.test(term)) return `«${term}» lleva una longitud a pelo`;
  }
  return false;
}

const ALLOWED_WEIGHTS = new Set(['400', '500', '700', 'inherit', 'normal', 'bold']);
const LITERAL_COLOR = /(#[0-9a-fA-F]{3,8}\b|\brgba?\([^)]*\)|\bhsla?\([^)]*\)|\bwhite\b|\bblack\b)/;

/** Propiedades donde un color literal es de verdad un color de marca. */
const COLOR_PROPERTIES = /^(color|background|background-color|border(-(top|right|bottom|left))?-color|fill|stroke|accent-color|caret-color|outline-color)$/;

function violatesL2(property, value) {
  if (property === 'font-weight' && !ALLOWED_WEIGHTS.has(value.trim())) {
    return `peso ${value.trim()}: solo existen 400, 500 y 700`;
  }
  if (COLOR_PROPERTIES.test(property) && LITERAL_COLOR.test(value) && !value.includes('var(--')) {
    return `color literal «${value.trim()}»: debe salir de :root`;
  }
  return false;
}

/**
 * Recorre declaraciones CSS anotando en qué selector están. No es un parser
 * completo: le basta con saber si el bloque actual es `:root`, `@font-face` o
 * cualquier otra cosa, que es lo único que cambia la regla.
 */
function* declarations(css) {
  const stack = [];
  let index = 0;
  let buffer = '';
  let line = 1;
  const startLine = () => line;
  while (index < css.length) {
    const character = css[index];
    if (character === '\n') line += 1;
    if (css.startsWith('/*', index)) {
      const end = css.indexOf('*/', index + 2);
      const skipped = css.slice(index, end === -1 ? css.length : end + 2);
      line += (skipped.match(/\n/g) ?? []).length;
      index = end === -1 ? css.length : end + 2;
      buffer = '';
      continue;
    }
    if (character === '{') {
      stack.push(buffer.trim());
      buffer = '';
      index += 1;
      continue;
    }
    if (character === '}') {
      stack.pop();
      buffer = '';
      index += 1;
      continue;
    }
    if (character === ';') {
      const declaration = buffer.trim();
      buffer = '';
      index += 1;
      const split = declaration.indexOf(':');
      if (split > 0) {
        yield {
          property: declaration.slice(0, split).trim(),
          value: declaration.slice(split + 1).trim(),
          selector: stack[stack.length - 1] ?? '',
          scope: stack.join(' / '),
          line: startLine()
        };
      }
      continue;
    }
    buffer += character;
    index += 1;
  }
}

async function cssSources() {
  const sources = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.css')) sources.push({ file: full, css: await readFile(full, 'utf8') });
      else if (entry.name.endsWith('.svelte')) {
        const text = await readFile(full, 'utf8');
        const match = text.match(/<style[^>]*>([\s\S]*?)<\/style>/);
        if (match) sources.push({ file: full, css: match[1], offset: text.slice(0, match.index).split('\n').length - 1 });
      }
    }
  };
  await walk(srcRoot);
  return sources;
}

const findings = [];
for (const { file, css, offset = 0 } of await cssSources()) {
  for (const declaration of declarations(css)) {
    // `:root` es donde viven las escalas: es el único sitio donde una longitud
    // desnuda o un color literal significan algo. `@font-face` tampoco cuenta.
    const inRoot = /(^|,)\s*:root\b/.test(declaration.selector) || declaration.scope.includes('@font-face');
    if (inRoot) continue;
    const l1 = violatesL1(declaration.property, declaration.value);
    if (l1) findings.push({ file, line: declaration.line + offset, rule: 'L1', property: declaration.property, detail: l1, selector: declaration.selector });
    const l2 = violatesL2(declaration.property, declaration.value);
    if (l2) findings.push({ file, line: declaration.line + offset, rule: 'L2', property: declaration.property, detail: l2, selector: declaration.selector });
  }
}

if (findings.length > 0) {
  const relative = (file) => path.relative(webRoot, file);
  const lines = findings
    .slice(0, 400)
    .map((f) => `  ${f.rule}  ${relative(f.file)}:${f.line}  ${f.selector} { ${f.property} }  ${f.detail}`);
  console.error(
    `Las dos escalas tienen ${findings.length} fuga${findings.length === 1 ? '' : 's'}:\n${lines.join('\n')}` +
      (findings.length > 400 ? `\n  … y ${findings.length - 400} más` : '') +
      '\n\nToda longitud sale de --space-* / --r-* / --text-*, todo peso de 400/500/700\n' +
      'y todo color de :root. Si de verdad hace falta un valor nuevo, se añade a\n' +
      'la escala en :root y se usa desde ahí: es lo que permite que un punto de\n' +
      'ruptura cambie la densidad de la aplicación entera.'
  );
  process.exit(1);
}

console.log('Escalas de espaciado y tipografía: sin fugas.');
