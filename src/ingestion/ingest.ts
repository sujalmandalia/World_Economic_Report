import { createHash } from "node:crypto";
import type pg from "pg";
import { embeddingText, estimateTokens } from "../chunking/chunk.js";
import type { ChunkSet } from "../chunking/types.js";
import { config } from "../config.js";
import { pool, withTransaction } from "../db/pool.js";
import { embedTexts, toSqlVector, type TokenRateLimiter } from "../services/embeddings.js";
import type { DocumentStructure } from "../structure/types.js";

export const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

export interface SyncInput {
  source: string;
  title: string;
  fileHash: string;
  structure: DocumentStructure;
  chunkSet: ChunkSet;
}

export interface SyncResult {
  documentId: number;
  inserted: number;
  kept: number;
  deleted: number;
  duplicates: number;
  modelChanged: boolean;
}

async function assertVectorColumn(client: pg.PoolClient) {
  const { rows } = await client.query<{ dims: number }>(
    `SELECT atttypmod AS dims FROM pg_attribute WHERE attrelid = 'chunks'::regclass AND attname = 'embedding'`,
  );
  const dims = rows[0]?.dims;
  if (dims !== config.gemini.embeddingDimensions) {
    throw new Error(`chunks.embedding is vector(${dims}) but EMBEDDING_DIMENSIONS=${config.gemini.embeddingDimensions}.`);
  }
}

export async function syncDocument(input: SyncInput): Promise<SyncResult> {
  const { embeddingModel, embeddingDimensions } = config.gemini;
  const { structure, chunkSet } = input;

  const seen = new Set<string>();
  let duplicates = 0;
  const rows = chunkSet.chunks.flatMap((c, ordinal) => {
    const content_hash = sha256(embeddingText(c));
    if (seen.has(content_hash)) {
      duplicates++;
      return [];
    }
    seen.add(content_hash);
    return [{
      content_hash,
      key: c.id,
      ordinal,
      parent_key: c.parentId,
      type: c.type,
      part: c.part,
      section_path: c.sectionPath,
      box: c.box,
      exhibit: c.exhibit,
      pdf_pages: c.pdfPages,
      page_labels: c.pageLabels,
      context: c.context,
      text: c.text,
      tokens: c.tokens,
    }];
  });
  const parents = chunkSet.parents.map((p) => ({
    key: p.id,
    part: p.part,
    section_path: p.sectionPath,
    box: p.box,
    pdf_pages: p.pdfPages,
    page_labels: p.pageLabels,
    text: p.text,
    tokens: p.tokens,
  }));

  return withTransaction(async (client) => {
    await assertVectorColumn(client);

    const previous = await client.query<{ id: number; embedding_model: string; embedding_dims: number }>(
      `SELECT id, embedding_model, embedding_dims FROM documents WHERE source = $1`,
      [input.source],
    );
    const old = previous.rows[0];
    const modelChanged = !!old && (old.embedding_model !== embeddingModel || old.embedding_dims !== embeddingDimensions);

    const doc = await client.query<{ id: number }>(
      `INSERT INTO documents (source, file_hash, title, page_count, glossary, chunk_options, embedding_model, embedding_dims)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (source) DO UPDATE SET
         file_hash = EXCLUDED.file_hash, title = EXCLUDED.title, page_count = EXCLUDED.page_count,
         glossary = EXCLUDED.glossary, chunk_options = EXCLUDED.chunk_options,
         embedding_model = EXCLUDED.embedding_model, embedding_dims = EXCLUDED.embedding_dims, updated_at = now()
       RETURNING id`,
      [
        input.source,
        input.fileHash,
        input.title,
        Math.max(...structure.parts.map((p) => p.endPdfPage)),
        structure.glossary,
        chunkSet.options,
        embeddingModel,
        embeddingDimensions,
      ],
    );
    const documentId = doc.rows[0]!.id;

    if (modelChanged) {
      await client.query(`UPDATE chunks SET embedding = NULL, embedded_at = NULL WHERE document_id = $1`, [documentId]);
    }

    await client.query(`DELETE FROM parents WHERE document_id = $1`, [documentId]);
    await client.query(
      `INSERT INTO parents (document_id, key, part, section_path, box, pdf_pages, page_labels, text, tokens)
       SELECT $1, x.key, x.part, x.section_path, x.box, x.pdf_pages, x.page_labels, x.text, x.tokens
       FROM jsonb_to_recordset($2) AS x(key text, part text, section_path text[], box text,
                                       pdf_pages int[], page_labels text[], text text, tokens int)`,
      [documentId, JSON.stringify(parents)],
    );

    const deleted = await client.query(
      `DELETE FROM chunks WHERE document_id = $1 AND NOT (content_hash = ANY($2::text[]))`,
      [documentId, [...seen]],
    );

    // xmax = 0 only for freshly inserted rows, which separates inserts from conflict updates.
    const upserted = await client.query<{ inserted: boolean }>(
      `INSERT INTO chunks (document_id, content_hash, key, ordinal, parent_id, type, part, section_path, box, exhibit,
                           pdf_pages, page_labels, context, text, tokens)
       SELECT $1, x.content_hash, x.key, x.ordinal, p.id, x.type, x.part, x.section_path, x.box, x.exhibit,
              x.pdf_pages, x.page_labels, x.context, x.text, x.tokens
       FROM jsonb_to_recordset($2) AS x(content_hash text, key text, ordinal int, parent_key text, type text, part text,
                                       section_path text[], box text, exhibit text, pdf_pages int[], page_labels text[],
                                       context text, text text, tokens int)
       LEFT JOIN parents p ON p.document_id = $1 AND p.key = x.parent_key
       ON CONFLICT (document_id, content_hash) DO UPDATE SET
         key = EXCLUDED.key, ordinal = EXCLUDED.ordinal, parent_id = EXCLUDED.parent_id, type = EXCLUDED.type,
         part = EXCLUDED.part, section_path = EXCLUDED.section_path, box = EXCLUDED.box, exhibit = EXCLUDED.exhibit,
         pdf_pages = EXCLUDED.pdf_pages, page_labels = EXCLUDED.page_labels, tokens = EXCLUDED.tokens
       RETURNING (xmax = 0) AS inserted`,
      [documentId, JSON.stringify(rows)],
    );
    const inserted = upserted.rows.filter((r) => r.inserted).length;

    return {
      documentId,
      inserted,
      kept: upserted.rows.length - inserted,
      deleted: deleted.rowCount ?? 0,
      duplicates,
      modelChanged,
    };
  });
}

