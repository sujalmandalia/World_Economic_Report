import { estimateTokens } from "../chunking/chunk.js";
import type { DocumentStructure, Element } from "../structure/types.js";

export type SummaryLevel = "document" | "part" | "section";

export interface SummaryPlan {
  key: string;
  level: SummaryLevel;
  part: string | null;
  title: string;
  pdfPages: number[];
  pageLabels: string[];
  text: string;
  children: string[];
}

const MIN_SECTION_TOKENS = 300;
const TABLE_CHARS = 1200;
const MAX_INPUT_CHARS = 60_000;

const renderElement = (e: Element) => (e.type === "table" ? e.text.slice(0, TABLE_CHARS) : e.text);
const renderAll = (elements: Element[]) => elements.map(renderElement).join("\n\n").slice(0, MAX_INPUT_CHARS);

function pagesOf(elements: Element[]) {
  const labels = new Map<number, string>();
  for (const e of elements) e.pdfPages.forEach((p, i) => labels.set(p, e.pageLabels[i] ?? String(p)));
  const pdfPages = [...labels.keys()].sort((a, b) => a - b);
  return { pdfPages, pageLabels: pdfPages.map((p) => labels.get(p)!) };
}

// Sections are summarized from raw text, parts from their section summaries, the document from part summaries.
export function planSummaries(structure: DocumentStructure): SummaryPlan[] {
  const sections: SummaryPlan[] = [];
  const parts: SummaryPlan[] = [];

  for (const part of structure.parts.filter((p) => p.include)) {
    const elements = structure.elements.filter((e) => e.part === part.title && e.type !== "credit" && e.type !== "footnote");
    if (!elements.length) continue;

    const groups = new Map<string, Element[]>();
    for (const e of elements) {
      const name = e.box ?? e.sectionPath[0] ?? "";
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name)!.push(e);
    }

    const children: string[] = [];
    const inline: Element[] = [];
    for (const [name, group] of groups) {
      if (!name || estimateTokens(renderAll(group)) < MIN_SECTION_TOKENS) {
        inline.push(...group);
        continue;
      }
      const key = `section:${part.title} > ${name}`;
      children.push(key);
      sections.push({ key, level: "section", part: part.title, title: name, ...pagesOf(group), text: renderAll(group), children: [] });
    }

    parts.push({
      key: `part:${part.title}`,
      level: "part",
      part: part.title,
      title: part.title,
      ...pagesOf(elements),
      text: renderAll(inline),
      children,
    });
  }

  const document: SummaryPlan = {
    key: "document",
    level: "document",
    part: null,
    title: "Global Economic Prospects, June 2026",
    ...pagesOf(structure.elements),
    text: "",
    children: parts.map((p) => p.key),
  };

  return [...sections, ...parts, document];
}
