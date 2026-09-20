import { IngestPanel } from "@/components/ingest-panel";
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

  const ratings = feedback ?? [];
  const helpful = ratings.filter((r) => r.rating === 1).length;

  return (
    <div className="mx-auto w-full max-w-3xl space-y-8 px-4 py-10">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Admin</h1>
        <p className="mt-1 text-sm text-muted">
          {ratings.length > 0
            ? `${helpful} of ${ratings.length} rated answers marked helpful.`
            : "No answer feedback yet."}
        </p>
      </div>

      <IngestPanel />

      <section>
        <h2 className="text-sm font-medium">Corpus</h2>
        {filings && filings.length > 0 ? (
          <table className="mt-3 w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted">
                <th className="py-2 font-medium">Ticker</th>
                <th className="py-2 font-medium">Company</th>
                <th className="py-2 font-medium">FY</th>
                <th className="py-2 text-right font-medium">Chunks</th>
                <th className="py-2 text-right font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filings.map((filing) => (
                <tr key={filing.id}>
                  <td className="py-2 font-mono text-xs">{filing.ticker}</td>
                  <td className="py-2">
                    <a
                      href={filing.source_url as string}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="hover:text-accent"
                    >
                      {filing.company}
                    </a>
                  </td>
                  <td className="py-2 text-muted">{filing.fiscal_year}</td>
                  <td className="py-2 text-right font-mono text-xs">
                    {filing.chunk_count}
                  </td>
                  <td className="py-2 text-right text-xs">
                    {filing.is_ready ? (
                      <span className="text-muted">ready</span>
                    ) : (
                      <span className="text-danger">incomplete</span>
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
        <h2 className="text-sm font-medium">Recent jobs</h2>
        {jobs && jobs.length > 0 ? (
          <ul className="mt-3 space-y-2">
            {jobs.map((job) => (
              <li key={job.id} className="flex items-baseline gap-3 text-xs">
                <span className="font-mono">{job.ticker}</span>
                <span className={job.status === "failed" ? "text-danger" : "text-muted"}>
                  {job.status}
                </span>
                <span className="text-muted">
                  {job.embedded_chunks}/{job.total_chunks}
                </span>
                {job.error ? (
                  <span className="truncate text-danger">{job.error}</span>
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
