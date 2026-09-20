/**
 * Ingest as a resumable state machine.
 *
 * Adding one company means downloading a 10-K, splitting it into hundreds of
 * chunks, and calling an embedding API once per chunk. That does not fit in a
 * serverless request, and hiding it behind a longer timeout only moves the
 * failure. So the work is sliced, and the job row IS the progress:
 *
 *     queued -> fetching -> chunking -> embedding -> ready
 *                    \          \           \
 *                     +----------+-----------+--> failed
 *
 * Each call to `stepIngest` performs exactly one slice and returns. A browser
 * that closes mid-run leaves a resumable job rather than a half-written corpus,
 * because chunks are only searchable once their embedding is filled in.
 */
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  CHUNK_OVERLAP,
  CHUNK_SIZE,
  INGEST_BATCH_SIZE,
  MAX_CHUNKS_PER_FILING,
} from "@/config";
import { embed } from "@/lib/gemini";
import { chunkFiling } from "@/lib/rag/chunking";
import { fetchLatestTenK } from "@/lib/rag/edgar";

export type JobStatus =
  | "queued"
  | "fetching"
  | "chunking"
  | "embedding"
  | "ready"
  | "failed";

export interface JobProgress {
  jobId: string;
  status: JobStatus;
  ticker: string;
  totalChunks: number;
  embeddedChunks: number;
  done: boolean;
  error?: string;
}

const ROW_INSERT_BATCH = 200;

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function setJob(
  admin: SupabaseClient,
  jobId: string,
  patch: Record<string, unknown>,
) {
  await admin
    .from("fs_ingest_jobs")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", jobId);
}

/**
 * Stage one: create the job, download the filing, store its text.
 *
 * Kept separate from chunking so the slowest, least predictable part of the
 * pipeline, a multi-megabyte download from a third party, owns a request by
 * itself.
 */
