export interface Route {
  kind: "broad" | "specific";
  part: string | null;
  scope: "report" | "part" | null;
  reason: string;
}

const NAMED_PARTS: [RegExp, string][] = [
  [/\bstatistical appendix\b/i, "Statistical Appendix"],
  [/\bexecutive summary\b/i, "Executive Summary"],
  [/\bforeword\b/i, "Foreword"],
  [/\bdata and forecast conventions\b/i, "Data and Forecast Conventions"],
];

const BROAD_PATTERNS: [RegExp, string][] = [
  [/\b(summar(y|ise|ize)|overview|outline|gist|tl;?dr|in a nutshell)\b/i, "asks for a summary"],
  [
    /\b(main|key|overall|central|big[- ]picture|major|biggest)\s+(\w+\s+){0,2}(messages?|themes?|takeaways?|findings?|points?|conclusions?|arguments?|lessons?|topics?|risks?|recommendations?|challenges?)\b/i,
    "asks for main messages or themes",
  ],
  [/\bwhat (is|are) (this|the) (report|chapter( \d)?|appendix)\b.*\babout\b/i, "asks what a part is about"],
  [/\bwhat is chapter \d\b.*\babout\b/i, "asks what a chapter is about"],
  [/\bwhat (does|do) (?:(?:this|the) )?(report|chapter( \d)?)\s+(say|cover|discuss|argue|conclude|focus on|recommend)\b/i, "asks what a part says"],
  [/\b(chapters|structure|table of contents|sections) (of|in) (the|this) report\b/i, "asks about the report's structure"],
];

// Cheap regex routing: no LLM call, fully testable, and easy to extend from misrouted questions in eval/routing.json.
export function routeQuestion(question: string): Route {
  const chapter = /\b(?:chapter|ch\.?)\s*([1-4])\b/i.exec(question)?.[1];
  const named = NAMED_PARTS.find(([re]) => re.test(question))?.[1];
  const part = chapter ? `Chapter ${chapter}:` : (named ?? null);
  const mentionsReport = /\b(this|the) (report|gep|global economic prospects)\b/i.test(question);
  const scope = part ? "part" : mentionsReport ? "report" : null;

  const broad = BROAD_PATTERNS.find(([re]) => re.test(question));
  if (broad) return { kind: "broad", part, scope, reason: broad[1] };
  return { kind: "specific", part, scope, reason: part ? "specific question scoped to a part" : "specific question" };
}
