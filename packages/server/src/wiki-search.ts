import type { PoolClient } from "pg";

import type { UUID } from "@casa-clara/contracts";

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
