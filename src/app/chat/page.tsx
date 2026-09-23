import Link from "next/link";

import { ChatView } from "@/components/chat-view";
import { loadCorpus, suggestionsFor } from "@/lib/corpus";
import { requireViewerOrRedirect } from "@/lib/guards";

export const metadata = { title: "Ask | FinSight" };
export const dynamic = "force-dynamic";

export default async function ChatPage() {
  await requireViewerOrRedirect();
  const corpus = await loadCorpus();

  if (corpus.length === 0) {
    return (
      <div className="mx-auto w-full max-w-xl px-4 py-24">
        <p className="label">Empty corpus</p>
        <h1 className="mt-3 font-serif text-[40px] leading-none">No filings yet</h1>
        <p className="mt-4 text-sm leading-relaxed text-muted">
          FinSight answers only from filings that have been ingested, and none
          have been. An administrator can add one from the{" "}
          <Link href="/admin" className="underline underline-offset-4">
            Admin
          </Link>{" "}
          page.
        </p>
      </div>
    );
  }

  return <ChatView corpus={corpus} suggestions={suggestionsFor(corpus)} />;
}
