import Link from "next/link";
import { redirect } from "next/navigation";

import { currentViewer } from "@/lib/auth";

export default async function Home() {
  if (await currentViewer()) redirect("/chat");

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center px-4 py-20">
      <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
        Answers from the filing, not from memory.
      </h1>

      <p className="mt-4 text-muted leading-relaxed">
        FinSight answers questions about public companies using only their SEC
        10-K filings. Every fact is cited down to the section it came from, and
        when the documents do not support an answer it says so instead of
        inventing one.
      </p>

      <ul className="mt-8 space-y-3 text-sm text-muted">
        {[
          "Hybrid search over the filing text, filtered to the company you asked about",
          "Citations like [NVDA FY2026 * Item 1A. Risk Factors], with a link to the source",
          "A confidence gate that refuses rather than guesses",
        ].map((line) => (
          <li key={line} className="flex gap-3">
            <span aria-hidden className="text-accent">
              &#8594;
            </span>
            <span>{line}</span>
          </li>
        ))}
      </ul>

      <div className="mt-10">
        <Link
          href="/login"
          className="inline-flex h-10 items-center rounded-md bg-accent px-5 text-sm font-medium text-accent-foreground transition-opacity hover:opacity-90"
        >
          Sign in to start
        </Link>
      </div>

      <p className="mt-10 text-xs text-muted">
        Informational only, not investment advice.
      </p>
    </div>
  );
}
