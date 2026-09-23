import Link from "next/link";

import { NavLinks } from "@/components/nav-links";
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

  const links = viewer
    ? [
        { href: "/chat", label: "Ask" },
        { href: "/history", label: "History" },
        ...(viewer.role === "admin" ? [{ href: "/admin", label: "Admin" }] : []),
      ]
    : [];

  return (
    <header className="relative z-30 h-[var(--nav-h)] shrink-0 border-b border-border bg-background">
      <nav className="mx-auto flex h-full w-full max-w-[1440px] items-center gap-6 px-4 sm:gap-10 sm:px-6">
        <Link href="/" className="flex items-baseline gap-3">
          <span className="font-serif text-[26px] leading-none">FinSight</span>
          <span className="label hidden md:inline">10-K evidence desk</span>
        </Link>

        {viewer ? (
          <>
            <NavLinks links={links} />
            <form action="/auth/signout" method="post" className="ml-auto flex items-center gap-4">
              <span className="hidden font-mono text-xs text-muted lg:inline">{viewer.email}</span>
              <button
                type="submit"
                className="text-sm text-muted underline-offset-4 transition-colors hover:text-foreground hover:underline"
              >
                Sign out
              </button>
            </form>
          </>
        ) : (
          <Link
            href="/login"
            className="ml-auto border border-border px-3.5 py-1.5 text-sm transition-colors hover:bg-foreground hover:text-background"
          >
            Sign in
          </Link>
        )}
      </nav>
    </header>
  );
}
