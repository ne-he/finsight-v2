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

import { balanceAcross, perListQuota } from "./balance";
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

  // pgvector accepts its text form, and JSON.stringify of a number array is
  // exactly that form. One embedding serves every search below.
  const vector = JSON.stringify(await embed(query));

  let rows: MatchRow[];
  if (filters.tickers.length > 1) {
    // A comparison. Search each company on its own so neither can crowd the
    // other out of the context, then interleave. See balance.ts.
    const quota = perListQuota(filters.tickers.length, FINAL_K);
    const lists = await Promise.all(
      filters.tickers.map((ticker) =>
        matchChunks(client, vector, query, [ticker], filters.years, quota),
      ),
    );
    rows = balanceAcross(lists, FINAL_K);
  } else {
    rows = await matchChunks(client, vector, query, filters.tickers, filters.years, FINAL_K);
  }
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
  // comparable to the measurement that chose the threshold. In a comparison
  // each search reports its own, and the best of them is the one that counts.
  const topCosine = rows.reduce((best, row) => Math.max(best, Number(row.top_cosine ?? 0)), 0);

  return {
    chunks,
    topCosine,
    gated: topCosine < CONFIDENCE_THRESHOLD,
    filters,
  };
}

async function matchChunks(
  client: SupabaseClient,
  vector: string,
  query: string,
  tickers: string[],
  years: string[],
  finalK: number,
): Promise<MatchRow[]> {
  const { data, error } = await client.rpc("fs_match_chunks", {
    query_embedding: vector,
    query_text: query,
    filter_tickers: tickers,
    filter_years: years,
    k_dense: TOP_K_DENSE,
    k_sparse: TOP_K_SPARSE,
    rrf_k: RRF_K,
    final_k: finalK,
  });

  if (error) throw new Error(`fs_match_chunks failed: ${error.message}`);
  return (data ?? []) as MatchRow[];
}

export interface SourceRef {
  ticker: string;
  fiscalYear: string;
  section: string;
  sourceUrl: string;
  score: number;
  /**
   * The retrieved passages from this section, exactly as the model read them.
   * Shipping them to the page is what lets a reader check a citation against
   * the words it came from, instead of against a 300-page filing.
   */
  passages: string[];
}

/** One entry per cited section, in retrieval order, with its passages. */
export function sourcesOf(chunks: RetrievedChunk[]): SourceRef[] {
  const seen = new Map<string, SourceRef>();

  for (const chunk of chunks) {
    const key = `${chunk.ticker}|${chunk.fiscalYear}|${chunk.section}`;
    const score = Math.round(chunk.similarity * 10000) / 10000;
    const existing = seen.get(key);
    if (existing) {
      existing.score = Math.max(existing.score, score);
      existing.passages.push(chunk.content);
    } else {
      seen.set(key, {
        ticker: chunk.ticker,
        fiscalYear: chunk.fiscalYear,
        section: chunk.section,
        sourceUrl: chunk.sourceUrl,
        score,
        passages: [chunk.content],
      });
    }
  }
  return [...seen.values()];
}
