import { readFile } from "node:fs/promises";
import { routeQuestion } from "../src/answer/router.js";

const cases = JSON.parse(await readFile("eval/routing.json", "utf8")) as { question: string; kind: string; part: string | null }[];
let correct = 0;
for (const c of cases) {
  const route = routeQuestion(c.question);
  const ok = route.kind === c.kind && route.part === c.part;
  if (ok) correct++;
  console.log(`${ok ? "ok " : "!! "}${route.kind.padEnd(8)} ${String(route.part ?? "-").padEnd(20)} ${c.question}${ok ? "" : `  (expected ${c.kind}, ${c.part ?? "-"})`}`);
}
console.log(`\nRouting accuracy: ${correct}/${cases.length}`);
