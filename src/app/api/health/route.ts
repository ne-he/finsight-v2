/**
 * Health check that can actually fail.
 *
 * A route that always answers `{"status":"ok"}` is decoration. This one checks
 * the two dependencies that make the app useless when they are down: the
 * database is reachable, and the corpus has at least one ready filing with
 * embeddings in it. Either missing is a 503, so an uptime monitor sees the
 * outage instead of a green tick over an app that refuses every question.
 */
import { supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const checks: Record<string, boolean> = { database: false, corpus: false };
  let detail = "";

  try {
    const admin = supabaseAdmin();

    const { count: filings, error: filingError } = await admin
      .from("fs_filings")
      .select("id", { count: "exact", head: true })
      .eq("is_ready", true);
    if (filingError) throw new Error(filingError.message);
    checks.database = true;

    const { count: chunks, error: chunkError } = await admin
      .from("fs_chunks")
      .select("chunk_id", { count: "exact", head: true })
      .not("embedding", "is", null);
    if (chunkError) throw new Error(chunkError.message);

    checks.corpus = (filings ?? 0) > 0 && (chunks ?? 0) > 0;
    if (!checks.corpus) detail = "No ready filing with embeddings. Run an ingest.";

    const healthy = checks.database && checks.corpus;
    return Response.json(
      {
        status: healthy ? "ok" : "degraded",
        checks,
        filings: filings ?? 0,
        embeddedChunks: chunks ?? 0,
        detail: detail || undefined,
      },
      { status: healthy ? 200 : 503 },
    );
  } catch (error) {
    // The message may carry connection details, so it is logged and not returned.
    console.error("[health]", error);
    return Response.json(
      { status: "down", checks, detail: "A dependency check failed." },
      { status: 503 },
    );
  }
}
