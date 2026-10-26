import { pool } from "../db/pool.js";
import { filterSql, type SearchFilters } from "./vector.js";

export interface RankedId {
  id: string;
  score: number;
  matched?: string[];
}

const BM25_K1 = 1.2;
const BM25_B = 0.75;

const COUNTRY_ALIASES: Record<string, string> = {
  turkey: "Türkiye",
  turkiye: "Türkiye",
  vietnam: "Viet Nam",
  russia: "Russian Federation",
  iran: "Iran, Islamic Rep.",
  egypt: "Egypt, Arab Rep.",
  laos: "Lao PDR",
  "south korea": "Korea, Rep.",
  korea: "Korea, Rep.",
  "ivory coast": "Côte d'Ivoire",
  "cote d'ivoire": "Côte d'Ivoire",
  uk: "United Kingdom",
  usa: "United States",
};

let glossaryCache: Promise<Record<string, string>> | null = null;

function loadGlossary(): Promise<Record<string, string>> {
  glossaryCache ??= pool
    .query<{ glossary: Record<string, string> }>(`SELECT glossary FROM documents ORDER BY id LIMIT 1`)
    .then((r) => r.rows[0]?.glossary ?? {});
  return glossaryCache;
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export async function expandQuery(query: string): Promise<string> {
  const additions = new Set<string>();
  const lower = query.toLowerCase();

  for (const [abbr, meaning] of Object.entries(await loadGlossary())) {
    const base = abbr.replace(/(?<=[A-Z])s$/, "");
    if (new RegExp(`\\b${escapeRegex(base)}s?\\b`).test(query)) additions.add(meaning);
    else if (lower.includes(meaning.toLowerCase())) additions.add(abbr);
  }
  for (const [alias, name] of Object.entries(COUNTRY_ALIASES)) {
    if (new RegExp(`\\b${escapeRegex(alias)}\\b`, "i").test(query)) additions.add(name);
  }
  return additions.size ? `${query} ${[...additions].join(" ")}` : query;
}

// Postgres ts_rank has no notion of term rarity, so "growth" would outweigh "Nigeria"; BM25 adds IDF and length normalization.
export async function keywordSearch(query: string, k: number, filters?: SearchFilters): Promise<RankedId[]> {
  const params: unknown[] = [query];
  const where = filterSql(filters, params).join(" AND ");
  params.push(k);
  const limit = `$${params.length}`;

  const { rows } = await pool.query<{ id: string; score: number; matched: string[] }>(
    `WITH terms AS (
       SELECT DISTINCT lexeme FROM unnest(to_tsvector('english', $1))
     ),
     q AS (
       SELECT string_agg(quote_literal(lexeme), ' | ')::tsquery AS query FROM terms
     ),
     corpus AS (
       SELECT count(*)::float AS n, avg(length(c.tsv))::float AS avglen FROM chunks c WHERE ${where}
     ),
     df AS (
       SELECT u.lexeme, count(*)::float AS df
       FROM chunks c, unnest(c.tsv) u
       WHERE u.lexeme IN (SELECT lexeme FROM terms) AND ${where}
       GROUP BY u.lexeme
     ),
     matched AS (
       SELECT c.id, length(c.tsv)::float AS len, u.lexeme,
              cardinality(u.positions) + (SELECT count(*) FROM unnest(u.weights) w WHERE w = 'A') AS tf
       FROM chunks c, q, unnest(c.tsv) u
       WHERE c.tsv @@ q.query AND u.lexeme IN (SELECT lexeme FROM terms) AND ${where}
     )
     SELECT m.id::text AS id,
            sum(ln(1 + (s.n - d.df + 0.5) / (d.df + 0.5))
                * m.tf * ${BM25_K1 + 1} / (m.tf + ${BM25_K1} * (1 - ${BM25_B} + ${BM25_B} * m.len / s.avglen))) AS score,
            array_agg(m.lexeme ORDER BY m.lexeme) AS matched
     FROM matched m JOIN df d USING (lexeme) CROSS JOIN corpus s
     GROUP BY m.id
     ORDER BY score DESC
     LIMIT ${limit}`,
    params,
  );
  return rows.map((r) => ({ id: r.id, score: Number(r.score), matched: r.matched }));
}

const EXHIBIT_REF = /\b(table|figure|fig\.?|box)\s+([A-Z]?\d+(?:\.\d+)*)/gi;

export async function exhibitSearch(query: string, filters?: SearchFilters): Promise<RankedId[]> {
  const refs = [...query.matchAll(EXHIBIT_REF)].map((m) => ({
    kind: m[1]!.toLowerCase().startsWith("fig") ? "figure" : m[1]!.toLowerCase(),
    number: m[2]!.replace(/\.$/, ""),
  }));
  if (!refs.length) return [];

  const ids: RankedId[] = [];
  for (const ref of refs) {
    const params: unknown[] = [];
    const where = filterSql(filters, params);
    params.push(ref.number);
    if (ref.kind === "box") {
      where.push(`c.context ILIKE '%Box ' || $${params.length} || ':%'`);
    } else {
      where.push(`c.exhibit = $${params.length}`);
      params.push(ref.kind);
      where.push(`c.type = $${params.length}`);
    }
    const { rows } = await pool.query<{ id: string }>(
      `SELECT c.id::text AS id FROM chunks c WHERE ${where.join(" AND ")} ORDER BY c.ordinal LIMIT 10`,
      params,
    );
    ids.push(...rows.map((r) => ({ id: r.id, score: 1 })));
  }
  return ids;
}
