/**
 * Supabase clients for server code.
 *
 * Two clients, and the difference matters:
 *
 *   `supabaseServer()` carries the signed-in user's session from cookies, so
 *   every query it runs is subject to Row Level Security. Use it for anything
 *   acting on behalf of a user.
 *
 *   `supabaseAdmin()` uses the service role key and bypasses RLS entirely. Use
 *   it only where the server is the authority: writing corpus rows, moving an
 *   ingest job forward, counting usage. Never hand its results straight to a
 *   client without checking who asked.
 */
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

import { env } from "@/lib/env";

export async function supabaseServer() {
  const cookieStore = await cookies();
  const config = env();

  return createServerClient(
    config.NEXT_PUBLIC_SUPABASE_URL,
    config.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Server Components cannot set cookies. The session refresh in
            // proxy.ts handles it, so ignoring this here is correct rather
            // than merely convenient.
          }
        },
      },
    },
  );
}

export function supabaseAdmin() {
  const config = env();
  return createClient(
    config.NEXT_PUBLIC_SUPABASE_URL,
    config.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}
