import { config } from "../config.js";
import { retrieve, type RetrieveOptions } from "../search/retrieve.js";
import { scorePassages } from "../search/rerank.js";
import { searchSummaries } from "../search/summaries.js";
import { routeQuestion, type Route } from "./router.js";
import { buildSources, summarySource, type Source } from "./sources.js";

export interface Gathered {
  route: Route;
  answerable: boolean;
  topScore: number;
  sources: Source[];
}

const SUMMARY_SOURCES = 3;
const BROAD_CHUNK_BUDGET = 3500;

export async function gatherSources(question: string, opts: RetrieveOptions = {}): Promise<Gathered> {
  const route = routeQuestion(question);
  const filters = route.part ? { ...opts.filters, part: route.part } : opts.filters;

  if (route.kind === "specific") {
    const retrieval = await retrieve(question, { withParent: true, ...opts, filters });
    return { route, answerable: retrieval.answerable, topScore: retrieval.topScore, sources: buildSources(retrieval.hits) };
  }

  const include = route.part ? [`part:${route.part}`] : route.scope === "report" ? ["document"] : [];
  const [summaries, retrieval] = await Promise.all([
    searchSummaries(question, { part: route.part, k: SUMMARY_SOURCES, include }),
    retrieve(question, { withParent: true, k: 4, ...opts, filters: { types: ["text", "figure", "table"], ...filters } }),
  ]);
  const resolvedInclude = summaries.filter((s) => include.some((key) => s.key.startsWith(key)));

  const reranker = config.retrieval.reranker === "none" ? "minilm" : config.retrieval.reranker;
  const scores = await scorePassages(question, summaries.map((s) => `${s.title}\n\n${s.text}`), reranker);
  const minScore = config.retrieval.minScores[reranker];
  const ranked = summaries
    .map((s, i) => ({ s, score: scores[i]! }))
    .filter(({ s, score }) => score >= minScore || resolvedInclude.includes(s))
    .sort((a, b) => Number(resolvedInclude.includes(b.s)) - Number(resolvedInclude.includes(a.s)) || b.score - a.score)
    .slice(0, SUMMARY_SOURCES);

  const sources = ranked.map(({ s, score }, i) => summarySource(s, i + 1, Number(score.toFixed(4))));
  sources.push(...buildSources(retrieval.hits, BROAD_CHUNK_BUDGET, sources.length + 1));

  // An explicitly named chapter or "the report" is in scope by definition, even when the wording scores low.
  const answerable = resolvedInclude.length > 0 || ranked.length > 0 || retrieval.answerable;
  return { route, answerable, topScore: Math.max(retrieval.topScore, ...ranked.map((r) => r.score)), sources };
}
