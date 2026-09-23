import { IngestPanel } from "@/components/ingest-panel";
import { displayName } from "@/lib/company";
import { requireAdminOrRedirect } from "@/lib/guards";
import { supabaseAdmin } from "@/lib/supabase/server";

export const metadata = { title: "Admin | FinSight" };
export const dynamic = "force-dynamic";

export default async function AdminPage() {
  await requireAdminOrRedirect();
  const admin = supabaseAdmin();

  const [{ data: filings }, { data: jobs }, { data: feedback }] = await Promise.all([
    admin
      .from("fs_filings")
      .select("id, ticker, company, fiscal_year, chunk_count, is_ready, source_url")
      .order("ticker"),
    admin
      .from("fs_ingest_jobs")
      .select("id, ticker, status, total_chunks, embedded_chunks, error, created_at")
      .order("created_at", { ascending: false })
      .limit(8),
    admin.from("fs_feedback").select("rating"),
  ]);

  const rows = filings ?? [];
  const ratings = feedback ?? [];
  const helpful = ratings.filter((r) => r.rating === 1).length;
  const passages = rows.reduce((sum, f) => sum + Number(f.chunk_count ?? 0), 0);

  const stats = [
    { label: "Filings", value: String(rows.length) },
    { label: "Passages", value: passages.toLocaleString("en-US") },
    {
      label: "Rated helpful",
      value: ratings.length > 0 ? `${helpful}/${ratings.length}` : "none yet",
    },
  ];

  return (
    <div className="mx-auto w-full max-w-[980px] space-y-10 px-4 py-12 sm:px-8">
      <div>
        <p className="label">Admin</p>
        <h1 className="mt-3 font-serif text-[40px] leading-none">Corpus and ingestion</h1>
      </div>

      <dl className="grid grid-cols-3 border-y border-border">
        {stats.map((stat, i) => (
          <div key={stat.label} className={`py-4 ${i > 0 ? "border-l border-rule-soft pl-4" : ""}`}>
            <dt className="label">{stat.label}</dt>
            <dd className="mt-1 font-mono text-2xl">{stat.value}</dd>
          </div>
        ))}
      </dl>

      <IngestPanel />

      <section>
        <p className="label">Corpus</p>
        {rows.length > 0 ? (
          <table className="mt-3 w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th className="label py-2 font-medium">Ticker</th>
                <th className="label py-2 font-medium">Company</th>
                <th className="label py-2 font-medium">Fiscal year</th>
                <th className="label py-2 text-right font-medium">Passages</th>
                <th className="label py-2 text-right font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((filing) => (
                <tr key={filing.id} className="border-b border-rule-soft">
                  <td className="py-2.5 font-mono text-xs">{filing.ticker}</td>
                  <td className="py-2.5">
                    <a
                      href={filing.source_url as string}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="underline-offset-4 hover:underline"
                    >
                      {displayName(filing.company as string)}
                    </a>
                  </td>
                  <td className="py-2.5 font-mono text-xs text-muted">FY{filing.fiscal_year}</td>
                  <td className="py-2.5 text-right font-mono text-xs">{filing.chunk_count}</td>
                  <td className="py-2.5 text-right font-mono text-xs">
                    {filing.is_ready ? (
                      <span className="text-muted">ready</span>
                    ) : (
                      <span className="text-signal">incomplete</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="mt-2 text-sm text-muted">Nothing ingested yet.</p>
        )}
      </section>

      <section>
        <p className="label">Recent jobs</p>
        {jobs && jobs.length > 0 ? (
          <ul className="mt-3 border-t border-rule-soft">
            {jobs.map((job) => (
              <li
                key={job.id}
                className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-rule-soft py-2.5 font-mono text-[11px]"
              >
                <span className="w-14">{job.ticker}</span>
                <span className={job.status === "failed" ? "text-danger" : "text-muted"}>
                  {job.status}
                </span>
                <span className="text-muted">
                  {job.embedded_chunks}/{job.total_chunks} embedded
                </span>
                <span className="ml-auto text-muted">
                  {new Date(job.created_at as string).toLocaleString("en-GB", {
                    day: "2-digit",
                    month: "short",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
                {job.error ? (
                  <span className="w-full truncate text-danger">{job.error}</span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-muted">No jobs have run yet.</p>
        )}
      </section>
    </div>
  );
}
