import { mkdir, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { config } from "../src/config.js";
import { extractDocument } from "../src/extraction/extract.js";

const { values } = parseArgs({
  options: {
    page: { type: "string", short: "p" },
    out: { type: "string", default: "data/pages.json" },
  },
});

const started = Date.now();
const { stats, ...doc } = await extractDocument(config.reportPdf);
const ms = Date.now() - started;

await mkdir("data", { recursive: true });
await writeFile(values.out!, JSON.stringify(doc, null, 2));

console.log(`Extracted ${doc.pageCount} pages from ${doc.source} in ${ms}ms -> ${values.out}`);
console.log(`  body font size:        ${doc.bodyFontSize}pt`);
console.log(`  blank pages:           ${stats.blankPages.length} [${stats.blankPages.join(", ")}]`);
console.log(`  running headers removed: ${stats.headersRemoved}`);
console.log(`  rotated spans dropped: ${stats.rotatedSpansDropped}`);
console.log(`  full-width lines:      ${stats.fullWidthLines}`);
console.log(`  blocks:                ${stats.blocks}`);
console.log(`  characters:            ${stats.characters.toLocaleString()}`);
console.log(
  `  page labels:           arabic = pdf - ${doc.pageLabels.arabicOffset}, roman = pdf - ${doc.pageLabels.romanOffset}, ` +
    `mismatches: ${doc.pageLabels.mismatches.length ? doc.pageLabels.mismatches.join(", ") : "none"}`,
);

if (values.page) {
  const page = doc.pages.find((p) => p.pdfPage === Number(values.page));
  if (!page) throw new Error(`No PDF page ${values.page}`);
  console.log(`\n=== PDF page ${page.pdfPage} | printed page ${page.label ?? "-"} | split x=${page.columnSplit}`);
  console.log(`header: ${page.header ?? "-"}\n`);
  for (const b of page.blocks) {
    console.log(`[${b.column.padEnd(5)} ${b.font} ${b.size}pt]`);
    console.log(`${b.text}\n`);
  }
}
