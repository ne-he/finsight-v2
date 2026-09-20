"use client";

/**
 * Supabase client for the browser.
 *
 * Only the anon key reaches this file. Row Level Security is what keeps that
 * safe: the key identifies the project, the policies decide what the signed-in
 * user may read.
 */
import { createBrowserClient } from "@supabase/ssr";

let cached: ReturnType<typeof createBrowserClient> | null = null;

export function supabaseBrowser() {
  if (!cached) {
    cached = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    );
  }
  return cached;
}
