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

const STAGES = [
  { key: "fetching", label: "Download" },
  { key: "chunking", label: "Split" },
  { key: "embedding", label: "Embed" },
  { key: "ready", label: "Ready" },
] as const;

const STAGE_DETAIL: Record<Progress["status"], string> = {
  queued: "Queued",
  fetching: "Downloading the filing from SEC EDGAR",
  chunking: "Splitting it into sections and passages",
  embedding: "Embedding passages",
  ready: "Ready to answer from",
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
  const stageIndex = progress
    ? STAGES.findIndex((stage) => stage.key === progress.status)
    : -1;

  return (
    <section className="border border-border bg-surface-raised p-6">
      <p className="label">Add a company</p>
      <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted">
        Downloads the most recent 10-K from SEC EDGAR, splits it by Item, and
        embeds every passage. A large filing takes several minutes and roughly
        one embedding request per passage, so keep this tab open until it
        finishes. Closing it pauses the job rather than losing it.
      </p>

      <form onSubmit={run} className="mt-5 flex gap-2">
        <input
          value={ticker}
          onChange={(e) => setTicker(e.target.value.toUpperCase())}
          placeholder="MSFT"
          aria-label="Ticker"
          maxLength={10}
          disabled={running}
          className="h-11 w-36 border border-border bg-background px-3 font-mono text-sm uppercase outline-none focus:shadow-[inset_0_-2px_0_0_var(--foreground)] disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={running || ticker.trim().length === 0}
          className="h-11 bg-accent px-6 text-sm font-medium text-accent-foreground transition-opacity hover:opacity-85 disabled:opacity-40"
        >
          {running ? "Ingesting..." : "Ingest"}
        </button>
      </form>

      {progress ? (
        <div className="mt-6">
          <ol className="flex flex-wrap gap-x-6 gap-y-1 font-mono text-[11px]">
            {STAGES.map((stage, i) => {
              const state =
                progress.status === "failed" && i === stageIndex
                  ? "failed"
                  : i < stageIndex || progress.status === "ready"
                    ? "done"
                    : i === stageIndex
                      ? "active"
                      : "todo";
              return (
                <li
                  key={stage.key}
                  className={
                    state === "failed"
                      ? "text-danger"
                      : state === "active"
                        ? "text-foreground"
                        : state === "done"
                          ? "text-muted line-through"
                          : "text-muted opacity-60"
                  }
                >
                  {i + 1}. {stage.label}
                </li>
              );
            })}
          </ol>

          <div className="mt-3 flex items-baseline justify-between text-xs">
            <span>
              {progress.ticker}: {STAGE_DETAIL[progress.status]}
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
            className="mt-2 h-1.5 w-full overflow-hidden bg-rule-soft"
          >
            <div
              className="h-full bg-foreground transition-all duration-300"
              style={{ width: `${progress.status === "ready" ? 100 : percent}%` }}
            />
          </div>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="mt-4 border-l-2 border-danger pl-3 text-sm text-danger">
          {error}
        </p>
      ) : null}
    </section>
  );
}
