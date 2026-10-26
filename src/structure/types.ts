export type PartKind = "front" | "chapter" | "appendix" | "back";

export interface Part {
  title: string;
  kind: PartKind;
  include: boolean;
  startPdfPage: number;
  endPdfPage: number;
}

export interface TocEntry {
  title: string;
  pageLabel: string;
  topLevel: boolean;
  chapter: number | null;
}

export interface ExhibitRef {
  kind: "annex" | "box" | "figure" | "table";
  number: string;
  title: string;
  pageLabel: string;
}

export interface Toc {
  entries: TocEntry[];
  exhibits: ExhibitRef[];
}

export type ElementType = "paragraph" | "figure" | "table" | "footnote" | "credit";

export interface Element {
  id: string;
  type: ElementType;
  part: string;
  sectionPath: string[];
  box: string | null;
  pdfPages: number[];
  pageLabels: string[];
  text: string;
  exhibit?: {
    number: string | null;
    title: string;
    caption: string[];
    panels: string[];
    notes: string[];
    rows: string[][];
  };
}

export interface DocumentStructure {
  source: string;
  parts: Part[];
  toc: Toc;
  glossary: Record<string, string>;
  elements: Element[];
}
