import { notFound } from "next/navigation";

import { ChatView, type ChatMessage, type Source } from "@/components/chat-view";
import { loadCorpus, suggestionsFor } from "@/lib/corpus";
import { requireViewerOrRedirect } from "@/lib/guards";
import { supabaseServer } from "@/lib/supabase/server";

export const metadata = { title: "Conversation | FinSight" };
export const dynamic = "force-dynamic";

export default async function ConversationPage({ params }: PageProps<"/chat/[id]">) {
  await requireViewerOrRedirect();
  const { id } = await params;

  // No ownership check is written here on purpose. The query runs through the
  // user's own session, and the Row Level Security policy on fs_conversations
  // already restricts it to rows they own, so another user's id simply returns
  // nothing.
  const supabase = await supabaseServer();
  const { data: conversation } = await supabase
    .from("fs_conversations")
    .select("id")
    .eq("id", id)
    .maybeSingle();

  if (!conversation) notFound();

  const [{ data: rows }, corpus] = await Promise.all([
    supabase
      .from("fs_messages")
      .select("id, role, content, citations, top_cosine, gated, degraded, latency_ms")
      .eq("conversation_id", id)
      .order("created_at"),
    loadCorpus(),
  ]);

  const messages: ChatMessage[] = (rows ?? []).map((row) => ({
    id: row.id as string,
    role: row.role as "user" | "assistant",
    content: row.content as string,
    sources: (row.citations as Source[]) ?? [],
    topCosine: (row.top_cosine as number | null) ?? undefined,
    gated: row.gated as boolean,
    degraded: row.degraded as boolean,
    latencyMs: (row.latency_ms as number | null) ?? undefined,
  }));

  return (
    <ChatView
      conversationId={id}
      initialMessages={messages}
      corpus={corpus}
      suggestions={suggestionsFor(corpus)}
    />
  );
}
