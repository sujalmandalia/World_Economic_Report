import type { Block } from "../extraction/types.js";

export type ExhibitKind = "figure" | "table" | "box";
export type ExhibitTextStyle = "caption" | "panel" | "note" | "body";

export type Role =
  | { kind: "partTitle" }
  | { kind: "heading"; rank: number }
  | { kind: "exhibitTitle"; exhibit: ExhibitKind; number: string; title: string }
  | { kind: "exhibitText"; style: ExhibitTextStyle }
  | { kind: "paragraph" }
  | { kind: "footnote" }
  | { kind: "credit" }
  | { kind: "chart" };

const EXHIBIT_TITLE = /^(FIGURE|TABLE|BOX)\s+([A-Z]?\d+(?:\.\d+)+)\.?\s+(.+?)(?:\s*\(continued\))?$/i;

function isRunInHeading(text: string): boolean {
  return text.length <= 100 && !/[.;:]\s/.test(text) && !/^[•▪\-–]/.test(text);
}

export function classifyBlock(block: Block, bodySize: number): Role {
  const { font, size, text } = block;
  const family = font.split("-")[0] ?? font;
  const bold = /Bold/.test(font);
  const garamond = /Garamond|Minion/.test(family);
  const helvetica = family.startsWith("HelveticaLTStd");

  if (size >= 20) return { kind: "partTitle" };
  // Plain "Helvetica" (not HelveticaLTStd) is only used inside chart graphics.
  if (family === "Helvetica" || size < 5.5 || text.trim().length <= 2) return { kind: "chart" };

  if (helvetica && bold && size >= 9.5) {
    const exhibit = EXHIBIT_TITLE.exec(text);
    if (exhibit) {
      return {
        kind: "exhibitTitle",
        exhibit: exhibit[1]!.toLowerCase() as ExhibitKind,
        number: exhibit[2]!,
        title: exhibit[3]!.trim(),
      };
    }
    if (size >= 15) return { kind: "heading", rank: 1 };
    if (size >= 13) return { kind: "heading", rank: 2 };
  }
  if (helvetica && size >= 10.5) return { kind: "heading", rank: 3 };

  if (garamond && size >= bodySize - 1.5) {
    return bold && isRunInHeading(text) ? { kind: "heading", rank: 4 } : { kind: "paragraph" };
  }
  if (garamond && size >= 7) {
    return /^Note: This (chapter|box|section|annex)/i.test(text) ? { kind: "credit" } : { kind: "footnote" };
  }

  if (helvetica) {
    const tabular = text.includes("\t");
    if (/Obl/.test(font) && !bold && !tabular) return { kind: "exhibitText", style: "caption" };
    if (bold && size < 7.4) return { kind: "exhibitText", style: "panel" };
    if (size <= 6.5) return { kind: "exhibitText", style: "note" };
    return { kind: "exhibitText", style: "body" };
  }
  return { kind: "chart" };
}
