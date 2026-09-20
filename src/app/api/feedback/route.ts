/**
 * Record a thumbs up or down on an answer.
 *
 * Written through the user's own session, so the Row Level Security policy
 * decides whether they may rate this message. The unique constraint on
 * (message_id, user_id) turns a second rating into an update rather than a
 * duplicate row.
 */
import { authErrorResponse, requireViewer } from "@/lib/auth";
import { supabaseServer } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let viewer;
  try {
    viewer = await requireViewer();
  } catch (error) {
    return authErrorResponse(error) ?? Response.json({ error: "Unauthorised." }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as {
    messageId?: string;
    rating?: number;
    reason?: string;
  } | null;

  const messageId = body?.messageId;
  const rating = body?.rating;

  if (!messageId || (rating !== 1 && rating !== -1)) {
    return Response.json({ error: "Provide a message id and a rating." }, { status: 400 });
  }

  const supabase = await supabaseServer();
  const { error } = await supabase.from("fs_feedback").upsert(
    {
      message_id: messageId,
      user_id: viewer.id,
      rating,
      reason: body?.reason?.slice(0, 500) ?? null,
    },
    { onConflict: "message_id,user_id" },
  );

  if (error) {
    console.error("[feedback]", error);
    return Response.json({ error: "Could not save the rating." }, { status: 400 });
  }

  return Response.json({ ok: true });
}
