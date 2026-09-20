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
    <div className="mx-auto w-full max-w-3xl px-4 py-10">
      <h1 className="text-lg font-semibold tracking-tight">History</h1>

      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-muted">
          Nothing here yet. Conversations appear once you ask something.
        </p>
      ) : (
        <ul className="mt-6 divide-y divide-border border-y border-border">
          {rows.map((row) => (
            <li key={row.id}>
              <Link
                href={`/chat/${row.id}`}
                className="flex items-baseline justify-between gap-4 py-3 transition-colors hover:text-accent"
              >
                <span className="truncate text-sm">{row.title}</span>
                <time
                  dateTime={row.updated_at as string}
                  className="shrink-0 text-xs text-muted"
                >
                  {new Date(row.updated_at as string).toLocaleDateString("en-GB", {
                    day: "numeric",
                    month: "short",
                    year: "numeric",
                  })}
                </time>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
