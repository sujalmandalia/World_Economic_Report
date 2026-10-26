import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { config } from "../src/config.js";
import { pool } from "../src/db/pool.js";
import { TokenRateLimiter } from "../src/services/embeddings.js";
import { planSummaries } from "../src/summaries/plan.js";
import { buildSummaries } from "../src/summaries/summarize.js";
import type { DocumentStructure } from "../src/structure/types.js";

const { values } = parseArgs({
  options: {
    structure: { type: "string", default: "data/structure.json" },
    plan: { type: "boolean", default: false },
    show: { type: "string" },
    rpm: { type: "string", default: "10" },
    tpm: { type: "string", default: "200000" },
  },
});

const structure = JSON.parse(await readFile(values.structure!, "utf8")) as DocumentStructure;
const plans = planSummaries(structure);
const count = (level: string) => plans.filter((p) => p.level === level).length;
console.log(`Plan: ${count("section")} sections, ${count("part")} parts, 1 document overview (model ${config.gemini.summaryModel})`);

if (values.plan) {
  for (const p of plans) console.log(`  ${p.level.padEnd(8)} pp.${p.pageLabels[0]}-${p.pageLabels.at(-1)}  ${p.title}`);
} else if (values.show) {
  const { rows } = await pool.query(
    `SELECT level, title, page_labels, model, text FROM summaries WHERE title ILIKE $1 OR key ILIKE $1 ORDER BY id`,
    [`%${values.show}%`],
  );
  for (const r of rows) console.log(`\n[${r.level}] ${r.title} (pp. ${r.page_labels[0]}-${r.page_labels.at(-1)}, ${r.model})\n${r.text}`);
} else {
  const doc = await pool.query<{ id: number }>(`SELECT id FROM documents WHERE source = $1`, [config.reportPdf]);
  if (!doc.rows[0]) throw new Error('No document found; run "npm run ingest" first.');
  const result = await buildSummaries(doc.rows[0].id, plans, new TokenRateLimiter(Number(values.tpm), Number(values.rpm)));
  console.log(`\nGenerated ${result.generated}, reused ${result.reused}, embedded ${result.embedded}`);
}

await pool.end();
