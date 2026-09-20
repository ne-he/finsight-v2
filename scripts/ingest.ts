/**
 * Ingest a filing from the command line.
 *
 * Runs the exact same state machine the admin page drives, one slice at a time,
 * so this is not a second implementation that can drift from the first. It
 * exists for two jobs the browser is bad at: seeding a fresh deployment before
 * anyone has signed up, and re-ingesting several companies in one go.
 *
 *     npm run ingest -- NVDA
 *     npm run ingest -- NVDA AAPL MSFT
 *
 * Embedding is the expensive part. The free tier allows 1,000 requests a day
 * and one filing is roughly 350, so the script reports what it spent and
 * refuses to start a company it has already finished unless asked to redo it.
 *
 *     npm run ingest -- NVDA --force
 */
import "./load-env";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { startIngest, stepIngest, type JobProgress } from "../src/lib/ingest";

const STAGE: Record<JobProgress["status"], string> = {
  queued: "queued",
  fetching: "downloading from SEC",
  chunking: "splitting into sections",
  embedding: "embedding",
  ready: "ready",
  failed: "failed",
};

function line(text: string) {
  // Rewrite one line rather than scrolling hundreds of progress updates.
  // Padding to a fixed width clears whatever the previous, longer line left
  // behind, which an ANSI erase sequence would do but not on every terminal.
  process.stdout.write(`\r  ${text.padEnd(60)}`);
}

async function ingestOne(
  admin: SupabaseClient,
  ticker: string,
  force: boolean,
): Promise<{ ok: boolean; embedded: number }> {
  console.log(`\n${ticker}`);

  if (!force) {
    const { data } = await admin
      .from("fs_filings")
      .select("fiscal_year, chunk_count")
      .eq("ticker", ticker)
      .eq("is_ready", true)
      .maybeSingle();
    const existing = data as { fiscal_year: string; chunk_count: number } | null;

    if (existing) {
      console.log(
        `  already ingested (FY${existing.fiscal_year}, ${existing.chunk_count} chunks). Pass --force to redo it.`,
      );
      return { ok: true, embedded: 0 };
    }
  }

  let progress: JobProgress;
  try {
    // No user id: the corpus is not owned by whoever seeded it.
    progress = await startIngest(admin, ticker, null, process.env.EDGAR_USER_AGENT!);
  } catch (error) {
    console.log(`  failed: ${error instanceof Error ? error.message : error}`);
    return { ok: false, embedded: 0 };
  }

  const startedAt = Date.now();
  let embedded = 0;

  for (let i = 0; i < 400 && !progress.done; i++) {
    const before = progress.embeddedChunks;
    progress = await stepIngest(admin, progress.jobId);
    embedded += Math.max(0, progress.embeddedChunks - before);

    const total = progress.totalChunks;
    const percent = total > 0 ? Math.round((progress.embeddedChunks / total) * 100) : 0;
    line(
      `${STAGE[progress.status]}  ${total > 0 ? `${progress.embeddedChunks}/${total} (${percent}%)` : ""}`,
    );
  }

  const seconds = ((Date.now() - startedAt) / 1000).toFixed(0);

  if (progress.status === "ready") {
    line(`ready  ${progress.totalChunks} chunks in ${seconds}s\n`);
    return { ok: true, embedded };
  }
  line(`${progress.status}  ${progress.error ?? "stopped before finishing"}\n`);
  return { ok: false, embedded };
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const tickers = args
    .filter((a) => !a.startsWith("--"))
    .map((a) => a.trim().toUpperCase());

  if (tickers.length === 0) {
    console.error("Usage: npm run ingest -- <TICKER> [TICKER...] [--force]");
    process.exit(1);
  }

  const admin: SupabaseClient = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );

  let spent = 0;
  let failed = 0;
  for (const ticker of tickers) {
    const result = await ingestOne(admin, ticker, force);
    spent += result.embedded;
    if (!result.ok) failed++;
  }

  console.log(
    `\nEmbedding requests spent this run: ${spent} of the 1,000 daily free tier.`,
  );
  if (failed > 0) {
    console.log(`${failed} of ${tickers.length} companies failed.`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`\n${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
