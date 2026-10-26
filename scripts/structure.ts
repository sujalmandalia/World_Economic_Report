import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { buildStructure } from "../src/structure/build.js";
import type { ExtractedDocument } from "../src/extraction/types.js";
import type { Element } from "../src/structure/types.js";

const { values } = parseArgs({
  options: {
    in: { type: "string", default: "data/pages.json" },
    out: { type: "string", default: "data/structure.json" },
    page: { type: "string", short: "p" },
    section: { type: "string", short: "s" },
    outline: { type: "boolean", default: false },
  },
});

const doc = JSON.parse(await readFile(values.in!, "utf8")) as ExtractedDocument;
const { stats, ...structure } = buildStructure(doc);
await writeFile(values.out!, JSON.stringify(structure, null, 2));

const { parts, toc, elements, glossary } = structure;
const count = (type: Element["type"]) => elements.filter((e) => e.type === type).length;

console.log(`Structure -> ${values.out}`);
console.log("\nParts:");
for (const p of parts) {
  const n = elements.filter((e) => e.part === p.title).length;
  console.log(`  ${p.include ? "+" : "-"} pdf ${String(p.startPdfPage).padStart(3)}-${String(p.endPdfPage).padEnd(3)} ${p.kind.padEnd(8)} ${p.title}${p.include ? `  (${n} elements)` : ""}`);
}

console.log(
  `\nElements: ${elements.length} = ${count("paragraph")} paragraphs, ${count("figure")} figures, ` +
    `${count("table")} tables, ${count("footnote")} footnotes, ${count("credit")} credits`,
);
console.log(`Glossary: ${Object.keys(glossary).length} abbreviations`);
console.log(`Dropped blocks: ${Object.entries(stats.dropped).map(([k, v]) => `${k} ${v}`).join(", ")}`);

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const checkable = toc.entries.filter((e) => !e.topLevel && e.chapter !== null && !/^References$/i.test(e.title));
const missing = checkable.filter(
  (e) => !stats.headings.some((h) => h.part.startsWith(`Chapter ${e.chapter}:`) && norm(h.title) === norm(e.title)),
);
console.log(`TOC check: ${checkable.length - missing.length}/${checkable.length} TOC sections found as headings`);
for (const m of missing) console.log(`  missing: Chapter ${m.chapter} "${m.title}" (p. ${m.pageLabel})`);

const exhibitNumbers = new Set(elements.filter((e) => e.exhibit?.number).map((e) => `${e.type}:${e.exhibit!.number}`));
const missingExhibits = toc.exhibits.filter((x) => (x.kind === "figure" || x.kind === "table") && !exhibitNumbers.has(`${x.kind}:${x.number}`));
console.log(`Exhibit check: ${missingExhibits.length ? missingExhibits.map((x) => `${x.kind} ${x.number}`).join(", ") + " not found" : "all TOC figures and tables found"}`);

if (values.outline) {
  console.log("\nOutline (direct elements per section):");
  const direct = new Map<string, number>();
  for (const e of elements) {
    const key = [e.part, ...e.sectionPath].join(" > ");
    direct.set(key, (direct.get(key) ?? 0) + 1);
  }
  const printed = new Set<string>();
  for (const key of direct.keys()) {
    const path = key.split(" > ");
    path.forEach((title, depth) => {
      const prefix = path.slice(0, depth + 1).join(" > ");
      if (printed.has(prefix)) return;
      printed.add(prefix);
      console.log(`${"  ".repeat(depth)}${title}${direct.has(prefix) ? ` (${direct.get(prefix)})` : ""}`);
    });
  }
}

const show = elements.filter(
  (e) =>
    (values.page && e.pdfPages.includes(Number(values.page))) ||
    (values.section && [e.part, ...e.sectionPath].join(" > ").toLowerCase().includes(values.section.toLowerCase())),
);
for (const e of show) {
  console.log(`\n[${e.id} ${e.type} | p.${e.pageLabels.join(",")} | ${[e.part, ...e.sectionPath].join(" > ")}]`);
  console.log(e.text);
}
