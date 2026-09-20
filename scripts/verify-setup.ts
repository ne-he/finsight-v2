/**
 * Pre-flight check for a fresh environment.
 *
 * Run after filling `.env.local` and applying the migrations. It answers the
 * questions that otherwise only surface later as a confusing runtime error:
 * is every table there, is the search function callable, is Row Level Security
 * actually on, do the third-party credentials work, and, because this project
 * shares a Supabase instance with another app, is that app still intact.
 *
 * It prints key names and outcomes, never key values.
 *
 *     npm run verify
 */
import "./load-env";

import { createClient } from "@supabase/supabase-js";

const FS_TABLES = [
  "fs_profiles",
  "fs_filings",
  "fs_filing_text",
  "fs_chunks",
  "fs_ingest_jobs",
  "fs_conversations",
  "fs_messages",
  "fs_feedback",
  "fs_embedding_cache",
  "fs_usage",
  "fs_usage_global",
];

/** Objects owned by the other app in this Supabase project. Must stay untouched. */
const NEIGHBOUR_TABLES = ["chunks", "usage_counter"];

let failures = 0;
let warnings = 0;

const pass = (label: string, detail = "") =>
  console.log(`  ok    ${label}${detail ? `  (${detail})` : ""}`);
const warn = (label: string, detail: string) => {
  warnings++;
  console.log(`  warn  ${label}  (${detail})`);
};
const fail = (label: string, detail: string) => {
  failures++;
  console.log(`  FAIL  ${label}  (${detail})`);
};
const section = (title: string) => console.log(`\n${title}`);

async function main() {
  console.log("FinSight v2 setup check");

  section("Environment");
  const required = [
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "GEMINI_API_KEY",
    "EDGAR_USER_AGENT",
  ];
  for (const name of required) {
    const value = process.env[name];
    if (!value) fail(name, "missing");
    else pass(name, `${value.length} chars`);
  }
  if (failures > 0) {
    console.log("\nFix the environment first, nothing else can be checked.");
    process.exit(1);
  }

  const agent = process.env.EDGAR_USER_AGENT!;
  if (!agent.includes("@")) {
    warn("EDGAR_USER_AGENT", "SEC expects a contact email in the value");
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });
  const anon = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { persistSession: false },
  });

  section("Schema (migrations 0001 and 0004)");
  for (const table of FS_TABLES) {
    const { count, error } = await admin
      .from(table)
      .select("*", { count: "exact", head: true });
    if (error) fail(table, error.message);
    else pass(table, `${count ?? 0} rows`);
  }

  section("The other app in this project (must be untouched)");
  for (const table of NEIGHBOUR_TABLES) {
    const { count, error } = await admin
      .from(table)
      .select("*", { count: "exact", head: true });
    if (error) warn(table, `not reachable: ${error.message}`);
    else pass(table, `${count ?? 0} rows, intact`);
  }
  {
    const { error } = await admin.rpc("match_chunks", {
      query_embedding: JSON.stringify(new Array(768).fill(0)),
      query_text: "setup check",
      match_count: 1,
    });
    if (error) warn("match_chunks()", `not callable: ${error.message}`);
    else pass("match_chunks()", "still callable");
  }

  section("Search function (migration 0003)");
  {
    const { data, error } = await admin.rpc("fs_match_chunks", {
      query_embedding: JSON.stringify(new Array(768).fill(0)),
      query_text: "risk factors",
      filter_tickers: [],
      filter_years: [],
      k_dense: 10,
      k_sparse: 10,
      rrf_k: 60,
      final_k: 6,
    });
    if (error) fail("fs_match_chunks()", error.message);
    else pass("fs_match_chunks()", `returned ${(data ?? []).length} rows`);
  }

  section("Rate limit function (migration 0004)");
  {
    // A random uuid owns no auth.users row, so the foreign key must reject it.
    // That rejection is itself proof the function exists and is wired to auth.
    const { error } = await admin.rpc("fs_bump_usage", {
      p_user: "00000000-0000-0000-0000-000000000000",
      p_user_limit: 1,
      p_global_limit: 1,
    });
    if (!error) warn("fs_bump_usage()", "accepted an unknown user id");
    else if (/foreign key|violates/i.test(error.message)) {
      pass("fs_bump_usage()", "exists and enforces the user foreign key");
    } else if (/does not exist|could not find/i.test(error.message)) {
      fail("fs_bump_usage()", error.message);
    } else {
      warn("fs_bump_usage()", error.message);
    }
  }

  section("Profile bootstrap (migration 0005)");
  {
    // Called with a uuid that owns no auth.users row, so a foreign key error
    // means the function is present and correctly wired.
    const { error } = await admin.rpc("fs_ensure_profile", {
      p_id: "00000000-0000-0000-0000-000000000000",
      p_email: null,
    });
    if (error && /does not exist|could not find/i.test(error.message)) {
      warn(
        "fs_ensure_profile()",
        "migration 0005 not applied, the app falls back to a racy in-app bootstrap",
      );
    } else if (error && /foreign key|violates/i.test(error.message)) {
      pass("fs_ensure_profile()", "exists and enforces the user foreign key");
    } else if (error) {
      warn("fs_ensure_profile()", error.message);
    } else {
      warn("fs_ensure_profile()", "accepted an unknown user id");
    }
  }

  section("Row Level Security (migration 0002)");
  {
    // The anon key ships to every browser, so these reads must return nothing.
    const cache = await anon.from("fs_embedding_cache").select("text_hash").limit(1);
    if ((cache.data ?? []).length > 0) fail("fs_embedding_cache", "readable with the anon key");
    else pass("fs_embedding_cache", "closed to the anon key");

    const conversations = await anon.from("fs_conversations").select("id").limit(1);
    if ((conversations.data ?? []).length > 0) fail("fs_conversations", "readable while signed out");
    else pass("fs_conversations", "closed while signed out");

    const jobs = await anon.from("fs_ingest_jobs").select("id").limit(1);
    if ((jobs.data ?? []).length > 0) fail("fs_ingest_jobs", "readable without admin");
    else pass("fs_ingest_jobs", "closed without admin");
  }
  {
    const { error } = await admin.rpc("fs_is_admin");
    if (error && /does not exist|could not find/i.test(error.message)) {
      fail("fs_is_admin()", error.message);
    } else pass("fs_is_admin()", "defined");
  }

  section("Gemini");
  {
    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": process.env.GEMINI_API_KEY!,
        },
        body: JSON.stringify({
          content: { parts: [{ text: "setup check" }] },
          outputDimensionality: 768,
        }),
      },
    );
    if (!response.ok) {
      fail("embedContent", `${response.status} ${(await response.text()).slice(0, 120)}`);
    } else {
      const json = (await response.json()) as { embedding?: { values?: number[] } };
      const dims = json.embedding?.values?.length ?? 0;
      if (dims === 768) pass("embedContent", "768 dimensions, 1 request spent");
      else fail("embedContent", `returned ${dims} dimensions`);
    }
  }

  section("SEC EDGAR");
  {
    const response = await fetch("https://www.sec.gov/files/company_tickers.json", {
      headers: { "User-Agent": agent },
    });
    if (!response.ok) fail("company_tickers.json", `HTTP ${response.status}`);
    else {
      const rows = (await response.json()) as Record<string, unknown>;
      pass("company_tickers.json", `${Object.keys(rows).length} tickers`);
    }
  }

  console.log(
    `\n${failures === 0 ? "Ready." : `${failures} check(s) failed.`}${
      warnings > 0 ? ` ${warnings} warning(s).` : ""
    }`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("\nCheck crashed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
