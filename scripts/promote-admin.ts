/**
 * Grant or revoke the administrator role.
 *
 * The first account to sign up becomes an administrator automatically (see
 * migration 0005), so this is for everyone after that, and for taking the role
 * back. Role is deliberately not writable from the browser, so this runs with
 * the service role key.
 *
 *     npm run promote -- someone@example.com
 *     npm run promote -- someone@example.com user
 */
import "./load-env";

import { createClient } from "@supabase/supabase-js";

async function main() {
  const email = process.argv[2]?.trim().toLowerCase();
  const role = (process.argv[3] ?? "admin").trim();

  if (!email) {
    console.error("Usage: npm run promote -- <email> [admin|user]");
    process.exit(1);
  }
  if (role !== "admin" && role !== "user") {
    console.error(`Role must be "admin" or "user", got "${role}".`);
    process.exit(1);
  }

  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );

  // Look the account up in Auth rather than in fs_profiles: a user who has
  // signed up but never opened a page has no profile row yet, and "not found"
  // would then be misleading.
  const { data: list, error: listError } = await admin.auth.admin.listUsers({
    page: 1,
    perPage: 1000,
  });
  if (listError) {
    console.error(`Could not list accounts: ${listError.message}`);
    process.exit(1);
  }

  const user = list.users.find((u) => u.email?.toLowerCase() === email);
  if (!user) {
    console.error(`No account found for ${email}. Sign up first, then run this.`);
    process.exit(1);
  }

  const { error } = await admin
    .from("fs_profiles")
    .upsert({ id: user.id, email: user.email ?? null, role }, { onConflict: "id" });

  if (error) {
    console.error(`Could not set the role: ${error.message}`);
    process.exit(1);
  }

  console.log(`${email} is now ${role}. Reload the page to see the change.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
