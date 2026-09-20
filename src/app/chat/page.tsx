import { ChatView } from "@/components/chat-view";
import { requireViewerOrRedirect } from "@/lib/guards";
import { supabaseAdmin } from "@/lib/supabase/server";

export const metadata = { title: "Ask | FinSight" };
export const dynamic = "force-dynamic";

export default async function ChatPage() {
  await requireViewerOrRedirect();

  const { data: filings } = await supabaseAdmin()
    .from("fs_filings")
    .select("ticker, company")
    .eq("is_ready", true)
    .order("ticker");

  const ready = filings ?? [];

  if (ready.length === 0) {
    return (
      <div className="mx-auto w-full max-w-2xl px-4 py-16">
        <h1 className="text-lg font-semibold">No filings yet</h1>
        <p className="mt-2 text-sm text-muted">
          FinSight answers only from filings that have been ingested, and none
          have been. An administrator can add one from the Admin page.
        </p>
      </div>
    );
  }

  // Suggestions are built from what is actually ingested, so the first thing a
  // new user tries cannot be a question the corpus has no chance of answering.
  const suggestions = [
    `What are ${ready[0].company}'s main risk factors?`,
    ready.length > 1
      ? `Compare the revenue drivers of ${ready[0].company} and ${ready[1].company}.`
      : `What does ${ready[0].company} say about its business segments?`,
  ];

  return <ChatView suggestions={suggestions} />;
}
