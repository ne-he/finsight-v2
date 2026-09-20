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
