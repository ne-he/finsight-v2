/**
 * The question endpoint.
 *
 * Order of work, and why it is this order:
 *   1. Identify the caller. Everything here costs free-tier quota.
 *   2. Bound the payload before doing any paid work.
 *   3. Count the question against the daily cap, atomically, in the database.
 *   4. Retrieve, then stream the answer.
 *
 * The stream emits `sources` BEFORE the first token, so a failure after that
 * point would otherwise leave the page showing citations followed by silence
 * forever. That is the worst available failure mode, so there is an explicit
 * `error` event for exactly that window, and a degraded answer quoted from the
 * chunks retrieval already found.
 */
import { MAX_MESSAGE_CHARS, MAX_MESSAGES, MAX_TOTAL_CHARS } from "@/config";
import { authErrorResponse, requireViewer } from "@/lib/auth";
import { GenerationFailed, isQuotaError, streamAnswer } from "@/lib/gemini";
import { buildUserTurn, extractiveAnswer, SYSTEM_PROMPT } from "@/lib/rag/prompt";
import { loadFilings, retrieve, sourcesOf } from "@/lib/rag/retrieve";
import { env } from "@/lib/env";
import { SSE_DONE, sseEvent } from "@/lib/sse";
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

interface InboundMessage {
  role: "user" | "assistant";
  content: string;
}

export async function POST(request: Request) {
  let viewer;
  try {
    viewer = await requireViewer();
  } catch (error) {
    return authErrorResponse(error) ?? Response.json({ error: "Unauthorised." }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as {
    message?: string;
    history?: InboundMessage[];
    conversationId?: string;
  } | null;

  const question = body?.message?.trim();
  const history = Array.isArray(body?.history) ? body.history : [];

  if (!question) {
    return Response.json({ error: "Ask a question to continue." }, { status: 400 });
  }
  if (question.length > MAX_MESSAGE_CHARS) {
    return Response.json(
      { error: `Questions are limited to ${MAX_MESSAGE_CHARS} characters.` },
      { status: 413 },
    );
  }
  if (history.length > MAX_MESSAGES) {
    return Response.json({ error: "Start a new conversation." }, { status: 400 });
  }
  const totalChars = history.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
  if (totalChars > MAX_TOTAL_CHARS) {
    return Response.json(
      { error: "This conversation is too long. Start a new one." },
      { status: 413 },
    );
  }

  const admin = supabaseAdmin();
  const config = env();

  const { data: usage, error: usageError } = await admin
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
  const startedAt = Date.now();

  let retrieval;
  try {
    const filings = await loadFilings(admin);
    if (filings.length === 0) {
      return Response.json(
        { error: "No filings have been ingested yet." },
        { status: 503 },
      );
    }
    retrieval = await retrieve(admin, question, filings);
  } catch (error) {
    console.error("[chat] retrieval failed", error);
    const quotaHit = isQuotaError(error);
    return Response.json(
      {
        error: quotaHit
          ? "The embedding quota for today is exhausted, so no question can be answered until it resets."
          : "Retrieval failed.",
      },
      { status: quotaHit ? 429 : 503 },
    );
  }

  const sources = sourcesOf(retrieval.chunks);
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (payload: unknown) =>
        controller.enqueue(encoder.encode(sseEvent(payload)));

      send({
        type: "sources",
        sources,
        topCosine: Number(retrieval.topCosine.toFixed(4)),
        gated: retrieval.gated,
        filters: retrieval.filters,
      });

      let answer = "";
      let degraded = false;

      try {
        const generator = streamAnswer({
          systemInstruction: SYSTEM_PROMPT,
          history: history.map((m) => ({
            role: m.role === "assistant" ? ("model" as const) : ("user" as const),
            text: m.content,
          })),
          prompt: buildUserTurn(question, retrieval.chunks, retrieval.gated),
        });

        for await (const token of generator) {
          answer += token;
          send({ type: "token", text: token });
        }
      } catch (error) {
        const message =
          error instanceof GenerationFailed ? error.message : "The answer could not be generated.";
        // `recovered` tells the client whether what follows is a usable answer
        // or a half-written one it should mark as truncated.
        send({ type: "error", message, recovered: answer.length === 0 });
        if (answer.length === 0) {
          degraded = true;
          answer = extractiveAnswer(retrieval.chunks, retrieval.gated);
          send({ type: "token", text: answer });
        }
      }

      const latencyMs = Date.now() - startedAt;
      let conversationId = body?.conversationId ?? null;
      let messageId: string | null = null;

      try {
        const saved = await persist(supabase, viewer.id, conversationId, question, {
          answer,
          citations: sources,
          topCosine: retrieval.topCosine,
          gated: retrieval.gated,
          degraded,
          latencyMs,
        });
        conversationId = saved.conversationId;
        messageId = saved.messageId;
      } catch (error) {
        // Losing the transcript must not lose the answer already on screen.
        console.error("[chat] could not save transcript", error);
      }

      send({ type: "done", conversationId, messageId, latencyMs });
      controller.enqueue(encoder.encode(SSE_DONE));
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Stops a proxy buffering the whole answer and delivering it at once.
      "X-Accel-Buffering": "no",
    },
  });
}

type Supabase = Awaited<ReturnType<typeof supabaseServer>>;

async function persist(
  supabase: Supabase,
  userId: string,
  conversationId: string | null,
  question: string,
  answer: {
    answer: string;
    citations: unknown[];
    topCosine: number;
    gated: boolean;
    degraded: boolean;
    latencyMs: number;
  },
): Promise<{ conversationId: string; messageId: string }> {
  let id = conversationId;

  if (!id) {
    const { data, error } = await supabase
      .from("fs_conversations")
      .insert({ user_id: userId, title: question.slice(0, 80) })
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
    .insert({ conversation_id: id, role: "user", content: question });

  const { data: assistant, error: assistantError } = await supabase
    .from("fs_messages")
    .insert({
      conversation_id: id,
      role: "assistant",
      content: answer.answer,
      citations: answer.citations,
      top_cosine: answer.topCosine,
      gated: answer.gated,
      degraded: answer.degraded,
      latency_ms: answer.latencyMs,
    })
    .select("id")
    .single();

  if (assistantError || !assistant) {
    throw new Error(assistantError?.message ?? "Could not save the answer.");
  }
  return { conversationId: id, messageId: assistant.id as string };
}
