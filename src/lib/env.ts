/**
 * Server-side environment, validated once at import.
 *
 * Do not import this from a Client Component. Everything here except the two
 * NEXT_PUBLIC values is a secret, and a stray import would try to bundle it
 * into the browser.
 *
 * Validating on import means a missing key fails the request with a clear
 * message instead of surfacing later as an unexplained 401 from a provider.
 */
import { z } from "zod";

const schema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),

  /** Bypasses Row Level Security. Never expose this to the browser. */
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  GEMINI_API_KEY: z.string().min(1),

  /**
   * SEC EDGAR rejects requests without a descriptive User-Agent carrying
   * contact details. This is a published requirement, not an optional nicety.
   */
  EDGAR_USER_AGENT: z.string().min(5),

  /** Questions per user per day, and across all users per day. */
  DAILY_LIMIT_PER_USER: z.coerce.number().int().positive().default(40),
  DAILY_LIMIT_GLOBAL: z.coerce.number().int().positive().default(400),

  /** Shared secret for the scheduled keep-alive call. */
  CRON_SECRET: z.string().min(8).optional(),
});

let cached: z.infer<typeof schema> | null = null;

export function env(): z.infer<typeof schema> {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    // Names only. Printing values here would put secrets in the server log.
    throw new Error(`Invalid or missing environment variables: ${missing}`);
  }
  cached = parsed.data;
  return cached;
}
