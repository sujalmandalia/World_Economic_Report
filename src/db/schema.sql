CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS documents (
  id              serial PRIMARY KEY,
  source          text NOT NULL UNIQUE,
  file_hash       text NOT NULL,
  title           text,
  page_count      int NOT NULL,
  glossary        jsonb NOT NULL DEFAULT '{}',
  chunk_options   jsonb NOT NULL DEFAULT '{}',
  embedding_model text NOT NULL,
  embedding_dims  int NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS parents (
  id           bigserial PRIMARY KEY,
  document_id  int NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  key          text NOT NULL,
  part         text NOT NULL,
  section_path text[] NOT NULL,
  box          text,
  pdf_pages    int[] NOT NULL,
  page_labels  text[] NOT NULL,
  text         text NOT NULL,
  tokens       int NOT NULL,
  UNIQUE (document_id, key)
);

CREATE TABLE IF NOT EXISTS chunks (
  id           bigserial PRIMARY KEY,
  document_id  int NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  content_hash text NOT NULL,
  key          text NOT NULL,
  ordinal      int NOT NULL,
  parent_id    bigint REFERENCES parents(id) ON DELETE SET NULL,
  type         text NOT NULL CHECK (type IN ('text', 'figure', 'table', 'footnotes', 'credit')),
  part         text NOT NULL,
  section_path text[] NOT NULL,
  box          text,
  exhibit      text,
  pdf_pages    int[] NOT NULL,
  page_labels  text[] NOT NULL,
  context      text NOT NULL,
  text         text NOT NULL,
  tokens       int NOT NULL,
  embedding    vector(768),
  embedded_at  timestamptz,
  UNIQUE (document_id, content_hash)
);

CREATE INDEX IF NOT EXISTS chunks_document_ordinal_idx ON chunks (document_id, ordinal);
CREATE INDEX IF NOT EXISTS chunks_pending_idx ON chunks (document_id, ordinal) WHERE embedding IS NULL;
CREATE INDEX IF NOT EXISTS chunks_embedding_hnsw_idx ON chunks USING hnsw (embedding vector_cosine_ops);

ALTER TABLE chunks ADD COLUMN IF NOT EXISTS tsv tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('english', context), 'A') || setweight(to_tsvector('english', text), 'B')
) STORED;

CREATE INDEX IF NOT EXISTS chunks_tsv_idx ON chunks USING gin (tsv);

CREATE TABLE IF NOT EXISTS summaries (
  id           bigserial PRIMARY KEY,
  document_id  int NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  key          text NOT NULL,
  level        text NOT NULL CHECK (level IN ('document', 'part', 'section')),
  part         text,
  title        text NOT NULL,
  pdf_pages    int[] NOT NULL,
  page_labels  text[] NOT NULL,
  source_hash  text NOT NULL,
  model        text NOT NULL,
  text         text NOT NULL,
  tokens       int NOT NULL,
  embedding    vector(768),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, key)
);

CREATE TABLE IF NOT EXISTS conversations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id                  bigserial PRIMARY KEY,
  conversation_id     uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role                text NOT NULL CHECK (role IN ('user', 'assistant')),
  content             text NOT NULL,
  standalone_question text,
  route               jsonb,
  sources             jsonb,
  model               text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages (conversation_id, id);
