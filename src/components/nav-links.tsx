"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** Section links with the current one underlined. Client-side only for the pathname. */
export function NavLinks({ links }: { links: { href: string; label: string }[] }) {
  const pathname = usePathname();

  return (
    <div className="flex items-center gap-5 text-sm">
      {links.map((link) => {
        const active = pathname === link.href || pathname.startsWith(`${link.href}/`);
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? "page" : undefined}
            className={`underline-offset-[6px] transition-colors hover:text-foreground ${
              active ? "text-foreground underline decoration-1" : "text-muted"
            }`}
          >
            {link.label}
          </Link>
        );
      })}
    </div>
  );
}
