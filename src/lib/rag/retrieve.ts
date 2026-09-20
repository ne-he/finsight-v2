/**
 * Retrieval: query understanding, hybrid search, and the confidence gate.
 *
 * The ranking itself runs in Postgres (see supabase/migrations/0003_search.sql).
 * What stays here is everything that is easier to read, test and change in
 * application code: deciding which filing a question is about, deciding whether
 * the filter is safe to apply, and deciding whether the best match is good
 * enough to answer from.
 */
import { CONFIDENCE_THRESHOLD, FINAL_K, RRF_K, TOP_K_DENSE, TOP_K_SPARSE } from "@/config";
import { embed } from "@/lib/gemini";
import type { SupabaseClient } from "@supabase/supabase-js";

import { detectFilters, isOverConstrained, type FilingRef } from "./filters";

export interface RetrievedChunk {
  chunkId: string;
  content: string;
  ticker: string;
  company: string;
  fiscalYear: string;
  section: string;
  sourceUrl: string;
  similarity: number;
}

export interface RetrievalResult {
  chunks: RetrievedChunk[];
  topCosine: number;
  /** True means retrieval was too weak to answer from, so refuse instead. */
  gated: boolean;
  filters: { tickers: string[]; years: string[] };
}

interface MatchRow {
  chunk_id: string;
  content: string;
  ticker: string;
  company: string;
  fiscal_year: string;
  section: string;
  source_url: string;
  similarity: number;
  rrf_score: number;
  top_cosine: number;
}

/** The ingested filings, which are also the alias table for query parsing. */
export async function loadFilings(client: SupabaseClient): Promise<FilingRef[]> {
  const { data, error } = await client
    .from("fs_filings")
    .select("ticker, company, fiscal_year")
    .eq("is_ready", true);

  if (error) throw new Error(`Could not load filings: ${error.message}`);
  return (data ?? []).map((row) => ({
    ticker: row.ticker as string,
    company: row.company as string,
    fiscalYear: String(row.fiscal_year),
  }));
}

export async function retrieve(
  client: SupabaseClient,
  query: string,
  filings: FilingRef[],
): Promise<RetrievalResult> {
  const detected = detectFilters(query, filings);

  // An over-constrained filter selects no filing at all, which would starve
  // retrieval and make the gate refuse a question the corpus can partly
  // answer. Dropping the filter and letting the gate judge is strictly better.
  const filters = isOverConstrained(detected, filings)
    ? { tickers: [], years: [] }
    : detected;

  const queryEmbedding = await embed(query);

  const { data, error } = await client.rpc("fs_match_chunks", {
    // pgvector accepts its text form, and JSON.stringify of a number array is
    // exactly that form.
    query_embedding: JSON.stringify(queryEmbedding),
    query_text: query,
    filter_tickers: filters.tickers,
    filter_years: filters.years,
    k_dense: TOP_K_DENSE,
    k_sparse: TOP_K_SPARSE,
    rrf_k: RRF_K,
    final_k: FINAL_K,
  });

  if (error) throw new Error(`fs_match_chunks failed: ${error.message}`);

  const rows = (data ?? []) as MatchRow[];
  const chunks: RetrievedChunk[] = rows.map((row) => ({
    chunkId: row.chunk_id,
    content: row.content,
    ticker: row.ticker,
    company: row.company,
    fiscalYear: String(row.fiscal_year),
    section: row.section,
    sourceUrl: row.source_url,
    similarity: Number(row.similarity ?? 0),
  }));

  // The gate reads the best DENSE cosine, computed before fusion, so it stays
  // comparable to the measurement that chose the threshold.
  const topCosine = rows.length > 0 ? Number(rows[0].top_cosine ?? 0) : 0;

  return {
    chunks,
    topCosine,
    gated: topCosine < CONFIDENCE_THRESHOLD,
    filters,
  };
}

/** One entry per cited section, for the sources list shown under an answer. */
export function sourcesOf(chunks: RetrievedChunk[]) {
  const seen = new Map<string, {
    ticker: string;
    fiscalYear: string;
    section: string;
    sourceUrl: string;
    score: number;
  }>();

  for (const chunk of chunks) {
    const key = `${chunk.ticker}|${chunk.fiscalYear}|${chunk.section}`;
    const existing = seen.get(key);
    if (!existing || chunk.similarity > existing.score) {
      seen.set(key, {
        ticker: chunk.ticker,
        fiscalYear: chunk.fiscalYear,
        section: chunk.section,
        sourceUrl: chunk.sourceUrl,
        score: Math.round(chunk.similarity * 10000) / 10000,
      });
    }
  }
  return [...seen.values()];
}
