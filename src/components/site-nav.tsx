import Link from "next/link";

import { currentViewer } from "@/lib/auth";

/**
 * One slim bar, and the Admin link only exists for administrators.
 *
 * Hiding it is presentation, not protection: the admin routes check the role
 * themselves. Both layers are needed, because a hidden link is still a
 * reachable URL.
 */
export async function SiteNav() {
  const viewer = await currentViewer();

  return (
    <header className="border-b border-border bg-surface">
      <nav className="mx-auto flex h-14 w-full max-w-4xl items-center gap-6 px-4">
        <Link href="/" className="font-semibold tracking-tight">
          FinSight
        </Link>

        {viewer ? (
          <>
            <div className="flex items-center gap-4 text-sm text-muted">
              <Link href="/chat" className="hover:text-foreground transition-colors">
                Ask
              </Link>
              <Link href="/history" className="hover:text-foreground transition-colors">
                History
              </Link>
              {viewer.role === "admin" ? (
                <Link href="/admin" className="hover:text-foreground transition-colors">
                  Admin
                </Link>
              ) : null}
            </div>

            <form action="/auth/signout" method="post" className="ml-auto">
              <button
                type="submit"
                className="text-sm text-muted hover:text-foreground transition-colors"
              >
                Sign out
              </button>
            </form>
          </>
        ) : (
          <Link
            href="/login"
            className="ml-auto text-sm text-muted hover:text-foreground transition-colors"
          >
            Sign in
          </Link>
        )}
      </nav>
    </header>
  );
}
