import type { Env } from "../types";

// Minimal shape of the three VectorizeIndex methods this project uses.
// Exists so ingestion/retrieval code can take a fake implementation in
// tests — Vectorize has no local-dev simulation in Wrangler (confirmed via
// the "Vectorize Index bindings do not support local development" warning),
// so without this seam, none of the RAG code could be exercised by an
// automated test at all.
export interface VectorIndexClient {
  upsert(
    vectors: { id: string; values: number[]; metadata?: Record<string, string> }[]
  ): Promise<unknown>;
  query(
    vector: number[],
    options: { topK: number; filter?: Record<string, string> }
  ): Promise<{ matches: { id: string; score: number }[] }>;
  deleteByIds(ids: string[]): Promise<unknown>;
}

export function defaultVectorIndex(env: Env): VectorIndexClient {
  return env.VECTOR_INDEX;
}
