import type { CriticalSnapshotV1 } from '$lib/offline/schema';

/**
 * Búsqueda ligera sin conexión sobre el CriticalSnapshot guardado en este
 * dispositivo: páginas wiki (título > espacio > cuerpo) y contactos
 * accionables. Sin dependencias y determinista: la tolerancia a UNA errata se
 * resuelve con trigramas propios equivalentes a pg_trgm (relleno '  x ').
 */

export interface OfflineSearchResult {
  id: string;
  kind: 'wiki' | 'contact';
  title: string;
  /** Espacio de la wiki o tipo de contacto. */
  detail: string;
  /** Ventana del cuerpo alrededor de la coincidencia, o el teléfono. */
  excerpt: string;
  /** Solo contactos: teléfono listo para tel: (accionable). */
  phone: string | null;
  score: number;
}

interface SnapshotWikiPage {
  id: string;
  title: string;
  space: string;
  body: string;
}

interface SnapshotContact {
  id: string;
  name: string;
  phone: string;
  kind: string;
}

function isWikiPage(value: unknown): value is SnapshotWikiPage {
  if (!value || typeof value !== 'object') return false;
  const page = value as Partial<SnapshotWikiPage>;
  return (
    typeof page.id === 'string' &&
    typeof page.title === 'string' &&
    typeof page.space === 'string' &&
    typeof page.body === 'string'
  );
}

function isContact(value: unknown): value is SnapshotContact {
  if (!value || typeof value !== 'object') return false;
  const contact = value as Partial<SnapshotContact>;
  return (
    typeof contact.id === 'string' &&
    typeof contact.name === 'string' &&
    typeof contact.phone === 'string' &&
    typeof contact.kind === 'string'
  );
}

/** Minúsculas y sin acentos, igual que app.unaccent_es en el servidor. */
export function foldText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

function words(value: string): string[] {
  return foldText(value)
    .split(/[^a-z0-9ñç]+/u)
    .filter(Boolean);
}

/** Trigramas por palabra con relleno '  x ' (dos espacios delante, uno detrás), como pg_trgm. */
function trigramSet(value: string): Set<string> {
  const trigrams = new Set<string>();
  for (const word of words(value)) {
    const padded = `  ${word} `;
    for (let index = 0; index + 3 <= padded.length; index += 1) {
      trigrams.add(padded.slice(index, index + 3));
    }
  }
  return trigrams;
}

function trigramSimilarity(left: string, right: string): number {
  const a = trigramSet(left);
  const b = trigramSet(right);
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const trigram of a) if (b.has(trigram)) shared += 1;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

/** Umbral que absorbe una errata ('lavadra' ~ 'lavadora' ≈ 0.55) sin traer ruido. */
const TYPO_THRESHOLD = 0.45;

const TITLE_WEIGHT = 3;
const DETAIL_WEIGHT = 2;
const BODY_WEIGHT = 1;

interface FieldSet {
  title: string;
  detail: string;
  body: string;
}

interface FieldScore {
  score: number;
  bodyMatchIndex: number;
}

/**
 * Puntúa un elemento contra los tokens de la consulta. Cada token debe casar
 * en algún campo (inclusión en título > detalle > cuerpo); como red de
 * seguridad se admite UNA sola errata por elemento, resuelta por similitud de
 * trigramas contra las palabras de título y detalle. Devuelve null si algún
 * token no casa de ninguna forma.
 */
function scoreFields(tokens: string[], fields: FieldSet): FieldScore | null {
  const title = foldText(fields.title);
  const detail = foldText(fields.detail);
  const body = foldText(fields.body);
  const fuzzyCandidates = [...words(fields.title), ...words(fields.detail)];

  let score = 0;
  let bodyMatchIndex = -1;
  let typoUsed = false;

  for (const token of tokens) {
    if (title.includes(token)) {
      score += TITLE_WEIGHT;
      continue;
    }
    if (detail.includes(token)) {
      score += DETAIL_WEIGHT;
      continue;
    }
    const inBody = body.indexOf(token);
    if (inBody >= 0) {
      score += BODY_WEIGHT;
      if (bodyMatchIndex < 0) bodyMatchIndex = inBody;
      continue;
    }
    if (!typoUsed) {
      let best = 0;
      for (const word of fuzzyCandidates) {
        const similarity = trigramSimilarity(token, word);
        if (similarity > best) best = similarity;
      }
      if (best > TYPO_THRESHOLD) {
        typoUsed = true;
        score += TITLE_WEIGHT * best;
        continue;
      }
    }
    return null;
  }

  return { score, bodyMatchIndex };
}

/** Ventana de extracto alrededor de la primera coincidencia en el cuerpo. */
function excerptWindow(body: string, matchIndex: number, span = 140): string {
  const text = body.trim();
  if (!text) return '';
  if (matchIndex < 0) return text.length <= span ? text : `${text.slice(0, span).trimEnd()}…`;
  const start = Math.max(0, matchIndex - Math.floor(span / 3));
  const end = Math.min(text.length, start + span);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return `${prefix}${text.slice(start, end).trim()}${suffix}`;
}

const RESULT_LIMIT = 12;

/**
 * Busca en el snapshot crítico guardado en el dispositivo. Sin snapshot o sin
 * consulta devuelve lista vacía, nunca lanza: es la vía de emergencia offline.
 */
export function searchOffline(
  query: string,
  snapshot: Pick<CriticalSnapshotV1, 'payload'> | null | undefined
): OfflineSearchResult[] {
  const tokens = words(query);
  if (!tokens.length || !snapshot?.payload) return [];

  const results: OfflineSearchResult[] = [];

  const wikiPages = Array.isArray(snapshot.payload.wikiPages) ? snapshot.payload.wikiPages : [];
  for (const raw of wikiPages) {
    if (!isWikiPage(raw)) continue;
    const scored = scoreFields(tokens, { title: raw.title, detail: raw.space, body: raw.body });
    if (!scored) continue;
    results.push({
      id: raw.id,
      kind: 'wiki',
      title: raw.title,
      detail: raw.space,
      excerpt: excerptWindow(raw.body, scored.bodyMatchIndex),
      phone: null,
      score: scored.score
    });
  }

  const contacts = Array.isArray(snapshot.payload.contacts) ? snapshot.payload.contacts : [];
  for (const raw of contacts) {
    if (!isContact(raw)) continue;
    const scored = scoreFields(tokens, { title: raw.name, detail: raw.kind, body: '' });
    if (!scored) continue;
    results.push({
      id: raw.id,
      kind: 'contact',
      title: raw.name,
      detail: raw.kind,
      excerpt: raw.phone,
      phone: raw.phone,
      score: scored.score
    });
  }

  return results
    .sort(
      (left, right) =>
        right.score - left.score ||
        (foldText(left.title) < foldText(right.title) ? -1 : foldText(left.title) > foldText(right.title) ? 1 : 0)
    )
    .slice(0, RESULT_LIMIT);
}
