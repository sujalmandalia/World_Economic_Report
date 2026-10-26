import { renderExhibit } from "../structure/build.js";
import { isDataRow } from "../structure/tables.js";
import type { DocumentStructure, Element } from "../structure/types.js";
import type { Chunk, ChunkLocation, ChunkOptions, ChunkSet, ChunkType, Parent } from "./types.js";

export const DEFAULT_OPTIONS: ChunkOptions = {
  targetTokens: 400,
  maxTokens: 600,
  minTokens: 120,
  parentMaxTokens: 1500,
};

// Gemini averages ~4 characters per token on English prose; good enough for sizing.
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

const NOTES_INLINE_TOKENS = 150;
const SENTENCE_BREAK = /(?<=[.!?])\s+(?=[A-Z(“"])/;

export const contextOf = (loc: Pick<ChunkLocation, "part" | "sectionPath">) => [loc.part, ...loc.sectionPath].join(" > ");

export const embeddingText = (chunk: Pick<Chunk, "context" | "text">) => `${chunk.context}\n\n${chunk.text}`;

function locationOf(elements: Element[]): ChunkLocation {
  const first = elements[0]!;
  const pages = new Map<number, string>();
  for (const e of elements) e.pdfPages.forEach((p, i) => pages.set(p, e.pageLabels[i] ?? String(p)));
  const pdfPages = [...pages.keys()].sort((a, b) => a - b);
  return {
    part: first.part,
    sectionPath: first.sectionPath,
    box: first.box,
    pdfPages,
    pageLabels: pdfPages.map((p) => pages.get(p)!),
  };
}

function pack<T>(items: T[], size: (item: T) => number, target: number, max: number, min: number): T[][] {
  const groups: T[][] = [];
  let current: T[] = [];
  let tokens = 0;
  for (const item of items) {
    const n = size(item);
    if (current.length && tokens + n > max) {
      groups.push(current);
      current = [];
      tokens = 0;
    }
    current.push(item);
    tokens += n;
    if (tokens >= target) {
      groups.push(current);
      current = [];
      tokens = 0;
    }
  }
  if (current.length) {
    const last = groups[groups.length - 1];
    const lastTokens = last?.reduce((n, item) => n + size(item), 0) ?? 0;
    if (last && tokens < min && lastTokens + tokens <= max * 1.25) last.push(...current);
    else groups.push(current);
  }
  return groups;
}

interface Piece {
  element: Element;
  text: string;
}

function splitParagraph(element: Element, opts: ChunkOptions): Piece[] {
  if (estimateTokens(element.text) <= opts.maxTokens) return [{ element, text: element.text }];
  const sentences = element.text.split(SENTENCE_BREAK);
  return pack(sentences, estimateTokens, opts.targetTokens, opts.maxTokens, opts.minTokens).map((group) => ({
    element,
    text: group.join(" "),
  }));
}

export function chunkDocument(structure: DocumentStructure, opts: ChunkOptions = DEFAULT_OPTIONS): ChunkSet {
  const parents: Parent[] = [];
  const chunks: Chunk[] = [];

  const addParent = (elements: Element[], text: string): Parent => {
    const parent: Parent = { id: `p${parents.length + 1}`, ...locationOf(elements), text, tokens: estimateTokens(text) };
    parents.push(parent);
    return parent;
  };

  const addChunk = (type: ChunkType, elements: Element[], text: string, parentId?: string): Chunk => {
    const loc = locationOf(elements);
    const chunk: Chunk = {
      id: `c${chunks.length + 1}`,
      parentId: parentId ?? null,
      type,
      elementIds: [...new Set(elements.map((e) => e.id))],
      exhibit: elements[0]!.exhibit?.number ?? null,
      ...loc,
      context: contextOf(loc),
      text,
      tokens: estimateTokens(text),
    };
    chunks.push(chunk);
    return chunk;
  };

  const chunkTable = (table: Element) => {
    const ex = table.exhibit!;
    if (estimateTokens(table.text) <= opts.maxTokens) return addChunk("table", [table], table.text);

    const firstData = ex.rows.findIndex(isDataRow);
    const header = firstData > 0 ? ex.rows.slice(0, firstData) : [];
    const body = ex.rows.slice(header.length);
    const headerTokens = estimateTokens(renderExhibit(table, header, []));
    const rowTokens = (row: string[]) => estimateTokens(row.join(" | ")) + 1;
    const budget = Math.max(opts.targetTokens - headerTokens, 100);
    const groups = pack(body, rowTokens, budget, budget + 100, 40);
    const notesTokens = estimateTokens(ex.notes.join(" "));
    const separateNotes = notesTokens > NOTES_INLINE_TOKENS;

    const parent = addParent([table], table.text);
    groups.forEach((rows, i) => {
      const notes = i === groups.length - 1 && !separateNotes ? ex.notes : [];
      addChunk("table", [table], renderExhibit(table, [...header, ...rows], notes), parent.id);
    });
    if (separateNotes) addChunk("table", [table], renderExhibit(table, [], ex.notes), parent.id);
  };

  const sections = new Map<string, Element[]>();
  for (const e of structure.elements) {
    const key = contextOf(e);
    if (!sections.has(key)) sections.set(key, []);
    sections.get(key)!.push(e);
  }

  for (const elements of sections.values()) {
    const paragraphs = elements.filter((e) => e.type === "paragraph");
    const footnotes = elements.filter((e) => e.type === "footnote");

    const textChunks = pack(
      paragraphs.flatMap((p) => splitParagraph(p, opts)),
      (piece) => estimateTokens(piece.text),
      opts.targetTokens,
      opts.maxTokens,
      opts.minTokens,
    ).map((group) => ({ elements: group.map((p) => p.element), text: group.map((p) => p.text).join("\n\n") }));

    const windows = pack(textChunks, (c) => estimateTokens(c.text), opts.parentMaxTokens, opts.parentMaxTokens, 0);
    for (const window of windows) {
      const parent = window.length > 1 ? addParent(window.flatMap((c) => c.elements), window.map((c) => c.text).join("\n\n")) : null;
      for (const c of window) addChunk("text", c.elements, c.text, parent?.id);
    }

    for (const e of elements) {
      if (e.type === "figure") addChunk("figure", [e], e.text);
      else if (e.type === "table") chunkTable(e);
      else if (e.type === "credit") addChunk("credit", [e], e.text);
    }

    const noteGroups = pack(footnotes, (f) => estimateTokens(f.text), opts.targetTokens, opts.maxTokens, opts.minTokens);
    for (const group of noteGroups) addChunk("footnotes", group, group.map((f) => `Footnote: ${f.text}`).join("\n"));
  }

  return { source: structure.source, options: opts, parents, chunks };
}
