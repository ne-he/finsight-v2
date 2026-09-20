/**
 * Sign out.
 *
 * POST rather than GET, so a link prefetch or an image tag on another site
 * cannot sign the user out without them doing anything.
 */
import { redirect } from "next/navigation";

import { supabaseServer } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function POST() {
  const supabase = await supabaseServer();
  await supabase.auth.signOut();
  redirect("/login");
}
