/**
 * Advance an ingest job by one slice.
 *
 * The admin page calls this in a loop. Driving the loop from the browser rather
 * than from a scheduler is deliberate: it needs no cron frequency guarantees
 * from the hosting plan, it gives the operator a live progress bar, and a
 * closed tab simply pauses the job instead of losing it.
 */
import { authErrorResponse, requireAdmin } from "@/lib/auth";
import { stepIngest } from "@/lib/ingest";
import { supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  try {
    await requireAdmin();
  } catch (error) {
    return authErrorResponse(error) ?? Response.json({ error: "Unauthorised." }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as { jobId?: string } | null;
  const jobId = body?.jobId?.trim();

  if (!jobId || !UUID_PATTERN.test(jobId)) {
    return Response.json({ error: "Provide a valid job id." }, { status: 400 });
  }

  try {
    return Response.json(await stepIngest(supabaseAdmin(), jobId));
  } catch (error) {
    console.error("[ingest:step]", error);
    const message = error instanceof Error ? error.message : "The ingest step failed.";
    return Response.json({ error: message }, { status: 502 });
  }
}