export async function startIngest(
  admin: SupabaseClient,
  ticker: string,
  userId: string,
  userAgent: string,
): Promise<JobProgress> {
  const normalised = ticker.trim().toUpperCase();

  const { data: job, error: jobError } = await admin
    .from("fs_ingest_jobs")
    .insert({ ticker: normalised, status: "fetching", created_by: userId })
    .select("id")
    .single();

  if (jobError || !job) {
    throw new Error(`Could not create ingest job: ${jobError?.message ?? "unknown"}`);
  }
  const jobId = job.id as string;

  try {
    const filing = await fetchLatestTenK(normalised, userAgent);

    const { data: filingRow, error: filingError } = await admin
      .from("fs_filings")
      .upsert(
        {
          ticker: filing.ticker,
          company: filing.company,
          fiscal_year: filing.fiscalYear,
          source_url: filing.sourceUrl,
          accession: filing.accession,
          filing_date: filing.filingDate,
          is_ready: false,
          created_by: userId,
        },
        { onConflict: "ticker,fiscal_year" },
      )
      .select("id")
      .single();

    if (filingError || !filingRow) {
      throw new Error(filingError?.message ?? "Could not record the filing.");
    }

    await admin.from("fs_filing_text").upsert(
      {
        filing_id: filingRow.id,
        content: filing.text,
        char_count: filing.text.length,
      },
      { onConflict: "filing_id" },
    );

    await setJob(admin, jobId, { filing_id: filingRow.id, status: "chunking" });

    return {
      jobId,
      status: "chunking",
      ticker: normalised,
      totalChunks: 0,
      embeddedChunks: 0,
      done: false,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await setJob(admin, jobId, { status: "failed", error: message.slice(0, 500) });
    throw error;
  }
}

/** Advance a job by exactly one slice of work. */
export async function stepIngest(
  admin: SupabaseClient,
  jobId: string,
): Promise<JobProgress> {
  const { data: job, error } = await admin
    .from("fs_ingest_jobs")
    .select("id, filing_id, ticker, status, total_chunks, embedded_chunks, error")
    .eq("id", jobId)
    .single();

  if (error || !job) throw new Error(`Ingest job ${jobId} was not found.`);

  const progress: JobProgress = {
    jobId,
    status: job.status as JobStatus,
    ticker: job.ticker as string,
    totalChunks: job.total_chunks as number,
    embeddedChunks: job.embedded_chunks as number,
    done: job.status === "ready" || job.status === "failed",
    error: (job.error as string | null) ?? undefined,
  };

  if (progress.done) return progress;

  try {
    if (job.status === "chunking") return await runChunking(admin, job, progress);
    if (job.status === "embedding") return await runEmbedding(admin, job, progress);
    return progress;
  } catch (stepError) {
    const message = stepError instanceof Error ? stepError.message : String(stepError);
    await setJob(admin, jobId, { status: "failed", error: message.slice(0, 500) });
    return { ...progress, status: "failed", done: true, error: message };
  }
}

type JobRow = { id: string; filing_id: string | null; ticker: string };

async function runChunking(
  admin: SupabaseClient,
  job: JobRow & Record<string, unknown>,
  progress: JobProgress,
): Promise<JobProgress> {
  if (!job.filing_id) throw new Error("Job has no filing attached.");

  const { data: filing } = await admin
    .from("fs_filings")
    .select("id, ticker, company, fiscal_year, source_url")
    .eq("id", job.filing_id)
    .single();
  const { data: stored } = await admin
    .from("fs_filing_text")
    .select("content")
    .eq("filing_id", job.filing_id)
    .single();

  if (!filing || !stored) throw new Error("Filing text is missing, re-run the download.");

  const chunks = chunkFiling(
    stored.content as string,
    {
      ticker: filing.ticker as string,
      company: filing.company as string,
      fiscalYear: String(filing.fiscal_year),
      sourceUrl: filing.source_url as string,
    },
    CHUNK_SIZE,
    CHUNK_OVERLAP,
  );

  if (chunks.length === 0) throw new Error("Chunking produced nothing.");
  if (chunks.length > MAX_CHUNKS_PER_FILING) {
    throw new Error(
      `Chunking produced ${chunks.length} chunks, above the ${MAX_CHUNKS_PER_FILING} limit.`,
    );
  }

  // Replace rather than merge: a re-ingest with different chunk settings would
  // otherwise leave orphaned chunks from the previous run in the search index.
  await admin.from("fs_chunks").delete().eq("filing_id", filing.id);

  for (let i = 0; i < chunks.length; i += ROW_INSERT_BATCH) {
    const rows = chunks.slice(i, i + ROW_INSERT_BATCH).map((chunk) => ({
      chunk_id: chunk.chunkId,
      filing_id: filing.id,
      content: chunk.text,
      ticker: chunk.ticker,
      company: chunk.company,
      fiscal_year: chunk.fiscalYear,
      section: chunk.section,
      source_url: chunk.sourceUrl,
      ordinal: chunk.ordinal,
      embedding: null,
    }));
    const { error: insertError } = await admin.from("fs_chunks").upsert(rows);
    if (insertError) throw new Error(`Could not store chunks: ${insertError.message}`);
  }

  await setJob(admin, job.id, {
    status: "embedding",
    total_chunks: chunks.length,
    embedded_chunks: 0,
  });

  return {
    ...progress,
    status: "embedding",
    totalChunks: chunks.length,
    embeddedChunks: 0,
  };
}

async function runEmbedding(
  admin: SupabaseClient,
  job: JobRow & Record<string, unknown>,
  progress: JobProgress,
): Promise<JobProgress> {
  const { data: pending } = await admin
    .from("fs_chunks")
    .select("chunk_id, content")
    .eq("filing_id", job.filing_id)
    .is("embedding", null)
    .order("ordinal")
    .limit(INGEST_BATCH_SIZE);

  const batch = pending ?? [];

  if (batch.length === 0) {
    const { count } = await admin
      .from("fs_chunks")
      .select("chunk_id", { count: "exact", head: true })
      .eq("filing_id", job.filing_id);

    await admin
      .from("fs_filings")
      .update({ is_ready: true, chunk_count: count ?? 0 })
      .eq("id", job.filing_id);
    await setJob(admin, job.id, { status: "ready", embedded_chunks: count ?? 0 });

    return {
      ...progress,
      status: "ready",
      totalChunks: count ?? progress.totalChunks,
      embeddedChunks: count ?? progress.embeddedChunks,
      done: true,
    };
  }

  for (const row of batch) {
    const content = row.content as string;
    const hash = hashText(content);

    // The free tier allows 1,000 embed calls per day and one corpus is about
    // that size, so a repeated ingest without this cache can take the whole app
    // offline until the daily reset.
    const { data: cached } = await admin
      .from("fs_embedding_cache")
      .select("embedding")
      .eq("text_hash", hash)
      .maybeSingle();

    let vector: string;
    if (cached?.embedding) {
      vector = cached.embedding as string;
    } else {
      const values = await embed(content);
      vector = JSON.stringify(values);
      await admin
        .from("fs_embedding_cache")
        .upsert({ text_hash: hash, embedding: vector }, { onConflict: "text_hash" });
    }

    const { error: updateError } = await admin
      .from("fs_chunks")
      .update({ embedding: vector })
      .eq("chunk_id", row.chunk_id as string);
    if (updateError) throw new Error(`Could not store embedding: ${updateError.message}`);
  }

  const embedded = progress.embeddedChunks + batch.length;
  await setJob(admin, job.id, { embedded_chunks: embedded });

  return { ...progress, status: "embedding", embeddedChunks: embedded };
}
