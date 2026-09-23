import Link from "next/link";
import { redirect } from "next/navigation";

import { CONFIDENCE_THRESHOLD } from "@/config";
import { currentViewer } from "@/lib/auth";
import { env } from "@/lib/env";
import { loadCorpus, loadSpecimen } from "@/lib/corpus";

export const dynamic = "force-dynamic";

/**
 * One screen, no scroll story. Left: what FinSight is. Right: a real passage
 * from the corpus with the sentence behind an example claim highlighted, which
 * is the one interaction worth understanding before signing in.
 */
export default async function Home() {
  if (await currentViewer()) redirect("/chat");

  const corpus = await loadCorpus();
  const specimen = await loadSpecimen(corpus).catch(() => null);
  const passages = corpus.reduce((sum, c) => sum + c.chunkCount, 0);

  return (
    <div className="mx-auto grid w-full max-w-[1440px] flex-1 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
      <section className="flex flex-col justify-center px-4 py-14 sm:px-10 lg:py-10 lg:pl-6 lg:pr-16">
        <p className="label reveal" style={{ "--i": 0 } as React.CSSProperties}>
          Question answering over SEC 10-K filings
        </p>

        <h1
          className="reveal mt-5 font-serif text-[52px] leading-[0.98] tracking-[-0.01em] text-balance sm:text-[72px] xl:text-[88px]"
          style={{ "--i": 1 } as React.CSSProperties}
        >
          Answers from the filing, <em className="italic">not from memory.</em>
        </h1>

        <p
          className="reveal mt-7 max-w-xl text-[17px] leading-relaxed text-muted"
          style={{ "--i": 2 } as React.CSSProperties}
        >
          Ask about a public company in English or Indonesian. FinSight reads only
          the company&apos;s latest annual report, puts a citation on every claim,
          and opens the exact passage beside the answer. When the filing does not
          cover a question, it says so instead of guessing.
        </p>

        <div className="reveal mt-9 flex flex-wrap items-center gap-4" style={{ "--i": 3 } as React.CSSProperties}>
          <Link
            href="/login"
            className="inline-flex h-12 items-center bg-accent px-7 text-[15px] font-medium text-accent-foreground transition-opacity hover:opacity-85"
          >
            Sign in to start
          </Link>
          <span className="text-sm text-muted">
            Free account, {env().DAILY_LIMIT_PER_USER} questions a day.
          </span>
        </div>

        <dl
          className="reveal mt-14 grid max-w-xl grid-cols-3 border-y border-border"
          style={{ "--i": 4 } as React.CSSProperties}
        >
          {[
            { label: "Filings", value: String(corpus.length) },
            { label: "Passages", value: passages.toLocaleString("en-US") },
            { label: "Minimum match", value: CONFIDENCE_THRESHOLD.toFixed(2) },
          ].map((fact, i) => (
            <div key={fact.label} className={`py-4 ${i > 0 ? "border-l border-rule-soft pl-4" : ""}`}>
              <dt className="label">{fact.label}</dt>
              <dd className="mt-1 font-mono text-2xl">{fact.value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <aside className="flex flex-col justify-center border-t border-border bg-surface-raised px-4 py-12 sm:px-10 lg:border-t-0 lg:border-l lg:py-10">
        {specimen ? (
          <figure className="reveal max-w-xl" style={{ "--i": 3 } as React.CSSProperties}>
            <p className="label">How a citation works</p>

            <div className="mt-5 border border-border bg-background p-5">
              <p className="label">Claim in an answer</p>
              <p className="mt-2 text-[15px] leading-relaxed">
                {specimen.claim}{" "}
                <span className="inline-flex h-5 min-w-5 items-center justify-center bg-foreground px-1 align-[1px] font-mono text-[11px] text-background">
                  1
                </span>
              </p>
            </div>

            <div className="mx-5 h-6 border-l border-dashed border-border" aria-hidden />

            <div className="border border-border bg-background p-5">
              <p className="label">
                Source 1 &middot; {specimen.ticker} FY{specimen.fiscalYear} &middot;{" "}
                {specimen.section.split(".")[0]}
              </p>
              <blockquote className="mt-3 whitespace-pre-line text-[14px] leading-[1.7]">
                {specimen.highlight ? (
                  <>
                    {specimen.passage.slice(0, specimen.highlight.start)}
                    <mark className="marker">
                      {specimen.passage.slice(specimen.highlight.start, specimen.highlight.end)}
                    </mark>
                    {specimen.passage.slice(specimen.highlight.end)}
                  </>
                ) : (
                  specimen.passage
                )}
              </blockquote>
            </div>

            <figcaption className="mt-4 text-sm leading-relaxed text-muted">
              A real passage from {specimen.name}&apos;s {specimen.section.split(".")[0]}.
              In the app, clicking a numbered citation opens its passage and
              highlights the closest sentence.
            </figcaption>
          </figure>
        ) : null}

        {corpus.length > 0 ? (
          <div className="reveal mt-10 max-w-xl" style={{ "--i": 5 } as React.CSSProperties}>
            <p className="label">In the corpus</p>
            <table className="mt-3 w-full text-sm">
              <tbody>
                {corpus.map((c) => (
                  <tr key={c.ticker} className="border-b border-rule-soft last:border-b-0">
                    <td className="py-2 pr-4 font-mono text-xs">{c.ticker}</td>
                    <td className="py-2 pr-4">{c.name}</td>
                    <td className="py-2 pr-4 font-mono text-xs text-muted">10-K FY{c.fiscalYear}</td>
                    <td className="py-2 text-right font-mono text-xs text-muted">
                      {c.chunkCount} passages
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-6 text-xs text-muted">Informational only, not investment advice.</p>
          </div>
        ) : null}
      </aside>
    </div>
  );
}
