/**
 * Keep-alive ping for the Supabase free tier, which pauses a project after
 * roughly seven days without database activity. A paused database means every
 * question fails, so this route exists purely to touch a table on a schedule.
 *
 * Driven by the Vercel cron in `vercel.json`, with a GitHub Actions workflow as
 * a backup in case the cron is unavailable on the current plan.
 *
 * Deliberately does not call Gemini, so a daily ping never spends generation or
 * embedding quota.
 */
import { env } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  // Vercel signs its cron calls; anything else must present the shared secret.
  // Without this the route is a free way for anyone to generate database load.
  const secret = env().CRON_SECRET;
  if (secret) {
    const provided = request.headers.get("authorization");
    const isVercelCron = request.headers.get("user-agent")?.includes("vercel-cron");
    if (!isVercelCron && provided !== `Bearer ${secret}`) {
      return Response.json({ error: "Forbidden." }, { status: 403 });
    }
  }

  const startedAt = Date.now();
  try {
    const { count, error } = await supabaseAdmin()
      .from("fs_chunks")
      .select("chunk_id", { count: "exact", head: true });
    if (error) throw new Error(error.message);

    return Response.json({ ok: true, chunks: count ?? 0, ms: Date.now() - startedAt });
  } catch (error) {
    console.error("[keep-alive]", error);
    return Response.json({ ok: false }, { status: 503 });
  }
}
