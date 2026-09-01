import type { PoolClient } from "pg";

import type { UUID } from "@housekeeper/contracts";

export interface WikiSearchResult {
  id: UUID;
  title: string;
  slug: string;
  spaceSlug: string;
  excerpt: string;
  score: number;
}

/**
 * Búsqueda sobre la revisión vigente de las páginas visibles (RLS decide qué
 * ve cada rol: helper solo publicado, familia y empleada también borradores; el
 * hogar lo acota `tenant_context_matches`, así que aquí no viaja household_id).
 *
 * Ranking en dos capas complementarias:
 * - `ts_rank_cd` sobre `search_document` (título y aliases con peso A, tags B,
 *   cuerpo C) con `websearch_to_tsquery('spanish', unaccent(q))` — cubre las
 *   consultas bien escritas y los sinónimos declarados como alias (AC-17:
 *   'vitro' encuentra la placa porque es alias con peso A).
 * - Trigram como refuerzo y red de seguridad para erratas que el stemmer
 *   español no absorbe: `word_similarity` contra el título (tolera títulos
 *   largos buscando la mejor subcadena) y `similarity` contra cada alias.
 *   Así 'lavadra' alcanza 'Lavadora · programa corto' vía el alias 'lavadora'
 *   aunque el FTS no matchee (AC-16).
 * El score suma ambas señales; el umbral 0.3 de pg_trgm filtra ruido.
 */
export async function searchWiki(
  client: PoolClient,
  query: string,
  limit = 10,
): Promise<WikiSearchResult[]> {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];

  const result = await client.query<{
    id: string;
    title: string;
    slug: string;
    space_slug: string;
    excerpt: string;
    score: number;
  }>(
    `with input as (
       select websearch_to_tsquery('spanish', app.unaccent_es($1)) as tsq,
              app.unaccent_es($1) as qtext
     )
     select p.id,
            r.title,
            p.current_slug as slug,
            s.slug as space_slug,
            case
              when r.search_document @@ i.tsq then
                ts_headline('spanish', app.unaccent_es(r.body_markdown), i.tsq,
                            'MaxFragments=1, MaxWords=25, MinWords=8')
              else left(btrim(r.body_markdown), 160)
            end as excerpt,
            (ts_rank_cd(r.search_document, i.tsq)
             + 0.8 * greatest(
                 word_similarity(i.qtext, app.unaccent_es(r.title)),
                 coalesce((select max(similarity(app.unaccent_es(alias), i.qtext))
                             from unnest(r.aliases) as alias), 0)
               ))::float8 as score
       from app.wiki_pages as p
       join app.wiki_revisions as r
         on r.household_id = p.household_id and r.id = p.current_revision_id
       join app.wiki_spaces as s
         on s.household_id = p.household_id and s.id = p.space_id
      cross join input as i
      where p.archived_at is null
        and (
          r.search_document @@ i.tsq
          or word_similarity(i.qtext, app.unaccent_es(r.title)) >= 0.3
          or exists (
            select 1 from unnest(r.aliases) as alias
             where similarity(app.unaccent_es(alias), i.qtext) >= 0.3
          )
        )
      order by score desc, r.title asc
      limit $2`,
    [trimmed, limit],
  );

  return result.rows.map((row) => ({
    id: row.id,
    title: row.title,
    slug: row.slug,
    spaceSlug: row.space_slug,
    excerpt: row.excerpt,
    score: Number(row.score),
  }));
}

/**
 * Registra el resultado de una búsqueda para la detección de huecos (AC-18):
 * agregado por hogar, consulta normalizada y día — nunca quién buscó. Con
 * `hadResults = false` incrementa `miss_count`; con `true`, `no_click_count`.
 */
export async function recordSearchOutcome(
  client: PoolClient,
  query: string,
  hadResults: boolean,
): Promise<void> {
  await client.query("select app.record_search_gap($1, $2)", [query, hadResults]);
}

/** Incrementa el contador de lecturas del día para la página (AC-20, sin identidad). */
export async function recordWikiRead(client: PoolClient, pageId: UUID): Promise<void> {
  await client.query("select app.record_wiki_read($1)", [pageId]);
}

