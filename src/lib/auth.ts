/**
 * Who is calling, and are they allowed to.
 *
 * Profiles are created lazily here rather than by a trigger on `auth.users`,
 * because that table is shared with another app in the same Supabase project
 * and a trigger there would create FinSight profiles for its users too.
 *
 * Role is read with the service role key. Reading it through the user's own
 * session would work, but routing every authorisation check through one
 * server-side function means there is a single place to audit.
 */
import { supabaseAdmin, supabaseServer } from "@/lib/supabase/server";

export interface Viewer {
  id: string;
  email: string | null;
  role: "user" | "admin";
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403,
  ) {
    super(message);
  }
}

/** The signed-in user with their application role, or null when signed out. */
export async function currentViewer(): Promise<Viewer | null> {
  const supabase = await supabaseServer();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;

  const user = data.user;
  const admin = supabaseAdmin();

  const { data: profile } = await admin
    .from("fs_profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  if (profile) {
    return {
      id: user.id,
      email: user.email ?? null,
      role: profile.role === "admin" ? "admin" : "user",
    };
  }

  // First sight of this account. Creating the profile and deciding its role
  // happen inside one database function, because the rule "the first account
  // becomes the administrator" is only correct if two simultaneous sign-ups
  // cannot both read "no admin exists". See migration 0005.
  const { data: role, error: profileError } = await admin.rpc("fs_ensure_profile", {
    p_id: user.id,
    p_email: user.email ?? null,
  });

  if (profileError) {
    if (/does not exist|could not find/i.test(profileError.message)) {
      // Migration 0005 has not been applied. Without a fallback the very first
      // user would silently become an ordinary account, and nobody could ever
      // ingest anything: the role is not writable from the browser, so the app
      // would be permanently stuck. Do the same thing in application code,
      // accepting the race that the database function exists to avoid.
      console.warn("[auth] fs_ensure_profile is missing, applying migration 0005 is recommended");
      return bootstrapProfileInApp(admin, user.id, user.email ?? null);
    }
    // A failed profile write must not lock the user out of reading. Fall back
    // to the least privileged role rather than to an error page.
    console.error("[auth] could not ensure profile", profileError);
    return { id: user.id, email: user.email ?? null, role: "user" };
  }

  return {
    id: user.id,
    email: user.email ?? null,
    role: role === "admin" ? "admin" : "user",
  };
}

/**
 * The same first-account-becomes-admin rule, without the database function.
 *
 * Only reached when migration 0005 has not been applied. Two simultaneous first
 * sign-ups could both read "no admin exists" and both be promoted, which is
 * exactly why the real implementation is a locked function in SQL.
 */
async function bootstrapProfileInApp(
  admin: ReturnType<typeof supabaseAdmin>,
  id: string,
  email: string | null,
): Promise<Viewer> {
  const { count } = await admin
    .from("fs_profiles")
    .select("id", { count: "exact", head: true })
    .eq("role", "admin");

  const role: Viewer["role"] = (count ?? 0) === 0 ? "admin" : "user";
  await admin.from("fs_profiles").upsert({ id, email, role }, { onConflict: "id" });
  return { id, email, role };
}

export async function requireViewer(): Promise<Viewer> {
  const viewer = await currentViewer();
  if (!viewer) throw new AuthError("Sign in to continue.", 401);
  return viewer;
}

export async function requireAdmin(): Promise<Viewer> {
  const viewer = await requireViewer();
  if (viewer.role !== "admin") {
    throw new AuthError("This action is restricted to administrators.", 403);
  }
  return viewer;
}

/** Turn an AuthError into a response, and anything else into a generic 500. */
export function authErrorResponse(error: unknown): Response | null {
  if (error instanceof AuthError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  return null;
}
