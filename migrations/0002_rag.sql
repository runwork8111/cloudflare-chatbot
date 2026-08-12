-- Knowledge-base documents per tenant, and their chunked+embedded pieces.
-- v0 scope: plain text/markdown uploads only (no PDF/docx extraction yet).

CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | processing | ready | failed
  error TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_documents_tenant ON documents(tenant_id, created_at);

-- vector_id is the id used in the Vectorize index for this chunk, so a
-- retrieval hit can be joined straight back to its text and source
-- document without storing chunk content in Vectorize metadata.
CREATE TABLE document_chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  vector_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_document_chunks_document ON document_chunks(document_id, chunk_index);
CREATE INDEX idx_document_chunks_vector ON document_chunks(vector_id);
