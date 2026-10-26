import { ai } from "../src/services/gemini.js";
import { config } from "../src/config.js";

const { embeddingModel, embeddingDimensions, chatModel } = config.gemini;

function norm(v: number[]): number {
  return Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot / (norm(a) * norm(b));
}

async function embed(texts: string[], taskType: "RETRIEVAL_QUERY" | "RETRIEVAL_DOCUMENT") {
  const res = await ai.models.embedContent({
    model: embeddingModel,
    contents: texts,
    config: { taskType, outputDimensionality: embeddingDimensions },
  });
  const vectors = (res.embeddings ?? []).map((e) => e.values ?? []);
  if (vectors.length !== texts.length) {
    throw new Error(`Sent ${texts.length} texts, got ${vectors.length} embeddings back.`);
  }
  return vectors;
}

console.log(`Embedding model: ${embeddingModel} @ ${embeddingDimensions} dims`);

const [question] = await embed(["How much will oil prices rise this year?"], "RETRIEVAL_QUERY");
const [related, unrelated] = await embed(
  [
    "Brent crude is forecast to average $94/bbl in 2026, $34 higher than projected in January.",
    "Low-income countries face rising debt service burdens and reduced official aid inflows.",
  ],
  "RETRIEVAL_DOCUMENT",
);

if (!question || !related || !unrelated) throw new Error("Missing embedding in response.");

console.log(`  vector length: ${question.length}`);
console.log(`  first 5 values: [${question.slice(0, 5).map((x) => x.toFixed(4)).join(", ")}, ...]`);
console.log(`  L2 norm (unnormalized): ${norm(question).toFixed(4)}`);
console.log(`  similarity(question, related passage):   ${cosine(question, related).toFixed(4)}`);
console.log(`  similarity(question, unrelated passage): ${cosine(question, unrelated).toFixed(4)}`);

console.log(`\nChat model: ${chatModel}`);
const started = Date.now();
const reply = await ai.models.generateContent({
  model: chatModel,
  contents: "In one sentence: what is retrieval-augmented generation?",
});
console.log(`  (${Date.now() - started}ms) ${reply.text?.trim()}`);
