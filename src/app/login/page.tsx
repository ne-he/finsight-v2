import { redirect } from "next/navigation";

import { AuthForm } from "@/components/auth-form";
import { currentViewer } from "@/lib/auth";
import { loadCorpus } from "@/lib/corpus";

export const metadata = { title: "Sign in | FinSight" };
export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (await currentViewer()) redirect("/chat");
  const corpus = await loadCorpus();

  return (
    <div className="flex flex-1 items-center justify-center px-4 py-16">
      <div className="reveal w-full max-w-[420px] border border-border bg-surface-raised p-8 sm:p-10">
        <p className="label">Account</p>
        <h1 className="mt-3 font-serif text-[38px] leading-none">Sign in</h1>
        <p className="mt-4 mb-8 text-sm leading-relaxed text-muted">
          An account keeps your conversation history and your daily question
          allowance separate from everyone else&apos;s.
        </p>

        <AuthForm />

        {corpus.length > 0 ? (
          <p className="mt-8 border-t border-rule-soft pt-5 font-mono text-[11px] leading-relaxed text-muted">
            IN THE CORPUS: {corpus.map((c) => `${c.ticker} FY${c.fiscalYear}`).join("  /  ")}
          </p>
        ) : null}
      </div>
    </div>
  );
}
