import Link from "next/link";

export const metadata = { title: "Not found | FinSight" };

export default function NotFound() {
  return (
    <div className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center px-4 py-24">
      <p className="label">404</p>
      <h1 className="mt-3 font-serif text-[44px] leading-none">This page is not here</h1>
      <p className="mt-4 text-sm leading-relaxed text-muted">
        The address does not match anything in FinSight. It may have been a
        conversation that belongs to another account.
      </p>
      <Link
        href="/chat"
        className="mt-8 inline-flex h-11 w-fit items-center bg-accent px-6 text-sm font-medium text-accent-foreground transition-opacity hover:opacity-85"
      >
        Back to asking
      </Link>
    </div>
  );
}
