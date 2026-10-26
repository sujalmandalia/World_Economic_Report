import { estimateTokens } from "../chunking/chunk.js";
import type { RetrievedHit } from "../search/retrieve.js";
import type { SummaryHit } from "../search/summaries.js";
import { citationOf } from "../search/vector.js";

export interface Source {
  id: string;
  citation: string;
  context: string;
  pageLabels: string[];
  type: string;
  exhibit: string | null;
  score: number;
  chunkKeys: string[];
  usedParent: boolean;
  text: string;
}

export const CONTEXT_TOKEN_BUDGET = 6000;

// Prefer the parent block for surrounding context, but fall back to the chunk itself when the parent would blow the budget.
export function buildSources(hits: RetrievedHit[], budget = CONTEXT_TOKEN_BUDGET, firstId = 1): Source[] {
  const sources: Source[] = [];
  const byParent = new Map<string, Source>();
  let used = 0;

  for (const hit of hits) {
    const parentKey = hit.parent?.key;
    const existing = parentKey ? byParent.get(parentKey) : undefined;
    if (existing) {
      existing.chunkKeys.push(hit.key);
      continue;
    }

    const useParent = !!hit.parent && used + hit.parent.tokens <= budget;
    const text = useParent ? hit.parent!.text : hit.text;
    const tokens = estimateTokens(text);
    if (used + tokens > budget && sources.length) break;
    used += tokens;

    const pageLabels = useParent ? hit.parent!.pageLabels : hit.pageLabels;
    const source: Source = {
      id: `S${sources.length + firstId}`,
      citation: citationOf({ part: hit.part, pageLabels }),
      context: hit.context,
      pageLabels,
      type: hit.type,
      exhibit: hit.exhibit,
      score: hit.rerankScore,
      chunkKeys: [hit.key],
      usedParent: useParent,
      text,
    };
    sources.push(source);
    if (useParent && parentKey) byParent.set(parentKey, source);
  }
  return sources;
}

export function formatSources(sources: Source[]): string {
  return sources.map((s) => `[${s.id}] ${s.context} ${s.citation}\n${s.text}`).join("\n\n---\n\n");
}

export function summarySource(hit: SummaryHit, index: number, score: number): Source {
  const pageLabels = [hit.pageLabels[0]!, hit.pageLabels.at(-1)!].filter((p, i, a) => a.indexOf(p) === i);
  const where = [hit.part, hit.level === "section" ? hit.title : null].filter(Boolean).join(" > ");
  return {
    id: `S${index}`,
    citation: citationOf({ part: hit.part ?? "Report", pageLabels }),
    context: `Summary of ${hit.level === "document" ? "the whole report" : where}`,
    pageLabels,
    type: "summary",
    exhibit: null,
    score,
    chunkKeys: [hit.key],
    usedParent: false,
    text: hit.text,
  };
}
