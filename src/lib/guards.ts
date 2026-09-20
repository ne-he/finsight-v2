/**
 * Page-level access checks.
 *
 * Separate from `lib/auth.ts` because these redirect, which only makes sense
 * for a page. An API route returns a status code instead.
 */
import { redirect } from "next/navigation";

import { currentViewer, type Viewer } from "@/lib/auth";

export async function requireViewerOrRedirect(): Promise<Viewer> {
  const viewer = await currentViewer();
  if (!viewer) redirect("/login");
  return viewer;
}

export async function requireAdminOrRedirect(): Promise<Viewer> {
  const viewer = await requireViewerOrRedirect();
  // Sent to the chat rather than to the login page: they are signed in, they
  // simply are not an administrator, and asking them to sign in again would be
  // misleading.
  if (viewer.role !== "admin") redirect("/chat");
  return viewer;
}
