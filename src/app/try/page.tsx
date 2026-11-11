import Link from "next/link";
import { redirect } from "next/navigation";

import { ChatView } from "@/components/chat-view";
import { currentViewer } from "@/lib/auth";
import { loadCorpus, suggestionsFor } from "@/lib/corpus";
import { env } from "@/lib/env";
import { guestModeAvailable } from "@/lib/guest";

export const metadata = { title: "Try | FinSight" };
export const dynamic = "force-dynamic";

/** The same desk as `/chat`, for visitors without an account. */
export default async function TryPage() {
  if (await currentViewer()) redirect("/chat");

  const [available, corpus] = await Promise.all([guestModeAvailable(), loadCorpus()]);

  if (!available || corpus.length === 0) {
    return (
      <div className="mx-auto w-full max-w-xl px-4 py-24">
        <p className="label">Guest mode</p>
        <h1 className="mt-3 font-serif text-[40px] leading-none">Not available right now</h1>
        <p className="mt-4 text-sm leading-relaxed text-muted">
          Asking without an account is switched off at the moment.{" "}
          <Link href="/login" className="underline underline-offset-4">
            Sign in
          </Link>{" "}
          with a free account to ask about the filings.
        </p>
      </div>
    );
  }

  return (
    <ChatView
      corpus={corpus}
      suggestions={suggestionsFor(corpus)}
      guest={{ perVisitor: env().GUEST_LIMIT_PER_VISITOR }}
    />
  );
}
