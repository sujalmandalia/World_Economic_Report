import { ThinkingLevel } from "@google/genai";
import { config } from "../config.js";
import type { RetrieveOptions } from "../search/retrieve.js";
import { ai, QuotaExhaustedError, withRetry } from "../services/gemini.js";
import { CitationRewriter } from "./citations.js";
import { gatherSources } from "./gather.js";
import type { Route } from "./router.js";
import { formatSources, type Source } from "./sources.js";

export const REFUSAL =
  "I couldn't find this in the Global Economic Prospects (June 2026) report, so I can't answer it from the report.";

const SYSTEM_INSTRUCTION = `You answer questions about the World Bank report "Global Economic Prospects, June 2026" using only the numbered sources provided.

Rules:
- Use only facts stated in the sources. Do not add outside knowledge, even if you know it.
- If the sources do not contain the answer, reply exactly: "${REFUSAL}"
- If they answer only part of the question, answer that part and say what the report does not cover.
- Cite every factual sentence with its source id in square brackets, e.g. [S2] or [S1, S3]. Never invent ids.
- Copy numbers exactly, with units and years. Tables use "|" between cells; the first rows give the column years. "e" means estimate and "f" forecast.
- Be concise: a few sentences or a short bulleted list unless the question asks for detail.
- Sources labelled "Summary of ..." condense whole sections or chapters. Use them for broad questions, but prefer the detailed sources for specific numbers.
- Write naturally; do not mention "sources", "context", "summaries" or "passages".`;

export type AnswerEvent =
  | { type: "sources"; route: Route; answerable: boolean; topScore: number; sources: (Omit<Source, "text"> & { excerpt: string })[] }
  | { type: "delta"; text: string }
  | {
      type: "done";
      answer: string;
      model: string | null;
      cited: string[];
      invalidCitations: string[];
      grounded: boolean;
      usage: Usage;
      ms: number;
    };

export interface Usage {
  promptTokens: number;
  outputTokens: number;
  thoughtTokens: number;
}

export interface AnswerOptions extends RetrieveOptions {}

let primaryBlockedUntil = 0;

const EXCERPT_CHARS = 1500;

const publicSource = ({ text, ...rest }: Source) => ({
  ...rest,
  excerpt: text.length > EXCERPT_CHARS ? `${text.slice(0, EXCERPT_CHARS)}…` : text,
});

export async function* answerStream(question: string, opts: AnswerOptions = {}): AsyncGenerator<AnswerEvent> {
  const started = Date.now();
  const retrieval = await gatherSources(question, opts);
  const { sources } = retrieval;

  yield {
    type: "sources",
    route: retrieval.route,
    answerable: retrieval.answerable,
    topScore: retrieval.topScore,
    sources: sources.map(publicSource),
  };

  // Refusing before the LLM call saves quota and removes any chance of an ungrounded answer.
  if (!retrieval.answerable) {
    yield { type: "delta", text: REFUSAL };
    yield {
      type: "done",
      answer: REFUSAL,
      model: null,
      cited: [],
      invalidCitations: [],
      grounded: true,
      usage: { promptTokens: 0, outputTokens: 0, thoughtTokens: 0 },
      ms: Date.now() - started,
    };
    return;
  }

  const generate = (model: string) =>
    withRetry("generate", () =>
      ai.models.generateContentStream({
        model,
        contents: `Sources:\n\n${formatSources(sources)}\n\nQuestion: ${question}`,
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
          temperature: 0.2,
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        },
      }),
    );

  const fallback = config.gemini.chatFallbackModel;
  let model = fallback && Date.now() < primaryBlockedUntil ? fallback : config.gemini.chatModel;
  let stream: Awaited<ReturnType<typeof generate>>;
  try {
    stream = await generate(model);
  } catch (err) {
    if (!(err instanceof QuotaExhaustedError) || !fallback || fallback === model) throw err;
    primaryBlockedUntil = Date.now() + err.retryAfterMs;
    console.warn(`${err.message} Using ${fallback} until then.`);
    model = fallback;
    stream = await generate(model);
  }

  const rewriter = new CitationRewriter(sources);
  let answer = "";
  const usage: Usage = { promptTokens: 0, outputTokens: 0, thoughtTokens: 0 };
  for await (const chunk of stream) {
    const text = rewriter.push(chunk.text ?? "");
    if (text) {
      answer += text;
      yield { type: "delta", text };
    }
    const meta = chunk.usageMetadata;
    if (meta) {
      usage.promptTokens = meta.promptTokenCount ?? usage.promptTokens;
      usage.outputTokens = meta.candidatesTokenCount ?? usage.outputTokens;
      usage.thoughtTokens = meta.thoughtsTokenCount ?? usage.thoughtTokens;
    }
  }
  const rest = rewriter.flush();
  if (rest) {
    answer += rest;
    yield { type: "delta", text: rest };
  }

  const refused = answer.trim() === REFUSAL;
  yield {
    type: "done",
    answer,
    model,
    cited: [...rewriter.cited],
    invalidCitations: [...rewriter.invalid],
    grounded: refused || rewriter.cited.size > 0,
    usage,
    ms: Date.now() - started,
  };
}

export async function answer(question: string, opts: AnswerOptions = {}) {
  let sources: Extract<AnswerEvent, { type: "sources" }> | undefined;
  let done: Extract<AnswerEvent, { type: "done" }> | undefined;
  for await (const event of answerStream(question, opts)) {
    if (event.type === "sources") sources = event;
    if (event.type === "done") done = event;
  }
  return { ...done!, route: sources!.route, answerable: sources!.answerable, topScore: sources!.topScore, sources: sources!.sources };
}
