import type { Block, Column, Line, Row, Span } from "./types.js";
import { joinLines, normalizeText, type Vocabulary } from "./text.js";

const ROW_TOLERANCE = 2;
const BAND_MERGE_GAP = 30;
const REGION_GAP = 30;
const REGION_SPLIT_TOLERANCE = 8;
const PARAGRAPH_GAP_RATIO = 1.68;

export function dominantFontSize(spans: Span[]): number {
  const weight = new Map<number, number>();
  for (const s of spans) {
    const size = Math.round(s.size);
    weight.set(size, (weight.get(size) ?? 0) + s.text.length);
  }
  return [...weight].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 11;
}

export function groupRows(spans: Span[]): Row[] {
  const rows: Row[] = [];
  for (const span of [...spans].sort((a, b) => b.y - a.y)) {
    const row = rows.find((r) => Math.abs(r.y - span.y) <= ROW_TOLERANCE);
    if (row) row.spans.push(span);
    else rows.push({ y: span.y, spans: [span] });
  }
  for (const row of rows) row.spans.sort((a, b) => a.x0 - b.x0);
  return rows.sort((a, b) => b.y - a.y);
}

export function rowText(row: Row): string {
  return row.spans.map((s) => s.text).join(" ").replace(/\s+/g, " ").trim();
}

function widestRun(coverage: number[], value: number): [number, number] {
  let best: [number, number] = [0, 0];
  let start = -1;
  for (let i = 0; i <= coverage.length; i++) {
    if (i < coverage.length && coverage[i] === value) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      if (i - start > best[1] - best[0]) best = [start, i];
      start = -1;
    }
  }
  return best;
}

function coverageBetween(rows: Row[], lo: number, hi: number, minSize: number): number[] {
  const coverage = new Array<number>(hi - lo + 1).fill(0);
  for (const row of rows) {
    for (const s of row.spans) {
      if (s.size < minSize) continue;
      for (let x = Math.max(lo, Math.floor(s.x0)); x <= Math.min(hi, Math.ceil(s.x1)); x++) coverage[x - lo]!++;
    }
  }
  return coverage;
}

// Prefer a gutter no text touches; otherwise the x-run least covered by body text (full-width lines cross it).
export function findColumnSplit(rows: Row[], width: number, bodySize: number, fallback = width / 2): number {
  const lo = Math.floor(width * 0.39);
  const hi = Math.ceil(width * 0.61);

  const [emptyStart, emptyEnd] = widestRun(coverageBetween(rows, lo, hi, 0), 0);
  if (emptyEnd - emptyStart >= 8) return lo + (emptyStart + emptyEnd - 1) / 2;

  const body = coverageBetween(rows, lo, hi, bodySize - 1.5);
  if (body.every((c) => c === 0)) return fallback;
  const [start, end] = widestRun(body, Math.min(...body));
  return lo + (start + end - 1) / 2;
}

function makeLine(spans: Span[], column: Column, segment: number): Line {
  let text = "";
  for (let i = 0; i < spans.length; i++) {
    const s = spans[i]!;
    const prev = spans[i - 1];
    if (prev) {
      const gap = s.x0 - prev.x1;
      // Wide gaps separate table cells; keep them distinguishable from word spaces.
      if (gap > s.size * 1.5) text += "\t";
      else if (gap > s.size * 0.15) text += " ";
    }
    text += s.text;
  }
  const main = spans.reduce((a, b) => (b.text.length > a.text.length ? b : a));
  return {
    text: normalizeText(text).replace(/ *\t */g, "\t").trim(),
    x0: Math.min(...spans.map((s) => s.x0)),
    x1: Math.max(...spans.map((s) => s.x1)),
    y: Math.max(...spans.map((s) => s.y)),
    size: main.size,
    font: main.font,
    column,
    segment,
  };
}

