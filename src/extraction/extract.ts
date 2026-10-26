import { readFile } from "node:fs/promises";
import { readPdf, type RawPage } from "./pdf.js";
import { buildBlocks, dominantFontSize, groupRows, orderLines, rowText } from "./layout.js";
import { buildVocabulary, normalizeText, numberToRoman, romanToNumber } from "./text.js";
import type { ExtractedDocument, ExtractedPage, Line, Row, Span } from "./types.js";

const HEADER_ZONE = 0.925;
const FOOTER_ZONE = 44;
const PAGE_NUMBER = /^(\d{1,3}|[ivxlc]{1,7})$/i;

interface PreparedPage {
  raw: RawPage;
  header: string | null;
  printedNumber: string | null;
  columnSplit: number;
  lines: Line[];
}

function isSuperscriptMarker(span: Span, spans: Span[]): boolean {
  if (!/^[\d*†‡,]+$/.test(span.text.trim())) return false;
  return spans.some(
    (base) =>
      base.size > span.size * 1.2 &&
      span.y > base.y &&
      span.y - base.y < base.size * 0.6 &&
      span.x0 - base.x1 > -1 &&
      span.x0 - base.x1 < 4,
  );
}

function preparePage(raw: RawPage, bodySize: number): PreparedPage {
  const spans = raw.spans.filter((s) => !isSuperscriptMarker(s, raw.spans));
  const rows = groupRows(spans);

  const headerRows: Row[] = [];
  const bodyRows: Row[] = [];
  let printedNumber: string | null = null;

  for (const row of rows) {
    const text = rowText(row);
    if (row.y > raw.height * HEADER_ZONE && row.spans.every((s) => s.size <= bodySize * 0.8)) {
      headerRows.push(row);
      printedNumber ??= row.spans.map((s) => s.text.trim()).find((t) => /^\d{1,3}$/.test(t)) ?? null;
    } else if (row.y < FOOTER_ZONE && PAGE_NUMBER.test(text)) {
      printedNumber ??= text;
    } else {
      bodyRows.push(row);
    }
  }

  const { lines, split } = orderLines(bodyRows, raw.width, bodySize);
  return {
    raw,
    header: headerRows.length ? normalizeText(headerRows.map(rowText).join(" ")) : null,
    printedNumber,
    columnSplit: split,
    lines,
  };
}

function mode(values: number[]): number | null {
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

// No /PageLabels in this PDF: apply the most common (pdfPage - printed number) offset per scheme.
function assignPageLabels(pages: PreparedPage[]) {
  const arabicOffset = mode(
    pages.filter((p) => /^\d+$/.test(p.printedNumber ?? "")).map((p) => p.raw.pdfPage - Number(p.printedNumber)),
  );
  const romanOffset = mode(
    pages
      .map((p) => ({ p, n: p.printedNumber ? romanToNumber(p.printedNumber) : null }))
      .filter((x): x is { p: PreparedPage; n: number } => x.n !== null)
      .map(({ p, n }) => p.raw.pdfPage - n),
  );

  const labels = new Map<number, string | null>();
  const mismatches: number[] = [];
  for (const p of pages) {
    const pdfPage = p.raw.pdfPage;
    let label: string | null = null;
    if (arabicOffset !== null && pdfPage - arabicOffset >= 1) label = String(pdfPage - arabicOffset);
    else if (romanOffset !== null && pdfPage - romanOffset >= 1) label = numberToRoman(pdfPage - romanOffset);
    labels.set(pdfPage, label);
    if (p.printedNumber && p.printedNumber.toLowerCase() !== label) mismatches.push(pdfPage);
  }
  return { labels, arabicOffset, romanOffset, mismatches };
}

export async function extractDocument(pdfPath: string): Promise<ExtractedDocument & { stats: ExtractionStats }> {
  const raws = await readPdf(new Uint8Array(await readFile(pdfPath)));
  const bodySize = dominantFontSize(raws.flatMap((r) => r.spans));

  const prepared = raws.map((raw) => preparePage(raw, bodySize));
  const vocab = buildVocabulary(prepared.flatMap((p) => p.lines.map((l) => l.text)));
  const { labels, arabicOffset, romanOffset, mismatches } = assignPageLabels(prepared);

  const pages: ExtractedPage[] = prepared.map((p) => {
    const blocks = buildBlocks(p.lines, vocab);
    return {
      pdfPage: p.raw.pdfPage,
      label: labels.get(p.raw.pdfPage) ?? null,
      printedNumber: p.printedNumber,
      header: p.header,
      columnSplit: Math.round(p.columnSplit),
      blocks,
      text: blocks.map((b) => b.text).join("\n\n"),
    };
  });

  return {
    source: pdfPath,
    pageCount: pages.length,
    bodyFontSize: bodySize,
    pageLabels: { arabicOffset, romanOffset, mismatches },
    pages,
    stats: {
      blankPages: pages.filter((p) => p.blocks.length === 0).map((p) => p.pdfPage),
      headersRemoved: prepared.filter((p) => p.header).length,
      rotatedSpansDropped: raws.reduce((n, r) => n + r.rotatedDropped, 0),
      fullWidthLines: prepared.reduce((n, p) => n + p.lines.filter((l) => l.column === "full").length, 0),
      blocks: pages.reduce((n, p) => n + p.blocks.length, 0),
      characters: pages.reduce((n, p) => n + p.text.length, 0),
    },
  };
}

export interface ExtractionStats {
  blankPages: number[];
  headersRemoved: number;
  rotatedSpansDropped: number;
  fullWidthLines: number;
  blocks: number;
  characters: number;
}
