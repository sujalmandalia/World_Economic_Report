import { config } from "../config.js";
import { search, type HybridHit, type SearchMode } from "./hybrid.js";
import { rerank, type RerankerName } from "./rerank.js";
import type { SearchFilters } from "./vector.js";

export interface RetrieveOptions {
  k?: number;
  candidates?: number;
  mode?: SearchMode;
  reranker?: RerankerName;
  minScore?: number;
  filters?: SearchFilters;
  withParent?: boolean;
}

export type RetrievedHit = HybridHit & { rerankScore: number };

export interface Retrieval {
  answerable: boolean;
  topScore: number;
  minScore: number;
  reranker: RerankerName;
  hits: RetrievedHit[];
  candidates: RetrievedHit[];
}

export async function retrieve(query: string, opts: RetrieveOptions = {}): Promise<Retrieval> {
  let reranker = opts.reranker ?? config.retrieval.reranker;
  const k = opts.k ?? 8;

  // Equal weights interleave both lists so keyword-only matches reach the reranker, which decides the final order.
  const candidates = await search(query, {
    k: opts.candidates ?? 24,
    candidates: 30,
    weights: { vector: 1, keyword: 1, exhibit: 1 },
    mode: opts.mode ?? "hybrid",
    filters: opts.filters,
    withParent: opts.withParent,
  });
  let ranked: RetrievedHit[];
  try {
    ranked = await rerank(query, candidates, reranker);
  } catch (err) {
    if (reranker !== "llm") throw err;
    console.warn(`LLM rerank failed (${(err as Error).message.slice(0, 80)}); falling back to minilm`);
    reranker = "minilm";
    ranked = await rerank(query, candidates, reranker);
  }
  const minScore = opts.minScore ?? config.retrieval.minScores[reranker];
  const hits = ranked.filter((h) => h.rerankScore >= minScore).slice(0, k);

  return {
    answerable: hits.length > 0,
    topScore: ranked[0]?.rerankScore ?? 0,
    minScore,
    reranker,
    hits,
    candidates: ranked,
  };
}