export interface EmbedOptions {
  batchSize: number;
  maxBatchTokens: number;
  maxBatches: number;
  limiter: TokenRateLimiter;
}

export async function pendingCount(documentId: number): Promise<{ total: number; pending: number }> {
  const { rows } = await pool.query<{ total: number; pending: number }>(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE embedding IS NULL)::int AS pending
     FROM chunks WHERE document_id = $1`,
    [documentId],
  );
  return rows[0]!;
}

export async function embedPending(documentId: number, opts: EmbedOptions): Promise<number> {
  let embedded = 0;
  for (let batch = 1; batch <= opts.maxBatches; batch++) {
    const { rows } = await pool.query<{ id: string; context: string; text: string }>(
      `SELECT id, context, text FROM chunks
       WHERE document_id = $1 AND embedding IS NULL
       ORDER BY ordinal LIMIT $2`,
      [documentId, opts.batchSize],
    );
    if (!rows.length) break;

    const texts: string[] = [];
    let tokens = 0;
    for (const row of rows) {
      const text = embeddingText(row);
      const n = estimateTokens(text);
      if (texts.length && tokens + n > opts.maxBatchTokens) break;
      texts.push(text);
      tokens += n;
    }
    const ids = rows.slice(0, texts.length).map((r) => r.id);

    await opts.limiter.take(tokens);
    const started = Date.now();
    const vectors = await embedTexts(texts, "RETRIEVAL_DOCUMENT");

    await pool.query(
      `UPDATE chunks c SET embedding = v.embedding::vector, embedded_at = now()
       FROM unnest($1::bigint[], $2::text[]) AS v(id, embedding)
       WHERE c.id = v.id`,
      [ids, vectors.map(toSqlVector)],
    );
    embedded += ids.length;

    const { total, pending } = await pendingCount(documentId);
    console.log(
      `  batch ${batch}: ${ids.length} chunks, ~${tokens} tokens, ${Date.now() - started}ms -> ${total - pending}/${total} embedded`,
    );
  }
  return embedded;
}