export interface SearchGapCluster {
  /** Consulta de más peso del cluster; da nombre al hueco. */
  representative: string;
  /** Todas las consultas equivalentes, representante incluida, por peso desc. */
  variants: string[];
  missTotal: number;
  noClickTotal: number;
  /** Último día (YYYY-MM-DD) en que alguien tropezó con el hueco. */
  lastSeenOn: string;
}

/**
 * Trigramas al estilo pg_trgm: cada palabra alfanumérica se rellena con dos
 * espacios delante y uno detrás y se trocea en ventanas de tres caracteres.
 * Las consultas ya llegan normalizadas (minúsculas y sin acentos) desde
 * app.record_search_gap; la normalización de aquí es solo defensiva.
 */
function trigramSet(value: string): Set<string> {
  const trigrams = new Set<string>();
  const words = value.toLowerCase().split(/[^a-z0-9ñç]+/u).filter(Boolean);
  for (const word of words) {
    const padded = `  ${word} `;
    for (let index = 0; index + 3 <= padded.length; index += 1) {
      trigrams.add(padded.slice(index, index + 3));
    }
  }
  return trigrams;
}

/** Similitud de Jaccard entre conjuntos de trigramas, equivalente a similarity() de pg_trgm. */
export function trigramSimilarity(left: string, right: string): number {
  const a = trigramSet(left);
  const b = trigramSet(right);
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const trigram of a) if (b.has(trigram)) shared += 1;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

const GAP_CLUSTER_THRESHOLD = 0.55;

/**
 * Huecos documentales agregados (AC-18): agrupa las consultas registradas en
 * app.search_gap_events durante los últimos `days` días en clusters de
 * variantes equivalentes ('robot cocina' ≈ 'robot de cocina' ≈ 'robot cozina').
 *
 * Agrupación determinista greedy: las consultas se ordenan por peso
 * (miss+no_click) descendente y alfabético como desempate; cada una se asigna
 * al primer cluster cuyo REPRESENTANTE supere similarity > 0.55 (trigramas
 * equivalentes a pg_trgm) y, si ninguno lo supera, abre cluster nuevo. Con los
 * mismos datos el resultado es idéntico llamada tras llamada.
 *
 * RLS decide la visibilidad: solo family_admin/family_member ven filas de
 * search_gap_events, así que cualquier otro rol recibe una lista vacía.
 */
export async function listSearchGapClusters(
  client: PoolClient,
  options: { days?: number; limit?: number } = {},
): Promise<SearchGapCluster[]> {
  const days = Math.max(1, Math.trunc(options.days ?? 30));
  const limit = Math.max(1, Math.trunc(options.limit ?? 10));

  const result = await client.query<{
    query: string;
    missTotal: number;
    noClickTotal: number;
    lastSeenOn: string;
  }>(
    `select query_normalized as "query",
            sum(miss_count)::int as "missTotal",
            sum(no_click_count)::int as "noClickTotal",
            max(occurred_on)::text as "lastSeenOn"
       from app.search_gap_events
      where occurred_on >= current_date - ($1::int - 1)
      group by query_normalized
      order by (sum(miss_count) + sum(no_click_count)) desc, query_normalized asc`,
    [days],
  );

  const clusters: SearchGapCluster[] = [];
  for (const row of result.rows) {
    const cluster = clusters.find(
      (candidate) => trigramSimilarity(candidate.representative, row.query) > GAP_CLUSTER_THRESHOLD,
    );
    if (cluster) {
      cluster.variants.push(row.query);
      cluster.missTotal += row.missTotal;
      cluster.noClickTotal += row.noClickTotal;
      if (row.lastSeenOn > cluster.lastSeenOn) cluster.lastSeenOn = row.lastSeenOn;
    } else {
      clusters.push({
        representative: row.query,
        variants: [row.query],
        missTotal: row.missTotal,
        noClickTotal: row.noClickTotal,
        lastSeenOn: row.lastSeenOn,
      });
    }
  }

  return clusters
    .sort(
      (left, right) =>
        right.missTotal + right.noClickTotal - (left.missTotal + left.noClickTotal) ||
        left.representative.localeCompare(right.representative),
    )
    .slice(0, limit);
}
