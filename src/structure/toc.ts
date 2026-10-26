import type { ExtractedPage } from "../extraction/types.js";
import type { ExhibitRef, Toc, TocEntry } from "./types.js";

const LEADER = /^(.*?)(?:\s*\.{2,}|\s+\.)\s*([0-9]+|[ivxlc]+)\s*$/i;
const LIST_START = /^(Annexes|Boxes|Figures|Tables)\t/;
const EXHIBIT_ROW = /^([A-Z]?\d+(?:\.\d+)+)\t(.+)$/;
const KINDS = { Annexes: "annex", Boxes: "box", Figures: "figure", Tables: "table" } as const;

export function findTocPages(pages: ExtractedPage[]): ExtractedPage[] {
  const start = pages.findIndex((p) => p.blocks[0]?.size! >= 20 && p.blocks[0]?.text === "Contents");
  if (start < 0) return [];
  const toc: ExtractedPage[] = [];
  for (const page of pages.slice(start)) {
    if (toc.length && page.blocks[0] && page.blocks[0].size >= 20) break;
    toc.push(page);
  }
  return toc;
}

export function parseToc(tocPages: ExtractedPage[]): Toc {
  const entries: TocEntry[] = [];
  const exhibits: ExhibitRef[] = [];
  let list: ExhibitRef["kind"] | null = null;
  let chapter: number | null = null;
  let pending = "";
  let chapterTitleNext = false;

  for (const block of tocPages.flatMap((p) => p.blocks)) {
    if (block.size >= 20) continue;
    const bold = /Bold/.test(block.font);
    for (const raw of block.lines) {
      let line = raw.trim();

      const listStart = LIST_START.exec(line);
      if (listStart) {
        list = KINDS[listStart[1] as keyof typeof KINDS];
        line = line.slice(listStart[0].length);
      }

      // "Chapter 2" is repeated as a margin label on continuation pages.
      const chapterLabel = /^Chapter (\d+)\t?/.exec(line);
      let isChapterLine: boolean = chapterTitleNext;
      if (chapterLabel) {
        const n = Number(chapterLabel[1]);
        line = line.slice(chapterLabel[0].length);
        isChapterLine = n !== chapter;
        chapter = n;
        if (!line) {
          chapterTitleNext = isChapterLine;
          pending = "";
          continue;
        }
      }
      chapterTitleNext = false;

      const leader = LEADER.exec(`${pending} ${line}`.trim());
      if (!leader) {
        pending = `${pending} ${line}`.trim();
        continue;
      }
      pending = "";
      const title = leader[1]!.replace(/\t/g, " ").trim();
      const pageLabel = leader[2]!.toLowerCase();

      const exhibit = list ? EXHIBIT_ROW.exec(leader[1]!.trim()) : null;
      if (list && exhibit) {
        exhibits.push({ kind: list, number: exhibit[1]!, title: exhibit[2]!.trim(), pageLabel });
        continue;
      }

      const topLevel = isChapterLine || (bold && chapter === null) || (bold && /^(Statistical Appendix|Data and Forecast Conventions|Selected Topics)$/.test(title));
      if (topLevel && !isChapterLine) chapter = null;
      entries.push({ title, pageLabel, topLevel, chapter: isChapterLine ? chapter : topLevel ? null : chapter });
    }
  }
  return { entries, exhibits };
}
