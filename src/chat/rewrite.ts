import { ThinkingLevel, Type } from "@google/genai";
import { config } from "../config.js";
import { ai, withRetry } from "../services/gemini.js";
import type { Turn } from "./store.js";

export interface Rewrite {
  kind: "question" | "chitchat";
  question: string;
  rewritten: boolean;
  model: string | null;
}

const ANSWER_CHARS = 600;
const CHITCHAT = /^\s*(hi|hello|hey|thanks|thank you|thx|ok(ay)?|cool|great|bye|good (morning|afternoon|evening))\b[\s!.,]*$/i;

const SYSTEM = `You prepare search queries for a chatbot about the World Bank report "Global Economic Prospects, June 2026".
Rewrite the user's latest message into one standalone question that can be understood without the conversation.
- Resolve pronouns and follow-ups ("what about India?", "and in 2027?", "why?", "summarize it") using the conversation.
- Keep any chapter, table, figure, country, region or year the user mentions or clearly refers to.
- For comparisons ("how does that compare with X?"), name both things being compared.
- If the message is already standalone, return it unchanged.
- Do not answer the question. Do not copy numbers or findings from earlier answers into the question.
- Do not mention the report's name; every question is already about it. Keep the question short, like a person would type it.
- Use kind "chitchat" only for greetings, thanks or small talk that needs no information from the report.`;

const stripCitations = (s: string) => s.replace(/\[(?:Ch \d+|[A-Z][\w ]+), pp?\. [^\]]+\]/g, "").replace(/\s+/g, " ").trim();

export async function rewriteQuestion(history: Turn[], message: string): Promise<Rewrite> {
  if (CHITCHAT.test(message)) return { kind: "chitchat", question: message, rewritten: false, model: null };
  if (!history.length) return { kind: "question", question: message, rewritten: false, model: null };

  const conversation = history
    .map((t) => `User: ${t.standalone ?? t.question}\nAssistant: ${stripCitations(t.answer).slice(0, ANSWER_CHARS)}`)
    .join("\n\n");
  const model = config.gemini.rewriteModel;

  const res = await withRetry("rewrite", () =>
    ai.models.generateContent({
      model,
      contents: `Conversation:\n${conversation}\n\nLatest message: ${message}`,
      config: {
        systemInstruction: SYSTEM,
        temperature: 0,
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            kind: { type: Type.STRING, enum: ["question", "chitchat"] },
            question: { type: Type.STRING },
          },
          required: ["kind", "question"],
        },
      },
    }),
  );

  const parsed = JSON.parse(res.text ?? "{}") as { kind?: string; question?: string };
  const question = parsed.question?.trim() || message;
  return {
    kind: parsed.kind === "chitchat" ? "chitchat" : "question",
    question,
    rewritten: question !== message.trim(),
    model,
  };
}
