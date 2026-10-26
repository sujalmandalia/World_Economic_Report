import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import type { ChunkSet } from "../src/chunking/types.js";
import { config } from "../src/config.js";
import { pool } from "../src/db/pool.js";
import { embedPending, pendingCount, sha256, syncDocument } from "../src/ingestion/ingest.js";
import { TokenRateLimiter } from "../src/services/embeddings.js";
import type { DocumentStructure } from "../src/structure/types.js";

const { values } = parseArgs({
  options: {
    chunks: { type: "string", default: "data/chunks.json" },
    structure: { type: "string", default: "data/structure.json" },
    title: { type: "string", default: "Global Economic Prospects, June 2026" },
    "sync-only": { type: "boolean", default: false },
    "max-batches": { type: "string", default: "1000" },
    "batch-size": { type: "string", default: "50" },
    "batch-tokens": { type: "string", default: "12000" },
    tpm: { type: "string", default: "25000" },
    rpm: { type: "string", default: "60" },
  },
});

const chunkSet = JSON.parse(await readFile(values.chunks!, "utf8")) as ChunkSet;
const structure = JSON.parse(await readFile(values.structure!, "utf8")) as DocumentStructure;
const fileHash = sha256(await readFile(config.reportPdf));

console.log(`Syncing ${chunkSet.chunks.length} chunks, ${chunkSet.parents.length} parents from ${values.chunks}`);
const sync = await syncDocument({ source: config.reportPdf, title: values.title!, fileHash, structure, chunkSet });
console.log(
  `  document ${sync.documentId}: ${sync.inserted} new, ${sync.kept} unchanged (embeddings kept), ${sync.deleted} removed` +
    (sync.duplicates ? `, ${sync.duplicates} duplicate chunks skipped` : "") +
    (sync.modelChanged ? ", embedding model changed so all vectors were cleared" : ""),
);

const before = await pendingCount(sync.documentId);
console.log(`  ${before.pending} of ${before.total} chunks need embeddings`);

if (!values["sync-only"] && before.pending > 0) {
  const { embeddingModel, embeddingDimensions } = config.gemini;
  console.log(`\nEmbedding with ${embeddingModel} @ ${embeddingDimensions} dims (limit ${values.tpm} tokens/min, ${values.rpm} req/min)`);
  await embedPending(sync.documentId, {
    batchSize: Number(values["batch-size"]),
    maxBatchTokens: Number(values["batch-tokens"]),
    maxBatches: Number(values["max-batches"]),
    limiter: new TokenRateLimiter(Number(values.tpm), Number(values.rpm)),
  });
}

const { rows } = await pool.query<{ type: string; n: number; embedded: number; min_norm: number; max_norm: number }>(
  `SELECT type, count(*)::int AS n, count(embedding)::int AS embedded,
          round(min(vector_norm(embedding))::numeric, 4)::float AS min_norm,
          round(max(vector_norm(embedding))::numeric, 4)::float AS max_norm
   FROM chunks WHERE document_id = $1 GROUP BY type ORDER BY n DESC`,
  [sync.documentId],
);
console.log("\nStored chunks:");
for (const r of rows) {
  console.log(`  ${r.type.padEnd(9)} ${String(r.embedded).padStart(3)}/${String(r.n).padEnd(3)} embedded   norm ${r.min_norm ?? "-"}..${r.max_norm ?? "-"}`);
}
const after = await pendingCount(sync.documentId);
console.log(after.pending ? `\n${after.pending} chunks still pending; rerun "npm run ingest" to resume.` : "\nAll chunks embedded.");

await pool.end();
