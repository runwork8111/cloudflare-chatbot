import type { Env } from "../types";
import { chunkText } from "./chunking";
import { embedTexts } from "./openai";
import { defaultVectorIndex, type VectorIndexClient } from "./vector-index";

export interface IngestionDeps {
  embed: typeof embedTexts;
  vectorIndex: VectorIndexClient;
}

// Runs entirely inside the queue consumer (index.ts's `queue` handler), not
// the request path — chunking + embedding a real document can take seconds,
// far past what an HTTP request from the widget or admin dashboard should
// block on.
export async function ingestDocument(
  env: Env,
  tenantId: string,
  documentId: string,
  deps: IngestionDeps = { embed: embedTexts, vectorIndex: defaultVectorIndex(env) }
): Promise<void> {
  const doc = await env.DB.prepare(
    `SELECT r2_key, filename FROM documents WHERE id = ?1 AND tenant_id = ?2`
  )
    .bind(documentId, tenantId)
    .first<{ r2_key: string; filename: string }>();

  if (!doc) throw new Error(`Document ${documentId} not found for tenant ${tenantId}`);

  await env.DB.prepare(`UPDATE documents SET status = 'processing', updated_at = unixepoch() WHERE id = ?1`)
    .bind(documentId)
    .run();

  try {
    const object = await env.DOCS_BUCKET.get(doc.r2_key);
    if (!object) throw new Error(`R2 object missing at ${doc.r2_key}`);

    const text = await object.text();
    const chunks = chunkText(text);
    if (chunks.length === 0) throw new Error("Document produced no chunks (empty after trimming)");

    const embeddings = await deps.embed(env, chunks);

    const chunkRows = chunks.map((content, index) => ({
      id: crypto.randomUUID(),
      vectorId: `${documentId}:${index}`,
      content,
      index,
    }));

    await deps.vectorIndex.upsert(
      chunkRows.map((row, i) => ({
        id: row.vectorId,
        values: embeddings[i],
        metadata: { tenantId, documentId },
      }))
    );

    await env.DB.batch([
      ...chunkRows.map((row) =>
        env.DB.prepare(
          `INSERT INTO document_chunks (id, document_id, tenant_id, chunk_index, content, vector_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
        ).bind(row.id, documentId, tenantId, row.index, row.content, row.vectorId)
      ),
      env.DB.prepare(`UPDATE documents SET status = 'ready', updated_at = unixepoch() WHERE id = ?1`).bind(
        documentId
      ),
    ]);
  } catch (err) {
    await env.DB.prepare(
      `UPDATE documents SET status = 'failed', error = ?2, updated_at = unixepoch() WHERE id = ?1`
    )
      .bind(documentId, String(err))
      .run();
    throw err;
  }
}
