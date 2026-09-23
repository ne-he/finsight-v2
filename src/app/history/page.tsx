import Link from "next/link";

import { requireViewerOrRedirect } from "@/lib/guards";
import { supabaseServer } from "@/lib/supabase/server";

export const metadata = { title: "History | FinSight" };
export const dynamic = "force-dynamic";

export default async function HistoryPage() {
  await requireViewerOrRedirect();

  // Read through the user's own session, so Row Level Security is what limits
  // this to their conversations rather than a filter we could forget to write.
  const supabase = await supabaseServer();
  const { data: conversations } = await supabase
    .from("fs_conversations")
    .select("id, title, updated_at")
    .order("updated_at", { ascending: false })
    .limit(50);

  const rows = conversations ?? [];

  return (
    <div className="mx-auto w-full max-w-[880px] px-4 py-12 sm:px-8">
      <p className="label">History</p>
      <h1 className="mt-3 font-serif text-[40px] leading-none">Your questions</h1>

      {rows.length === 0 ? (
        <div className="mt-8 border border-rule-soft bg-surface-raised p-6">
          <p className="text-sm leading-relaxed text-muted">
            Nothing here yet. Conversations are listed once you ask something.
          </p>
          <Link
            href="/chat"
            className="mt-4 inline-flex h-10 items-center bg-accent px-5 text-sm font-medium text-accent-foreground transition-opacity hover:opacity-85"
          >
            Ask a question
          </Link>
        </div>
      ) : (
        <ul className="mt-8 border-t border-border">
          {rows.map((row) => (
            <li key={row.id} className="border-b border-rule-soft">
              <Link
                href={`/chat/${row.id}`}
                className="group flex items-baseline gap-4 py-4 transition-colors hover:bg-surface-raised"
              >
                <time
                  dateTime={row.updated_at as string}
                  className="w-24 shrink-0 font-mono text-[11px] text-muted"
                >
                  {new Date(row.updated_at as string)
                    .toLocaleDateString("en-GB", {
                      day: "2-digit",
                      month: "short",
                      year: "numeric",
                    })
                    .toUpperCase()}
                </time>
                <span className="min-w-0 flex-1 truncate text-[15px]">{row.title}</span>
                <span
                  aria-hidden
                  className="shrink-0 font-mono text-xs text-muted transition-transform group-hover:translate-x-1"
                >
                  &#8594;
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
