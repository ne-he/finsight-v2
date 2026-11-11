/**
 * Retrieval plus the streamed answer, shared by the signed-in and guest routes.
 *
 * The two routes differ only in who may call them, how the call is counted and
 * whether the transcript is saved. Everything that decides what the answer says
 * lives here, so a guest sees exactly the pipeline a signed-in user does.
 *
 * The stream emits `sources` BEFORE the first token, so a failure after that
 * point would otherwise leave the page showing citations followed by silence
 * forever. That is the worst available failure mode, so there is an explicit
 * `error` event for exactly that window, and a degraded answer quoted from the
 * chunks retrieval already found.
 */
import { MAX_MESSAGE_CHARS, MAX_TOTAL_CHARS } from "@/config";
import { GenerationFailed, isQuotaError, streamAnswer } from "@/lib/gemini";
import { buildUserTurn, extractiveAnswer, SYSTEM_PROMPT } from "@/lib/rag/prompt";
import { loadFilings, retrieve, sourcesOf } from "@/lib/rag/retrieve";
import { SSE_DONE, sseEvent } from "@/lib/sse";
import { supabaseAdmin } from "@/lib/supabase/server";

export interface InboundMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ParsedQuestion {
  question: string;
  history: InboundMessage[];
  conversationId: string | null;
}

/** Validate the request body. Returns an error Response instead of throwing. */
export function parseQuestion(body: unknown, maxMessages: number): ParsedQuestion | Response {
  const b = (body ?? null) as {
    message?: unknown;
    history?: unknown;
    conversationId?: unknown;
  } | null;

  const question = typeof b?.message === "string" ? b.message.trim() : "";
  const history = Array.isArray(b?.history)
    ? (b.history as unknown[])
        .filter(
          (m): m is InboundMessage =>
            typeof m === "object" &&
            m !== null &&
            ((m as InboundMessage).role === "user" || (m as InboundMessage).role === "assistant") &&
            typeof (m as InboundMessage).content === "string",
        )
    : [];

  if (!question) {
    return Response.json({ error: "Ask a question to continue." }, { status: 400 });
  }
  if (question.length > MAX_MESSAGE_CHARS) {
    return Response.json(
      { error: `Questions are limited to ${MAX_MESSAGE_CHARS} characters.` },
      { status: 413 },
    );
  }
  if (history.length > maxMessages) {
    return Response.json({ error: "Start a new conversation." }, { status: 400 });
  }
  const totalChars = history.reduce((sum, m) => sum + m.content.length, 0);
  if (totalChars > MAX_TOTAL_CHARS) {
    return Response.json(
      { error: "This conversation is too long. Start a new one." },
      { status: 413 },
    );
  }

  const conversationId = typeof b?.conversationId === "string" ? b.conversationId : null;
  return { question, history, conversationId };
}

export interface AnswerRecord {
  question: string;
  answer: string;
  citations: unknown[];
  topCosine: number;
  gated: boolean;
  degraded: boolean;
  latencyMs: number;
}

export type Persist = (
  record: AnswerRecord,
) => Promise<{ conversationId: string | null; messageId: string | null }>;

/**
 * Retrieve, then stream. `persist` is optional: guests pass none, so nothing
 * they ask is written anywhere.
 */
export async function answerResponse(
  { question, history }: ParsedQuestion,
  persist?: Persist,
): Promise<Response> {
  const admin = supabaseAdmin();
  const startedAt = Date.now();

  let retrieval;
  try {
    const filings = await loadFilings(admin);
    if (filings.length === 0) {
      return Response.json({ error: "No filings have been ingested yet." }, { status: 503 });
    }
    retrieval = await retrieve(admin, question, filings);
  } catch (error) {
    console.error("[answer] retrieval failed", error);
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
      const send = (payload: unknown) => controller.enqueue(encoder.encode(sseEvent(payload)));

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
      let conversationId: string | null = null;
      let messageId: string | null = null;

      if (persist) {
        try {
          const saved = await persist({
            question,
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
          console.error("[answer] could not save transcript", error);
        }
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