// Rows crossing the gutter form full-width bands; between bands, read left column then right.
function orderRegion(rows: Row[], split: number, firstSegment: number, bodySize: number): Line[] {
  // A table row can have an empty column exactly at the gutter; several small cells on both sides give it away.
  const isTableRow = (r: Row) =>
    r.spans.every((s) => s.size < bodySize - 1.5) &&
    r.spans.filter((s) => s.x1 <= split).length >= 2 &&
    r.spans.filter((s) => s.x0 >= split).length >= 2;
  const crosses = (r: Row) => r.spans.some((s) => s.x0 < split && s.x1 > split) || isTableRow(r);

  const bands: { top: number; bottom: number; left: number; size: number }[] = [];
  for (const row of rows.filter(crosses)) {
    const last = bands[bands.length - 1];
    const left = Math.min(...row.spans.map((s) => s.x0));
    const size = row.spans[0]!.size;
    if (last && last.bottom - row.y <= BAND_MERGE_GAP) Object.assign(last, { bottom: row.y, left: Math.min(last.left, left), size });
    else bands.push({ top: row.y, bottom: row.y, left, size });
  }

  // The last line of a full-width paragraph is often too short to reach the gutter.
  for (const band of bands) {
    for (const row of rows) {
      if (row.y >= band.bottom || band.bottom - row.y > band.size * 1.5) continue;
      const first = row.spans[0]!;
      if (Math.abs(first.x0 - band.left) < 2 && Math.abs(first.size - band.size) < 0.6) band.bottom = row.y;
    }
  }

  const lines: Line[] = [];
  for (const row of rows) {
    const bandIndex = bands.findIndex((b) => row.y <= b.top + 1 && row.y >= b.bottom - 1);
    if (bandIndex >= 0) {
      lines.push(makeLine(row.spans, "full", firstSegment + bandIndex * 2 + 1));
      continue;
    }
    const segment = firstSegment + bands.filter((b) => b.bottom > row.y).length * 2;
    const left = row.spans.filter((s) => s.x0 < split);
    const right = row.spans.filter((s) => s.x0 >= split);
    if (left.length) lines.push(makeLine(left, "left", segment));
    if (right.length) lines.push(makeLine(right, "right", segment));
  }
  return lines;
}

// A box and main text can share a page with different column positions, so each whitespace-separated region gets its own split.
function columnRegions(rows: Row[], width: number, bodySize: number, pageSplit: number) {
  const regions: { rows: Row[]; split: number }[] = [];
  let current: Row[] = [];
  const close = () => {
    if (!current.length) return;
    const split = current.length >= 3 ? findColumnSplit(current, width, bodySize, pageSplit) : pageSplit;
    const last = regions[regions.length - 1];
    if (last && Math.abs(last.split - split) <= REGION_SPLIT_TOLERANCE) last.rows.push(...current);
    else regions.push({ rows: current, split });
    current = [];
  };
  for (const row of rows) {
    const prev = current[current.length - 1];
    if (prev && prev.y - row.y > REGION_GAP) close();
    current.push(row);
  }
  close();
  return regions;
}

export function orderLines(rows: Row[], width: number, bodySize: number): { lines: Line[]; split: number } {
  const pageSplit = findColumnSplit(rows, width, bodySize);
  const lines: Line[] = [];
  let segment = 0;
  for (const region of columnRegions(rows, width, bodySize, pageSplit)) {
    const regionLines = orderRegion(region.rows, region.split, segment, bodySize);
    lines.push(...regionLines);
    segment = Math.max(segment, ...regionLines.map((l) => l.segment)) + 1;
  }

  const columnOrder: Record<Column, number> = { full: 0, left: 0, right: 1 };
  return {
    split: pageSplit,
    lines: lines
      .filter((l) => l.text)
      .sort((a, b) => a.segment - b.segment || columnOrder[a.column] - columnOrder[b.column] || b.y - a.y),
  };
}

function fontKey(font: string): string {
  const family = font.split("-")[0] ?? font;
  return /bold|black|heavy|semibold/i.test(font) ? `${family}:bold` : family;
}

export function buildBlocks(lines: Line[], vocab: Vocabulary): Block[] {
  const blocks: Block[] = [];
  let current: { block: Block; last: Line } | null = null;

  for (const line of lines) {
    const prev = current?.last;
    const tableRow = !!prev && prev.text.includes("\t") && line.text.includes("\t");
    const startsNew =
      !prev ||
      prev.segment !== line.segment ||
      prev.column !== line.column ||
      (!tableRow && fontKey(prev.font) !== fontKey(line.font)) ||
      (!tableRow && Math.abs(prev.size - line.size) > 0.6) ||
      prev.y - line.y > line.size * PARAGRAPH_GAP_RATIO ||
      prev.y - line.y <= 0;

    if (startsNew || !current) {
      const block: Block = {
        column: line.column,
        font: line.font,
        size: line.size,
        bbox: [line.x0, line.y, line.x1, line.y],
        lines: [line.text],
        text: line.text,
      };
      blocks.push(block);
      current = { block, last: line };
      continue;
    }

    const { block } = current;
    const tabular = line.text.includes("\t") || block.text.includes("\t");
    block.text = tabular ? `${block.text}\n${line.text}` : joinLines(block.text, line.text, vocab);
    block.lines.push(line.text);
    block.bbox = [
      Math.min(block.bbox[0], line.x0),
      block.bbox[1],
      Math.max(block.bbox[2], line.x1),
      line.y,
    ];
    current.last = line;
  }

  return blocks;
}
