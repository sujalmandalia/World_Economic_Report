# World Bank Economic Report RAG

A chatbot that answers questions about the World Bank *Global Economic Prospects, June 2026* report
(200 pages) using only the report, with page citations. Built from scratch, phase by phase, as a
learning project.

Stack: Node 22 + TypeScript, Express 5, Postgres 14 + pgvector and built-in full-text search,
Gemini free tier (embeddings, answers, summaries, query rewriting), a local MiniLM cross-encoder
(reranking) and a plain HTML/JS frontend.

## Quick start

```bash
npm install
cp .env.example .env        # fill in DATABASE_URL and GEMINI_API_KEY
npm run db:setup            # creates the database, enables pgvector, applies src/db/schema.sql
npm run pipeline            # extract -> structure -> chunk -> ingest (embeddings) -> summarize
npm run dev                 # open http://localhost:3000
```

Every pipeline step is re-runnable: ingestion only embeds new or changed chunks and summaries are only
regenerated when their input changes.

## How a question is answered

```
question ─► rewrite follow-up into a standalone question (only when there is history)
         ─► route: broad ("summarize chapter 3") or specific, plus chapter scope
         ─► retrieve: vector (pgvector HNSW) + keyword (BM25 over tsvector) + exhibit lookup, fused with RRF
         ─► rerank 24 candidates with a local cross-encoder, drop chunks below the relevance gate
         ─► nothing passes? → "not in the report" (no LLM call)
         ─► broad questions also get section/chapter/report summaries
         ─► Gemini writes the answer citing [S1]…, rewritten to [Ch 2, p. 76] as it streams
```

## Ingestion pipeline

| Step | Command | Output |
|---|---|---|
| Text extraction: two-column reading order, headers/footers, de-hyphenation, printed page labels | `npm run extract` | `data/pages.json` |
| Structure: TOC, chapters, section paths, boxes, figures, tables, glossary | `npm run structure` | `data/structure.json` |
| Chunking: ~400-token chunks within a section, parent blocks, table row groups | `npm run chunk` | `data/chunks.json` |
| Embeddings + storage (resumable, content-hashed) | `npm run ingest` | `chunks`, `parents` tables |
| Hierarchical summaries: sections -> chapters -> report | `npm run summarize` | `summaries` table |

Inspection flags: `extract -- --page 37`, `structure -- --outline`, `chunk -- --section "Box 1.1" --parent`,
`summarize -- --plan` / `--show "Chapter 3"`.

## Using it

- Web UI: `npm run dev`, then http://localhost:3000. Streaming answers, clickable citations that open the
  source text, conversation history, stop button.
- Terminal: `npm run chat` (multi-turn), `npm run ask -- "question" --sources` (single question),
  `npm run search -- "query" --mode hybrid --rerank minilm` (retrieval only).

## HTTP API

| Endpoint | Purpose |
|---|---|
| `POST /chat {message, conversationId?, stream?}` | Multi-turn chat. With `stream: true`, server-sent events: `conversation`, `sources`, `delta`…, `done` (or `error`) |
| `POST /ask {question, stream?, k?, rerank?}` | Single question without memory, same events minus `conversation` |
| `GET /search?q=&k=&mode=&rerank=&type=&part=&parent=` | Retrieval only, with ranks and scores |
| `GET /conversations`, `GET /conversations/:id`, `DELETE /conversations/:id` | Conversation history |
| `GET /health` | Postgres, pgvector, PDF and model configuration |

`POST /chat` and `/ask` are rate limited per IP (`RATE_LIMIT_PER_MINUTE`, default 10).

## Configuration (`.env`)

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL`, `GEMINI_API_KEY` | | required |
| `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS` | `gemini-embedding-001`, `768` | the `vector(768)` column must match |
| `CHAT_MODEL` | `gemini-3.6-flash` | writes answers; free tier allows about 20 requests/day |
| `CHAT_FALLBACK_MODEL` | | used automatically once `CHAT_MODEL` hits its daily quota |
| `SUMMARY_MODEL`, `REWRITE_MODEL` | fallback model | summaries and follow-up rewriting |
| `RERANKER` | `minilm` | `none`, `minilm`, `bge` (slow) or `llm` (uses chat quota) |
| `RELEVANCE_MIN_SCORE` | per reranker (`minilm` 0.005) | overrides the relevance gate |
| `CROSS_ENCODER_MAX_TOKENS` | `512` | lower is faster but truncates chunks |
| `RATE_LIMIT_PER_MINUTE` | `10` | |

## Evaluation

| Command | What it measures | API cost |
|---|---|---|
| `npm run eval -- --retriever hybrid --reranker minilm` | Retrieval hit@1 / recall@k / MRR on 59 answerable + 12 out-of-scope questions, plus a relevance-gate threshold sweep | query embeddings (cached) |
| `npm run eval:answers -- --limit 16` | Refusals, citation validity, cited pages, reference numbers in answers | 1 chat call per question |
| `npm run eval:routing` | Broad vs specific routing and chapter scope | none |
| `npm run eval:rewrite` | Follow-up rewriting | 1 lite call per case |

Latest results: hybrid + MiniLM recall@5 98.3%, recall@10 100%; the gate answers 100% of answerable and
refuses 100% of out-of-scope questions; answers 12/12 cited with expected pages, 0 invalid citations;
routing 24/24; rewriting 10/10. The question sets were written by the author of the code, so add your own.
Runs are saved in `eval/results/`.

## Project layout

```
src/extraction   PDF -> ordered lines and blocks (pdfjs)
src/structure    TOC, parts, sections, boxes, exhibits, tables
src/chunking     chunks, parents, contextual prefix
src/ingestion    sync to Postgres, resumable embedding
src/search       vector, keyword (BM25), hybrid RRF, rerank, retrieve + gate, summaries
src/summaries    summary planning and generation
src/answer       router, source assembly, citation rewriting, streaming answers
src/chat         conversation store, follow-up rewriting, chat orchestration
src/routes       HTTP endpoints
public/          web UI (no build step)
scripts/         CLIs for each phase and the evaluations
eval/            question sets and saved results
docs/            report reconnaissance notes
```

## Phases

| # | Phase | Status |
|---|---|---|
| 0 | Setup and report reconnaissance ([notes](docs/report-notes.md)) | Done |
| 1 | PDF text extraction (columns, headers, page labels) | Done |
| 2 | Document structure (TOC -> section tree, figures, boxes, tables) | Done |
| 3 | Structure-aware chunking (parent-child, table row groups) | Done |
| 4 | Embeddings and storage (resumable ingestion) | Done |
| 5 | Vector search | Done |
| 6 | Evaluation set | Done |
| 7 | Hybrid search (BM25 in SQL, vector, exhibit lookup, RRF) | Done |
| 8 | Reranking (local MiniLM cross-encoder) and relevance gate | Done |
| 9 | Answer generation with citations, streaming | Done |
| 10 | Hierarchical summaries + broad/specific routing | Done |
| 11 | Conversation memory and follow-up rewriting | Done |
| 12 | Web UI, rate limiting, request logging, docs | Done |

## Known limitations

- Table 1.2 (country lists) and the regression tables are only partly aligned during extraction.
- Gemini free tier: about 20 answers/day on `gemini-3.6-flash`; the fallback model keeps the bot working.
- The reranker sometimes ranks prose above the numbers table for single-country questions; the table is
  still among the sources sent to the model.
- Routing is regex-based and conversation memory covers the last 3 exchanges.
- Rate limiting and the quota fallback state are in memory, so they reset on restart and are per process.
