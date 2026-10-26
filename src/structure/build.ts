import type { Block, ExtractedDocument, ExtractedPage } from "../extraction/types.js";
import { buildVocabulary, joinLines, type Vocabulary } from "../extraction/text.js";
import { classifyBlock, type Role } from "./classify.js";
import { parseTableRows } from "./tables.js";
import { findTocPages, parseToc } from "./toc.js";
import type { DocumentStructure, Element, Part, Toc } from "./types.js";

const EXCLUDED_PARTS = /^(Front matter|Acknowledgments|Abbreviations|Selected Topics)$/;
const APPENDIX_PARTS = /^(Statistical Appendix|Data and Forecast Conventions)$/;
const SENTENCE_END = /[.!?:;"')\]]$/;

interface Heading {
  rank: number;
  title: string;
}

type Context = "main" | "box";

interface BoxState {
  label: string;
  number: string;
  basePath: string[];
  headings: Heading[];
}

interface ExhibitDraft {
  element: Element;
  rawRows: string[];
}

export interface StructureStats {
  dropped: Record<string, number>;
  headings: { title: string; rank: number; part: string; pdfPage: number }[];
}

function buildParts(toc: Toc, pages: ExtractedPage[]): Part[] {
  const pdfByLabel = new Map(pages.filter((p) => p.label).map((p) => [p.label!, p.pdfPage]));
  const starts = toc.entries
    .filter((e) => e.topLevel)
    .map((e) => ({
      title: e.chapter ? `Chapter ${e.chapter}: ${e.title}` : e.title,
      kind: e.chapter ? ("chapter" as const) : APPENDIX_PARTS.test(e.title) ? ("appendix" as const) : e.title === "Selected Topics" ? ("back" as const) : ("front" as const),
      startPdfPage: pdfByLabel.get(e.pageLabel) ?? 0,
    }))
    .filter((p) => p.startPdfPage > 0);

  if (starts[0] && starts[0].startPdfPage > 1) starts.unshift({ title: "Front matter", kind: "front", startPdfPage: 1 });

  return starts.map((p, i) => ({
    ...p,
    include: !EXCLUDED_PARTS.test(p.title),
    endPdfPage: (starts[i + 1]?.startPdfPage ?? pages.length + 1) - 1,
  }));
}

function parseGlossary(pages: ExtractedPage[], part: Part | undefined): Record<string, string> {
  const glossary: Record<string, string> = {};
  if (!part) return glossary;
  for (const page of pages.filter((p) => p.pdfPage >= part.startPdfPage && p.pdfPage <= part.endPdfPage)) {
    for (const line of page.blocks.flatMap((b) => b.lines)) {
      const [abbr, meaning] = line.split("\t");
      if (abbr && meaning && /^[A-Z][A-Za-z0-9&/.-]*$/.test(abbr.trim())) glossary[abbr.trim()] = meaning.trim();
    }
  }
  return glossary;
}

const cleanTitle = (text: string) => text.replace(/\s+/g, " ").replace(/\s*\(continued\)$/i, "").trim();

export function renderExhibit(element: Element, rows = element.exhibit!.rows, notes = element.exhibit!.notes): string {
  const ex = element.exhibit!;
  const kind = element.type === "figure" ? "Figure" : "Table";
  const parts = [ex.number ? `${kind} ${ex.number}: ${ex.title}` : ex.title];
  if (ex.caption.length) parts.push(ex.caption.join(" "));
  if (ex.panels.length) parts.push(`Panels: ${ex.panels.join("; ")}`);
  if (rows.length) parts.push(rows.map((r) => r.join(" | ")).join("\n"));
  if (notes.length) parts.push(notes.join(" "));
  return parts.join("\n");
}

export function buildStructure(doc: ExtractedDocument): DocumentStructure & { stats: StructureStats } {
  const toc = parseToc(findTocPages(doc.pages));
  const parts = buildParts(toc, doc.pages);
  const vocab: Vocabulary = buildVocabulary(doc.pages.flatMap((p) => p.blocks.flatMap((b) => b.lines)));
  const labelOf = new Map(doc.pages.map((p) => [p.pdfPage, p.label]));

  const elements: Element[] = [];
  const exhibitsById = new Map<string, ExhibitDraft>();
  const dropped: Record<string, number> = {};
  const headingsSeen: StructureStats["headings"] = [];
  const drop = (reason: string) => (dropped[reason] = (dropped[reason] ?? 0) + 1);

  let part = null as Part | null;
  let headings: Heading[] = [];
  let box = null as BoxState | null;
  let exhibit: ExhibitDraft | null = null;
  let lastParagraph: Record<Context, Element | null> = { main: null, box: null };

  const sectionPath = (ctx: Context) =>
    ctx === "box" && box
      ? [...box.basePath, box.label, ...box.headings.map((h) => h.title)]
      : headings.map((h) => h.title);
  const inReferences = () => headings.some((h) => /^References$/i.test(h.title));
  const isBoxSized = (block: Block) => block.size < doc.bodyFontSize - 0.2;
  const touch = (el: Element, pdfPage: number) => {
    if (!el.pdfPages.includes(pdfPage)) el.pdfPages.push(pdfPage);
  };

  // Box pages also carry main text, so each block is routed by its own font size, not by reading order.
  const contextOf = (block: Block, role: Role, nextParagraph: Block | undefined): Context => {
    if (!box) return "main";
    switch (role.kind) {
      case "heading":
        if (role.rank <= 2) return "main";
        if (role.rank === 4) return isBoxSized(block) ? "box" : "main";
        return nextParagraph && !isBoxSized(nextParagraph) ? "main" : "box";
      case "paragraph":
        return isBoxSized(block) ? "box" : "main";
      case "credit":
        return /this box/i.test(block.text) ? "box" : "main";
      case "exhibitTitle":
        return role.number.startsWith("B") ? "box" : "main";
      default:
        return "main";
    }
  };

  const newElement = (type: Element["type"], ctx: Context, pdfPage: number, text = ""): Element => {
    const el: Element = {
      id: `e${elements.length + 1}`,
      type,
      part: part!.title,
      sectionPath: sectionPath(ctx),
      box: ctx === "box" ? (box?.label ?? null) : null,
      pdfPages: [pdfPage],
      pageLabels: [],
      text,
    };
    elements.push(el);
    return el;
  };

  const openExhibit = (type: "figure" | "table", number: string | null, title: string, ctx: Context, pdfPage: number) => {
    const key = number ? `${type}:${number}` : null;
    const existing = key ? exhibitsById.get(key) : undefined;
    if (existing) {
      touch(existing.element, pdfPage);
      return existing;
    }
    const element = newElement(type, ctx, pdfPage);
    element.exhibit = { number, title, caption: [], panels: [], notes: [], rows: [] };
    const draft = { element, rawRows: [] };
    exhibitsById.set(key ?? element.id, draft);
    return draft;
  };

  const pushHeading = (stack: Heading[], rank: number, title: string) => {
    while (stack.length && stack[stack.length - 1]!.rank >= rank) {
      if (stack[stack.length - 1]!.title === title) return;
      stack.pop();
    }
    stack.push({ rank, title });
  };

  const handle = (block: Block, role: Role, ctx: Context, pdfPage: number) => {
    if (role.kind !== "exhibitText" && role.kind !== "chart") exhibit = null;

    switch (role.kind) {
      case "partTitle":
        return drop("part title");

      case "chart":
        return drop(exhibit ? "chart text inside figure" : "chart text");

      case "heading": {
        const title = cleanTitle(block.text);
        pushHeading(ctx === "box" ? box!.headings : headings, role.rank, title);
        headingsSeen.push({ title, rank: role.rank, part: part!.title, pdfPage });
        lastParagraph[ctx] = null;
        return;
      }

      case "exhibitTitle": {
        if (role.exhibit === "box") return;
        if (inReferences()) return drop("references");
        exhibit = openExhibit(role.exhibit, role.number, role.title, ctx, pdfPage);
        return;
      }

      case "exhibitText": {
        if (inReferences()) return drop("references");
        exhibit ??= openExhibit("table", null, headings[headings.length - 1]?.title ?? "Table", ctx, pdfPage);
        const ex = exhibit.element.exhibit!;
        touch(exhibit.element, pdfPage);
        if (role.style === "caption") ex.caption.push(block.text);
        else if (role.style === "panel") ex.panels.push(block.lines.join(" ").replace(/\t/g, "; "));
        else if (role.style === "note") {
          const starts = /^(Sources?|Notes?)\b|^[A-Z]\.\s/.test(block.text);
          if (!starts && ex.notes.length) ex.notes[ex.notes.length - 1] += ` ${block.text}`;
          else ex.notes.push(block.text);
        } else if (exhibit.element.type === "table") exhibit.rawRows.push(...block.lines);
        else drop("chart text inside figure");
        return;
      }

      case "paragraph":
      case "footnote":
      case "credit": {
        if (inReferences()) return drop("references");
        const last = lastParagraph[ctx];
        const continues =
          role.kind === "paragraph" &&
          last !== null &&
          last.sectionPath.join(" > ") === sectionPath(ctx).join(" > ") &&
          !SENTENCE_END.test(last.text) &&
          !/^[•▪]/.test(block.text);

        if (continues) {
          last.text = joinLines(last.text, block.text, vocab);
          touch(last, pdfPage);
          return;
        }
        const el = newElement(role.kind, ctx, pdfPage, block.text);
        if (role.kind === "paragraph") lastParagraph[ctx] = el;
        return;
      }
    }
  };

  for (const page of doc.pages) {
    const pagePart = parts.find((p) => page.pdfPage >= p.startPdfPage && p.endPdfPage >= page.pdfPage) ?? null;
    if (pagePart !== part) {
      part = pagePart;
      headings = [];
      box = null;
      exhibit = null;
      lastParagraph = { main: null, box: null };
    }
    if (!part?.include) {
      for (const _ of page.blocks) drop("excluded part");
      continue;
    }

    const roles = page.blocks.map((b) => classifyBlock(b, doc.bodyFontSize));
    const boxTitle = roles.find((r): r is Extract<Role, { kind: "exhibitTitle" }> => r.kind === "exhibitTitle" && r.exhibit === "box");
    if (!boxTitle) box = null;
    else if (box?.number !== boxTitle.number) {
      box = { label: `Box ${boxTitle.number}: ${boxTitle.title}`, number: boxTitle.number, basePath: headings.map((h) => h.title), headings: [] };
      lastParagraph.box = null;
    }

    page.blocks.forEach((block, i) => {
      const role = roles[i]!;
      const nextParagraph = page.blocks.find((_, j) => j > i && roles[j]!.kind === "paragraph");
      handle(block, role, contextOf(block, role, nextParagraph), page.pdfPage);
    });
  }

  for (const draft of exhibitsById.values()) {
    draft.element.exhibit!.rows = parseTableRows(draft.rawRows);
    draft.element.text = renderExhibit(draft.element);
  }
  for (const el of elements) {
    el.pdfPages.sort((a, b) => a - b);
    el.pageLabels = el.pdfPages.map((p) => labelOf.get(p) ?? String(p));
  }

  return {
    source: doc.source,
    parts,
    toc,
    glossary: parseGlossary(doc.pages, parts.find((p) => p.title === "Abbreviations")),
    elements: elements.filter((e) => e.text.trim()),
    stats: { dropped, headings: headingsSeen },
  };
}
