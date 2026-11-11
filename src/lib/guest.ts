/**
 * Guest mode: ask without an account.
 *
 * A recruiter who clicks the demo link should be able to try one question
 * without signing up, but the free Gemini tier cannot absorb an open endpoint.
 * So guests get a small quota, counted in the database (migration 0006), and
 * nothing they ask is stored.
 *
 * The visitor id is an HMAC of the day and the caller's IP. The key never leaves
 * the server, so the id cannot be reversed into an address, and because the day
 * is mixed in, ids from different days cannot be linked.
 */
import { createHmac } from "node:crypto";

import { supabaseAdmin } from "@/lib/supabase/server";

/** A guest conversation is shorter than a signed-in one. */
export const GUEST_MAX_MESSAGES = 12;

/**
 * The caller's address as Vercel reports it.
 *
 * `x-forwarded-for` can carry a chain; the first entry is the client. Returns
 * null when no header is present, which only happens off the platform.
 */
export function clientAddress(headers: Headers): string | null {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = headers.get("x-real-ip")?.trim();
  return real ? real : null;
}

/** UTC day, matching `current_date` on the Supabase server. */
export function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function visitorId(address: string, key: string, day: string = utcDay()): string {
  return createHmac("sha256", key).update(`${day}|${address}`).digest("hex").slice(0, 32);
}

let availability: { value: boolean; checkedAt: number } | null = null;
const AVAILABILITY_TTL_MS = 5 * 60 * 1000;

/**
 * Whether migration 0006 has been applied.
 *
 * The guest entry points are only shown when it has. Without this check the
 * landing page would offer a button that fails on every click until someone
 * runs the migration.
 */
export async function guestModeAvailable(): Promise<boolean> {
  if (availability && Date.now() - availability.checkedAt < AVAILABILITY_TTL_MS) {
    return availability.value;
  }
  let value = false;
  try {
    // A plain GET, not `head: true`: PostgREST answers a HEAD on a missing
    // table with 204 and no error, which reads as "available" (seen 11 Nov 2026).
    const { error } = await supabaseAdmin().from("fs_guest_usage").select("day").limit(1);
    value = !error;
  } catch {
    value = false;
  }
  availability = { value, checkedAt: Date.now() };
  return value;
}
