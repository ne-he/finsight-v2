/**
 * Central tuning knobs for the retrieval pipeline.
 *
 * Pure constants only: this module is imported by both server and client code,
 * so it must never read a secret. Server-only environment values live in
 * `src/lib/env.ts`.
 *
 * The numbers below were carried over from the Python implementation of
 * FinSight v1. They are a STARTING POINT, not a result: v2 replaces the
 * in-process BM25 index with Postgres full-text search, so the confidence
 * threshold has to be re-measured against the new retriever before any of these
 * values can be quoted as tuned. See `scripts/run-eval.ts`.
 */

/** Gemini model used to turn text into vectors. */
export const EMBEDDING_MODEL = "gemini-embedding-001";

/**
 * Native output is 3072-dim. We request 768 (Matryoshka) so the pgvector column
 * stays small enough for the free tier and matches the v1 index layout.
 */
export const EMBEDDING_DIM = 768;

/**
 * Answer generation, in preference order. Free-tier quota is per-model, so a
 * single exhausted model would otherwise take the whole app down for the day.
 */
export const CHAT_MODELS = [
  "gemini-2.5-flash",
  "gemini-flash-latest",
  "gemini-2.5-flash-lite",
] as const;

/** Characters per chunk, and how much of the previous chunk each one repeats. */
export const CHUNK_SIZE = 1200;
export const CHUNK_OVERLAP = 200;

/** Candidates pulled from each retrieval arm before fusion. */
export const TOP_K_DENSE = 10;
export const TOP_K_SPARSE = 10;

/** Chunks handed to the model as context. */
export const FINAL_K = 6;

/** Reciprocal Rank Fusion damping constant. Larger means flatter weighting. */
export const RRF_K = 60;

/**
 * Below this cosine the retrieved context is treated as not covering the
 * question, and the answer becomes an honest refusal instead of a guess.
 *
 * v1 measured legitimate questions at 0.72 to 0.80 and out-of-scope ones at
 * 0.55 to 0.63, and picked the midpoint of that gap. v2 inherits the number but
 * NOT the evidence: re-run the eval harness before treating it as tuned.
 */
export const CONFIDENCE_THRESHOLD = 0.68;

/** Payload guards. A genuine session stays far below all three. */
export const MAX_MESSAGES = 40;
export const MAX_MESSAGE_CHARS = 2000;
export const MAX_TOTAL_CHARS = 16000;

/**
 * How many chunks one `/api/admin/ingest/step` call embeds.
 *
 * This is the single most important number for running on serverless: the whole
 * ingest of a filing is hundreds of embedding calls and cannot fit in one
 * request, so the work is sliced and the client drives the loop. Keep the slice
 * small enough that a step finishes well inside the function time limit even
 * when Gemini is slow.
 */
export const INGEST_BATCH_SIZE = 12;

/** Ceiling on chunks accepted from a single filing, a guard against a runaway parse. */
export const MAX_CHUNKS_PER_FILING = 1500;
