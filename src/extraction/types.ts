export type Column = "left" | "right" | "full";

export interface Span {
  text: string;
  x0: number;
  x1: number;
  y: number;
  size: number;
  font: string;
}

export interface Row {
  y: number;
  spans: Span[];
}

export interface Line {
  text: string;
  x0: number;
  x1: number;
  y: number;
  size: number;
  font: string;
  column: Column;
  segment: number;
}

export interface Block {
  column: Column;
  font: string;
  size: number;
  bbox: [x0: number, yTop: number, x1: number, yBottom: number];
  lines: string[];
  text: string;
}

export interface ExtractedPage {
  pdfPage: number;
  label: string | null;
  printedNumber: string | null;
  header: string | null;
  columnSplit: number;
  blocks: Block[];
  text: string;
}

export interface ExtractedDocument {
  source: string;
  pageCount: number;
  bodyFontSize: number;
  pageLabels: { arabicOffset: number | null; romanOffset: number | null; mismatches: number[] };
  pages: ExtractedPage[];
}
