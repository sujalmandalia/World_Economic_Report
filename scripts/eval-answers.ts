import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { answer, REFUSAL } from "../src/answer/answer.js";
import { pool } from "../src/db/pool.js";
import { isRelevant, type EvalQuestion } from "../src/eval/metrics.js";
import { sleep } from "../src/services/gemini.js";

const { values } = parseArgs({
  options: {
    questions: { type: "string", default: "eval/questions.json" },
    limit: { type: "string", default: "20" },
    delay: { type: "string", default: "4000" },
    only: { type: "string" },
  },
});

const all = JSON.parse(await readFile(values.questions!, "utf8")) as EvalQuestion[];
const picked = values.only
  ? all.filter((q) => values.only!.split(",").includes(q.id))
  : [
      ...all.filter((q) => q.answer).slice(0, Number(values.limit) - 4),
      ...all.filter((q) => q.category === "negative").slice(-4),
    ];

// Years and year ranges ("2027-28") are usually paraphrased as "this year"/"next year", so only figures are checked.
const figuresIn = (s: string) =>
  [
    ...new Set(
      s
        .replace(/COVID-19/gi, "")
        .replace(/\b(19|20)\d\d(?:s|[-–]\d\d)?\b/g, "")
        .match(/\d+(?:\.\d+)?/g) ?? [],
    ),
  ];

const rows = [];
for (const [i, q] of picked.entries()) {
  if (i) await sleep(Number(values.delay));
  const res = await answer(q.question);
  const negative = q.category === "negative";
  const refused = res.answer.trim() === REFUSAL;
  const expected = q.answer ? figuresIn(q.answer) : [];
  const found = expected.filter((n) => new RegExp(`(?<![\\d.])${n.replace(".", "\\.")}(?![\\d])`).test(res.answer));
  const citedSources = res.sources.filter((s) => res.cited.includes(s.id));
  const citedRelevant = citedSources.some((s) =>
    isRelevant({ key: s.id, type: s.type as never, pageLabels: s.pageLabels, context: s.context, exhibit: s.exhibit, similarity: 0, text: "" }, q.relevant),
  );

  const row = {
    id: q.id,
    category: q.category,
    question: q.question,
    reference: q.answer ?? null,
    answer: res.answer,
    refusalCorrect: negative ? refused : !refused,
    numbersFound: expected.length ? found.length / expected.length : null,
    headlineFound: expected.length ? found.includes(expected[0]!) : null,
    missingNumbers: expected.filter((n) => !found.includes(n)),
    grounded: res.grounded,
    invalidCitations: res.invalidCitations,
    citedRelevantSource: negative ? null : citedRelevant,
    ms: res.ms,
  };
  rows.push(row);
  const flag = row.refusalCorrect && row.invalidCitations.length === 0 && (negative || (citedRelevant && (row.numbersFound ?? 1) === 1)) ? "ok " : "!! ";
  console.log(`${flag}${q.id} [${q.category}] ${q.question}`);
  console.log(`     ${res.answer.replace(/\s+/g, " ").slice(0, 260)}`);
  if (row.missingNumbers.length) console.log(`     missing numbers: ${row.missingNumbers.join(", ")} (reference: ${q.answer})`);
  if (!negative && !citedRelevant) console.log(`     no cited source matches the expected pages`);
}

const answerable = rows.filter((r) => r.category !== "negative");
const pct = (x: number, n: number) => `${((x / (n || 1)) * 100).toFixed(0)}% (${x}/${n})`;
const withNumbers = answerable.filter((r) => r.numbersFound !== null);
console.log("\nSummary");
console.log(`  refusals correct:          ${pct(rows.filter((r) => r.refusalCorrect).length, rows.length)}`);
console.log(`  answers with citations:    ${pct(answerable.filter((r) => r.grounded).length, answerable.length)}`);
console.log(`  invalid citation ids:      ${rows.reduce((n, r) => n + r.invalidCitations.length, 0)}`);
console.log(`  cites an expected source:  ${pct(answerable.filter((r) => r.citedRelevantSource).length, answerable.length)}`);
console.log(`  headline number present:   ${pct(withNumbers.filter((r) => r.headlineFound).length, withNumbers.length)}`);
console.log(`  all reference figures:     ${pct(withNumbers.filter((r) => r.numbersFound === 1).length, withNumbers.length)}`);
console.log(`  median latency:            ${[...rows.map((r) => r.ms)].sort((a, b) => a - b)[Math.floor(rows.length / 2)]}ms`);

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
await writeFile(`eval/results/${stamp}-answers.json`, JSON.stringify(rows, null, 2));
console.log(`\nSaved eval/results/${stamp}-answers.json`);
await pool.end();
