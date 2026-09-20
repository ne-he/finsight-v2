/**
 * Load `.env.local` for scripts run outside Next.js.
 *
 * Next injects environment variables itself, but `tsx scripts/...` does not go
 * through Next, so scripts import this first. `.env.local` is read before
 * `.env`, matching the order Next uses, so a script and the app never disagree
 * about which value is live.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { config } from "dotenv";

for (const file of [".env.local", ".env"]) {
  const path = resolve(process.cwd(), file);
  if (existsSync(path)) config({ path, override: false, quiet: true });
}

// Values pasted into a dotenv file often carry a stray leading space. dotenv
// keeps it, and it then breaks an API header or a URL in a way that is very
// hard to see in a log, so trim the ones we control here.
for (const name of [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "GEMINI_API_KEY",
  "EDGAR_USER_AGENT",
]) {
  const value = process.env[name];
  if (typeof value === "string") process.env[name] = value.trim();
}
