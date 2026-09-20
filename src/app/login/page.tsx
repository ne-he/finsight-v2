import { redirect } from "next/navigation";

import { AuthForm } from "@/components/auth-form";
import { currentViewer } from "@/lib/auth";

export const metadata = { title: "Sign in | FinSight" };

export default async function LoginPage() {
  if (await currentViewer()) redirect("/chat");

  return (
    <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center px-4 py-16">
      <h1 className="text-xl font-semibold tracking-tight">Sign in to FinSight</h1>
      <p className="mt-2 mb-8 text-sm text-muted">
        An account keeps your conversation history and your daily question
        allowance separate from everyone else&apos;s.
      </p>
      <AuthForm />
    </div>
  );
}
