/**
 * Stage one of an ingest: create the job and download the filing.
 *
 * The client is expected to call `/api/admin/ingest/step` repeatedly after
 * this, until the returned progress reports `done`.
 */
import { authErrorResponse, requireAdmin } from "@/lib/auth";
import { env } from "@/lib/env";
import { startIngest } from "@/lib/ingest";
import { supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const TICKER_PATTERN = /^[A-Za-z.\-]{1,10}$/;

export async function POST(request: Request) {
  let viewer;
  try {
    viewer = await requireAdmin();
  } catch (error) {
    return authErrorResponse(error) ?? Response.json({ error: "Unauthorised." }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as { ticker?: string } | null;
  const ticker = body?.ticker?.trim();

  // The ticker is interpolated into an SEC URL, so it is validated against a
  // strict pattern rather than merely trimmed.
  if (!ticker || !TICKER_PATTERN.test(ticker)) {
    return Response.json(
      { error: "Provide a ticker symbol, for example NVDA." },
      { status: 400 },
    );
  }

  try {
    const progress = await startIngest(
      supabaseAdmin(),
      ticker,
      viewer.id,
      env().EDGAR_USER_AGENT,
    );
    return Response.json(progress, { status: 202 });
  } catch (error) {
    console.error("[ingest:start]", error);
    const message = error instanceof Error ? error.message : "Ingest could not be started.";
    return Response.json({ error: message }, { status: 502 });
  }
}
