"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { supabaseBrowser } from "@/lib/supabase/client";

type Mode = "signin" | "signup";

const FIELD =
  "h-11 w-full border border-border bg-background px-3 text-sm outline-none transition-shadow focus:shadow-[inset_0_-2px_0_0_var(--foreground)]";

export function AuthForm() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [notice, setNotice] = useState<{ kind: "error" | "info"; text: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setNotice(null);

    const supabase = supabaseBrowser();
    const credentials = { email: email.trim(), password };

    const { data, error } =
      mode === "signin"
        ? await supabase.auth.signInWithPassword(credentials)
        : await supabase.auth.signUp(credentials);

    setBusy(false);

    if (error) {
      setNotice({ kind: "error", text: error.message });
      return;
    }

    // Supabase returns a user with no session when email confirmation is on.
    // Redirecting then would bounce straight back to this page with no reason
    // shown, so say what happened instead.
    if (!data.session) {
      setNotice({
        kind: "info",
        text: "Check your email to confirm the account, then sign in.",
      });
      return;
    }

    router.push("/chat");
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <div className="space-y-2">
        <label htmlFor="email" className="label block">
          Email
        </label>
        <input
          id="email"
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className={FIELD}
        />
      </div>

      <div className="space-y-2">
        <label htmlFor="password" className="label block">
          Password
        </label>
        <input
          id="password"
          type="password"
          required
          minLength={8}
          autoComplete={mode === "signin" ? "current-password" : "new-password"}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className={FIELD}
        />
        {mode === "signup" ? (
          <p className="text-xs text-muted">At least 8 characters.</p>
        ) : null}
      </div>

      {notice ? (
        <p
          role="alert"
          className={`border-l-2 pl-3 text-sm ${
            notice.kind === "error"
              ? "border-danger text-danger"
              : "border-signal text-muted"
          }`}
        >
          {notice.text}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={busy}
        className="h-11 w-full bg-accent text-sm font-medium text-accent-foreground transition-opacity hover:opacity-85 disabled:opacity-50"
      >
        {busy ? "Working..." : mode === "signin" ? "Sign in" : "Create account"}
      </button>

      <button
        type="button"
        onClick={() => {
          setMode(mode === "signin" ? "signup" : "signin");
          setNotice(null);
        }}
        className="w-full text-sm text-muted underline-offset-4 transition-colors hover:text-foreground hover:underline"
      >
        {mode === "signin"
          ? "No account yet? Create one"
          : "Already have an account? Sign in"}
      </button>
    </form>
  );
}
