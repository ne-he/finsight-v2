/**
 * The question endpoint for guests: no account, small quota, nothing saved.
 *
 * Counting happens in the database before any paid work (migration 0006), keyed
 * by a daily HMAC of the caller's IP. Guest questions also count against the
 * global cap shared with signed-in users.
 */
import { answerResponse, parseQuestion } from "@/lib/answer-stream";
import { env } from "@/lib/env";
import { clientAddress, GUEST_MAX_MESSAGES, visitorId } from "@/lib/guest";
import { supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(request: Request) {
  const address = clientAddress(request.headers);
  if (!address) {
    return Response.json({ error: "Guest mode is unavailable here." }, { status: 403 });
  }

  const parsed = parseQuestion(await request.json().catch(() => null), GUEST_MAX_MESSAGES);
  if (parsed instanceof Response) return parsed;

  const config = env();
  const { data: usage, error: usageError } = await supabaseAdmin()
    .rpc("fs_bump_guest_usage", {
      p_visitor: visitorId(address, config.SUPABASE_SERVICE_ROLE_KEY),
      p_visitor_limit: config.GUEST_LIMIT_PER_VISITOR,
      p_guest_limit: config.GUEST_LIMIT_DAILY,
      p_global_limit: config.DAILY_LIMIT_GLOBAL,
    })
    .single();

  if (usageError) {
    console.error("[guest] usage check failed", usageError);
    return Response.json(
      { error: "Guest mode is not available right now. Sign in to ask." },
      { status: 503 },
    );
  }

  const quota = usage as { allowed: boolean; reason: string | null };
  if (!quota.allowed) {
    const error =
      quota.reason === "visitor"
        ? `Guests can ask ${config.GUEST_LIMIT_PER_VISITOR} questions a day. Sign in for ${config.DAILY_LIMIT_PER_USER} a day and saved history.`
        : "Guest questions are used up for today. Sign in to keep asking.";
    return Response.json({ error }, { status: 429, headers: { "Retry-After": "3600" } });
  }

  return answerResponse({ ...parsed, conversationId: null });
}
