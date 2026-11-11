/**
 * The question endpoint for signed-in users.
 *
 * Order of work, and why it is this order:
 *   1. Identify the caller. Everything here costs free-tier quota.
 *   2. Bound the payload before doing any paid work.
 *   3. Count the question against the daily cap, atomically, in the database.
 *   4. Retrieve, then stream the answer (`lib/answer-stream.ts`), then save it.
 *
 * Guests use `/api/guest/chat`, which shares step 4 and nothing else.
 */
import { MAX_MESSAGES } from "@/config";
import { answerResponse, parseQuestion, type AnswerRecord } from "@/lib/answer-stream";
import { authErrorResponse, requireViewer } from "@/lib/auth";
import { env } from "@/lib/env";
import { supabaseAdmin, supabaseServer } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/**
 * Ceiling for the streamed response. Kept at the value already proven on this
 * Vercel account rather than the plan maximum, because retrieval plus a full
 * answer finishes well inside it and a longer ceiling would only delay the
 * moment a stuck request gives up.
 */
export const maxDuration = 30;

export async function POST(request: Request) {
  let viewer;
  try {
    viewer = await requireViewer();
  } catch (error) {
    return authErrorResponse(error) ?? Response.json({ error: "Unauthorised." }, { status: 401 });
  }

  const parsed = parseQuestion(await request.json().catch(() => null), MAX_MESSAGES);
  if (parsed instanceof Response) return parsed;

  const config = env();
  const { data: usage, error: usageError } = await supabaseAdmin()
    .rpc("fs_bump_usage", {
      p_user: viewer.id,
      p_user_limit: config.DAILY_LIMIT_PER_USER,
      p_global_limit: config.DAILY_LIMIT_GLOBAL,
    })
    .single();

  if (usageError) {
    console.error("[chat] usage check failed", usageError);
    return Response.json({ error: "Could not verify your daily quota." }, { status: 503 });
  }
  const quota = usage as { allowed: boolean; reason: string | null };
  if (!quota.allowed) {
    return Response.json(
      {
        error:
          quota.reason === "global"
            ? "FinSight has reached its shared daily limit. Please try again tomorrow."
            : "You have reached your daily question limit. Please try again tomorrow.",
      },
      { status: 429, headers: { "Retry-After": "3600" } },
    );
  }

  const supabase = await supabaseServer();
  return answerResponse(parsed, (record) =>
    persist(supabase, viewer.id, parsed.conversationId, record),
  );
}

type Supabase = Awaited<ReturnType<typeof supabaseServer>>;

async function persist(
  supabase: Supabase,
  userId: string,
  conversationId: string | null,
  record: AnswerRecord,
): Promise<{ conversationId: string; messageId: string }> {
  let id = conversationId;

  if (!id) {
    const { data, error } = await supabase
      .from("fs_conversations")
      .insert({ user_id: userId, title: record.question.slice(0, 80) })
      .select("id")
      .single();
    if (error || !data) throw new Error(error?.message ?? "Could not open a conversation.");
    id = data.id as string;
  } else {
    await supabase
      .from("fs_conversations")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", id);
  }

  await supabase
    .from("fs_messages")
    .insert({ conversation_id: id, role: "user", content: record.question });

  const { data: assistant, error: assistantError } = await supabase
    .from("fs_messages")
    .insert({
      conversation_id: id,
      role: "assistant",
      content: record.answer,
      citations: record.citations,
      top_cosine: record.topCosine,
      gated: record.gated,
      degraded: record.degraded,
      latency_ms: record.latencyMs,
    })
    .select("id")
    .single();

  if (assistantError || !assistant) {
    throw new Error(assistantError?.message ?? "Could not save the answer.");
  }
  return { conversationId: id, messageId: assistant.id as string };
}
