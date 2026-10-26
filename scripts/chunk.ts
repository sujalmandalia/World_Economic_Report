import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { chunkDocument, embeddingText } from "../src/chunking/chunk.js";
import type { Chunk } from "../src/chunking/types.js";
import type { DocumentStructure } from "../src/structure/types.js";

const { values } = parseArgs({
  options: {
    in: { type: "string", default: "data/structure.json" },
    out: { type: "string", default: "data/chunks.json" },
    id: { type: "string" },
    page: { type: "string", short: "p" },
    section: { type: "string", short: "s" },
    parent: { type: "boolean", default: false },
  },
});

const structure = JSON.parse(await readFile(values.in!, "utf8")) as DocumentStructure;
const set = chunkDocument(structure);
await writeFile(values.out!, JSON.stringify(set, null, 2));

const { chunks, parents, options } = set;
const tokens = chunks.map((c) => c.tokens).sort((a, b) => a - b);
const pct = (p: number) => tokens[Math.min(tokens.length - 1, Math.floor(tokens.length * p))];
const typeCounts = new Map<string, number>();
for (const c of chunks) typeCounts.set(c.type, (typeCounts.get(c.type) ?? 0) + 1);
const byType = [...typeCounts].map(([t, n]) => `${n} ${t}`);

console.log(`Chunks -> ${values.out}`);
console.log(`Options: target ${options.targetTokens}, max ${options.maxTokens}, min ${options.minTokens}, parent max ${options.parentMaxTokens} tokens`);
console.log(`Chunks: ${chunks.length} = ${byType.join(", ")}`);
console.log(`Parents: ${parents.length} (${chunks.filter((c) => c.parentId).length} chunks have one)`);
console.log(`Tokens per chunk: min ${tokens[0]}, p10 ${pct(0.1)}, p50 ${pct(0.5)}, p90 ${pct(0.9)}, max ${tokens[tokens.length - 1]}`);
console.log(`Total tokens to embed: ~${chunks.reduce((n, c) => n + Math.ceil(embeddingText(c).length / 4), 0)}`);

const buckets = [100, 200, 300, 400, 500, 600, 800, Infinity];
console.log("\nSize histogram (tokens):");
let lo = 0;
for (const hi of buckets) {
  const n = tokens.filter((t) => t >= lo && t < hi).length;
  console.log(`  ${String(lo).padStart(4)}-${hi === Infinity ? "   " : String(hi - 1).padEnd(3)} ${"#".repeat(Math.ceil(n / 4))} ${n}`);
  lo = hi;
}

const show: Chunk[] = chunks.filter(
  (c) =>
    c.id === values.id ||
    (values.page && c.pdfPages.includes(Number(values.page))) ||
    (values.section && c.context.toLowerCase().includes(values.section.toLowerCase())),
);
for (const c of show) {
  console.log(`\n[${c.id} ${c.type} | ~${c.tokens} tok | p.${c.pageLabels.join(",")} | parent ${c.parentId ?? "-"} | ${c.elementIds.join(",")}]`);
  console.log(embeddingText(c));
  const parent = values.parent && parents.find((p) => p.id === c.parentId);
  if (parent) console.log(`\n  -- parent ${parent.id} (~${parent.tokens} tok) --\n${parent.text}`);
}
