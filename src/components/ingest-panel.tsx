"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

interface Progress {
  jobId: string;
  status: "queued" | "fetching" | "chunking" | "embedding" | "ready" | "failed";
  ticker: string;
  totalChunks: number;
  embeddedChunks: number;
  done: boolean;
  error?: string;
}

const STAGE_LABEL: Record<Progress["status"], string> = {
  queued: "Queued",
  fetching: "Downloading the filing from SEC",
  chunking: "Splitting it into sections and chunks",
  embedding: "Embedding chunks",
  ready: "Ready",
  failed: "Failed",
};

/**
 * Drives the ingest loop from the browser.
 *
 * Each `step` call does one slice of work on the server and returns the new
 * progress, and this keeps calling until the job reports `done`. Running the
 * loop here rather than on a schedule means it needs no cron frequency
 * guarantee from the hosting plan, and the operator sees real progress instead
 * of a spinner.
 *
 * A closed tab pauses the job rather than losing it: the state lives in the
 * database, and resuming is just calling `step` again.
 */
export function IngestPanel() {
  const router = useRouter();
  const [ticker, setTicker] = useState("");
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  async function post(url: string, body: unknown) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok) throw new Error((json?.error as string) ?? "The request failed.");
    return json as unknown as Progress;
  }

  async function run(event: React.FormEvent) {
    event.preventDefault();
    if (running) return;

    setRunning(true);
    setError(null);
    setProgress(null);

    try {
      let current = await post("/api/admin/ingest/start", { ticker: ticker.trim() });
      setProgress(current);

      // A bounded loop rather than `while (!done)`: a server bug that never
      // advances the job would otherwise hammer the endpoint forever.
      for (let i = 0; i < 400 && !current.done; i++) {
        current = await post("/api/admin/ingest/step", { jobId: current.jobId });
        setProgress(current);
      }

      if (current.status === "failed") {
        setError(current.error ?? "The ingest failed.");
      } else if (current.done) {
        setTicker("");
        router.refresh();
      } else {
        setError("Stopped after too many steps. Check the job in the database.");
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Something went wrong.");
    } finally {
      setRunning(false);
    }
  }

  const percent =
    progress && progress.totalChunks > 0
      ? Math.round((progress.embeddedChunks / progress.totalChunks) * 100)
      : 0;

  return (
    <section className="rounded-lg border border-border bg-surface p-4">
      <h2 className="text-sm font-medium">Add a company</h2>
      <p className="mt-1 text-xs text-muted">
        Downloads the most recent 10-K from SEC EDGAR, then chunks and embeds
        it. Keep this tab open until it finishes.
      </p>

      <form onSubmit={run} className="mt-4 flex gap-2">
        <input
          value={ticker}
          onChange={(e) => setTicker(e.target.value.toUpperCase())}
          placeholder="NVDA"
          maxLength={10}
          disabled={running}
          className="h-10 w-32 rounded-md border border-border bg-surface-raised px-3 font-mono text-sm uppercase outline-none focus:border-accent disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={running || ticker.trim().length === 0}
          className="h-10 rounded-md bg-accent px-4 text-sm font-medium text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {running ? "Ingesting..." : "Ingest"}
        </button>
      </form>

      {progress ? (
        <div className="mt-4 space-y-2">
          <div className="flex justify-between text-xs">
            <span>
              {progress.ticker}: {STAGE_LABEL[progress.status]}
            </span>
            {progress.totalChunks > 0 ? (
              <span className="font-mono text-muted">
                {progress.embeddedChunks}/{progress.totalChunks}
              </span>
            ) : null}
          </div>
          <div
            role="progressbar"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
            className="h-1.5 w-full overflow-hidden rounded-full bg-border"
          >
            <div
              className="h-full bg-accent transition-all duration-300"
              style={{ width: `${progress.status === "ready" ? 100 : percent}%` }}
            />
          </div>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="mt-3 text-xs text-danger">
          {error}
        </p>
      ) : null}
    </section>
  );
}
