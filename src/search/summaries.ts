import { pool } from "../db/pool.js";
import { toSqlVector } from "../services/embeddings.js";
import { cachedQueryEmbedding } from "./vector.js";

export interface SummaryHit {
  key: string;
  level: "document" | "part" | "section";
  part: string | null;
  title: string;
  pageLabels: string[];
  text: string;
  similarity: number;
}

export async function searchSummaries(query: string, opts: { part?: string | null; k: number; include?: string[] }): Promise<SummaryHit[]> {
  const params: unknown[] = [toSqlVector(await cachedQueryEmbedding(query)), opts.k, opts.include ?? []];
  let partFilter = "";
  if (opts.part) {
    params.push(`%${opts.part}%`);
    partFilter = `AND s.part ILIKE $${params.length}`;
  }
  const { rows } = await pool.query(
    `(SELECT s.key, s.level, s.part, s.title, s.page_labels, s.text, 1 - (s.embedding <=> $1::vector) AS similarity
      FROM summaries s
      WHERE s.embedding IS NOT NULL ${partFilter}
      ORDER BY s.embedding <=> $1::vector
      LIMIT $2)
     UNION
     (SELECT s.key, s.level, s.part, s.title, s.page_labels, s.text, 1 - (s.embedding <=> $1::vector) AS similarity
      FROM summaries s
      WHERE s.key = ANY($3::text[]))
     ORDER BY similarity DESC`,
    params,
  );
  return rows.map((r) => ({
    key: r.key,
    level: r.level,
    part: r.part,
    title: r.title,
    pageLabels: r.page_labels,
    text: r.text,
    similarity: Number(Number(r.similarity).toFixed(4)),
  }));
}
