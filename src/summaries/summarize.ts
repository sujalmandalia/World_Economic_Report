import { ThinkingLevel } from "@google/genai";
import { estimateTokens } from "../chunking/chunk.js";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { sha256 } from "../ingestion/ingest.js";
import { embedTexts, toSqlVector, type TokenRateLimiter } from "../services/embeddings.js";
import { ai, withRetry } from "../services/gemini.js";
import type { SummaryLevel, SummaryPlan } from "./plan.js";

const PROMPT_VERSION = "v1";

const INSTRUCTIONS: Record<SummaryLevel, string> = {
  section:
    "Summarize this section in 120-180 words. Keep the key numbers (growth rates, percentages, prices) with their years, " +
    "the main findings, risks and policy recommendations. Name the regions or countries discussed.",
  part:
    "Write a 200-280 word overview of this part of the report from the section summaries and text below. " +
    "Start with its main message, then the key findings and numbers, then the policy recommendations.",
  document:
    "Write a 250-350 word overview of the whole report from the part summaries below: the headline global forecast, " +
    "the main risks, the theme of each chapter, and the main policy messages.",
};

const SYSTEM =
  'You summarize parts of the World Bank report "Global Economic Prospects, June 2026". ' +
  "Use only the given text, copy numbers exactly, and write plain prose without headings or bullet points.";

export interface StoredSummary {
  key: string;
  text: string;
  sourceHash: string;
}

function inputFor(plan: SummaryPlan, done: Map<string, string>): string {
  const childText = plan.children
    .filter((key) => done.has(key))
    .map((key) => `## ${key.replace(/^(section|part):/, "")}\n${done.get(key)}`)
    .join("\n\n");
  return [childText && `Summaries:\n${childText}`, plan.text && `Text:\n${plan.text}`].filter(Boolean).join("\n\n");
}

async function generate(plan: SummaryPlan, input: string, model: string): Promise<string> {
  const res = await withRetry("summarize", () =>
    ai.models.generateContent({
      model,
      contents: `${INSTRUCTIONS[plan.level]}\n\nTitle: ${plan.title}\n\n${input}`,
      config: { systemInstruction: SYSTEM, temperature: 0.2, thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } },
    }),
  );
  const text = res.text?.trim();
  if (!text) throw new Error(`Empty summary for ${plan.key}`);
  return text;
}

export async function buildSummaries(documentId: number, plans: SummaryPlan[], limiter: TokenRateLimiter) {
  const model = config.gemini.summaryModel;
  const existing = new Map(
    (
      await pool.query<{ key: string; source_hash: string; text: string }>(
        `SELECT key, source_hash, text FROM summaries WHERE document_id = $1`,
        [documentId],
      )
    ).rows.map((r) => [r.key, r]),
  );

  await pool.query(`DELETE FROM summaries WHERE document_id = $1 AND NOT (key = ANY($2::text[]))`, [
    documentId,
    plans.map((p) => p.key),
  ]);

  const done = new Map<string, string>();
  let generated = 0;
  for (const plan of plans) {
    const input = inputFor(plan, done);
    const sourceHash = sha256(`${PROMPT_VERSION}\n${model}\n${input}`);
    const cached = existing.get(plan.key);
    if (cached?.source_hash === sourceHash) {
      done.set(plan.key, cached.text);
      continue;
    }

    await limiter.take(estimateTokens(input) + 400);
    const started = Date.now();
    const text = await generate(plan, input, model);
    done.set(plan.key, text);
    generated++;

    await pool.query(
      `INSERT INTO summaries (document_id, key, level, part, title, pdf_pages, page_labels, source_hash, model, text, tokens)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (document_id, key) DO UPDATE SET
         level = EXCLUDED.level, part = EXCLUDED.part, title = EXCLUDED.title, pdf_pages = EXCLUDED.pdf_pages,
         page_labels = EXCLUDED.page_labels, source_hash = EXCLUDED.source_hash, model = EXCLUDED.model,
         text = EXCLUDED.text, tokens = EXCLUDED.tokens, embedding = NULL, created_at = now()`,
      [documentId, plan.key, plan.level, plan.part, plan.title, plan.pdfPages, plan.pageLabels, sourceHash, model, text, estimateTokens(text)],
    );
    console.log(`  ${plan.level.padEnd(8)} ${plan.title.slice(0, 70).padEnd(70)} ${estimateTokens(input)} -> ${estimateTokens(text)} tokens, ${Date.now() - started}ms`);
  }

  const pending = await pool.query<{ id: string; title: string; part: string | null; text: string }>(
    `SELECT id, title, part, text FROM summaries WHERE document_id = $1 AND embedding IS NULL`,
    [documentId],
  );
  for (let i = 0; i < pending.rows.length; i += 50) {
    const batch = pending.rows.slice(i, i + 50);
    const vectors = await embedTexts(
      batch.map((r) => `Summary: ${[r.part, r.title].filter((x, j, a) => x && a.indexOf(x) === j).join(" > ")}\n\n${r.text}`),
      "RETRIEVAL_DOCUMENT",
    );
    await pool.query(
      `UPDATE summaries s SET embedding = v.embedding::vector
       FROM unnest($1::bigint[], $2::text[]) AS v(id, embedding) WHERE s.id = v.id`,
      [batch.map((r) => r.id), vectors.map(toSqlVector)],
    );
  }

  return { generated, reused: plans.length - generated, embedded: pending.rows.length };
}
