/**
 * Retrieval evaluation.
 *
 * This is the script that decides whether any quality claim about FinSight v2
 * is allowed to be made. The v1 numbers were measured against a BM25 retriever
 * that no longer exists, so until this runs, nothing about accuracy is known.
 *
 * What it measures:
 *
 *   hit-rate@k      did the right company's filing appear in the top k
 *   gate accuracy   did out-of-scope questions fall below the threshold
 *   cosine gap      the separation between legitimate and out-of-scope
 *                   questions, which is what the threshold should be chosen
 *                   from, rather than guessed
 *
 * Retrieval only, so it costs one embedding request per question and no
 * generation quota at all. Generation quality needs a judge and a lot more
 * quota; it is deliberately not attempted here.
 *
 *     npm run eval
 *     npm run eval -- --write     also writes evals/results/<date>.md
 */
import "./load-env";

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { CONFIDENCE_THRESHOLD, FINAL_K } from "../src/config";
import { loadFilings, retrieve } from "../src/lib/rag/retrieve";

interface GoldenItem {
  id: string;
  question: string;
  type: "factual" | "comparison" | "out-of-scope";
  expected: string[];
  note?: string;
}

interface Outcome extends GoldenItem {
  hit: boolean;
  gated: boolean;
  topCosine: number;
  retrieved: string[];
  skipped?: string;
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

async function main() {
  const write = process.argv.includes("--write");

  const admin: SupabaseClient = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );

  const filings = await loadFilings(admin);
  if (filings.length === 0) {
    console.error("No filings are ingested. Run: npm run ingest -- NVDA");
    process.exit(1);
  }
  const ingested = new Set(filings.map((f) => f.ticker));

  const golden = JSON.parse(
    readFileSync(resolve(process.cwd(), "evals/golden-set.json"), "utf8"),
  ) as GoldenItem[];

  console.log(
    `Corpus: ${filings.map((f) => `${f.ticker} FY${f.fiscalYear}`).join(", ")}`,
  );
  console.log(`Golden set: ${golden.length} questions, k = ${FINAL_K}\n`);

  const outcomes: Outcome[] = [];

  for (const item of golden) {
    // A question about a company that is not ingested measures nothing except
    // that it is not ingested, so it is reported as skipped rather than scored
    // as a failure.
    const missing = item.expected.filter((t) => !ingested.has(t));
    if (missing.length > 0) {
      outcomes.push({
        ...item,
        hit: false,
        gated: false,
        topCosine: 0,
        retrieved: [],
        skipped: `not ingested: ${missing.join(", ")}`,
      });
      console.log(`  skip  ${item.id.padEnd(22)} ${missing.join(", ")} not ingested`);
      continue;
    }

    const result = await retrieve(admin, item.question, filings);
    const retrieved = [...new Set(result.chunks.map((c) => c.ticker))];
    const hit =
      item.type === "out-of-scope"
        ? result.gated
        : item.expected.every((t) => retrieved.includes(t));

    outcomes.push({
      ...item,
      hit,
      gated: result.gated,
      topCosine: result.topCosine,
      retrieved,
    });

    console.log(
      `  ${hit ? "ok  " : "MISS"}  ${item.id.padEnd(22)} cos ${result.topCosine.toFixed(3)}  ${
        result.gated ? "gated" : "open "
      }  [${retrieved.join(", ") || "none"}]`,
    );
  }

  const scored = outcomes.filter((o) => !o.skipped);
  const answerable = scored.filter((o) => o.type !== "out-of-scope");
  const outOfScope = scored.filter((o) => o.type === "out-of-scope");

  const hits = answerable.filter((o) => o.hit).length;
  const gateCorrect = outOfScope.filter((o) => o.gated).length;
  const falseRefusals = answerable.filter((o) => o.gated);

  const legitCosines = answerable.map((o) => o.topCosine).sort((a, b) => a - b);
  const oosCosines = outOfScope.map((o) => o.topCosine).sort((a, b) => a - b);

  const legitMin = legitCosines[0] ?? 0;
  const oosMax = oosCosines[oosCosines.length - 1] ?? 0;
  const gap = legitMin - oosMax;

  console.log(`\nRetrieval hit-rate@${FINAL_K}   ${hits}/${answerable.length}`);
  console.log(`Gate accuracy            ${gateCorrect}/${outOfScope.length}`);
  console.log(`False refusals           ${falseRefusals.length}`);
  console.log(`Mean top cosine          ${mean(answerable.map((o) => o.topCosine)).toFixed(4)}`);
  console.log(
    `Answerable cosine range  ${legitMin.toFixed(3)} to ${(legitCosines[legitCosines.length - 1] ?? 0).toFixed(3)}`,
  );
  console.log(
    `Out-of-scope range       ${(oosCosines[0] ?? 0).toFixed(3)} to ${oosMax.toFixed(3)}`,
  );

  console.log(`\nThreshold now            ${CONFIDENCE_THRESHOLD}`);
  if (gap > 0) {
    const suggested = Math.round(((oosMax + legitMin) / 2) * 1000) / 1000;
    console.log(`Clean gap of ${gap.toFixed(3)}, midpoint ${suggested}`);
    if (Math.abs(suggested - CONFIDENCE_THRESHOLD) > 0.02) {
      console.log(`Consider setting CONFIDENCE_THRESHOLD to ${suggested}`);
    } else {
      console.log("The current threshold sits inside the gap.");
    }
  } else {
    console.log(
      "No clean gap: some out-of-scope question scores at least as high as a real one.",
    );
    console.log("A single threshold cannot separate them perfectly on this corpus.");
  }

  if (write) {
    const date = new Date().toISOString().slice(0, 10);
    const dir = resolve(process.cwd(), "evals/results");
    mkdirSync(dir, { recursive: true });

    const report = [
      `# Retrieval eval, ${date}`,
      "",
      `Corpus: ${filings.map((f) => `${f.ticker} FY${f.fiscalYear}`).join(", ")}.`,
      `Embedding model gemini-embedding-001 at 768 dimensions, k = ${FINAL_K}, threshold ${CONFIDENCE_THRESHOLD}.`,
      `Keyword arm is Postgres ts_rank_cd, fused with the vector arm by RRF inside SQL.`,
      "",
      "| Metric | Result |",
      "|---|---|",
      `| Retrieval hit-rate@${FINAL_K} | ${hits}/${answerable.length} |`,
      `| Out-of-scope gate accuracy | ${gateCorrect}/${outOfScope.length} |`,
      `| False refusals | ${falseRefusals.length} |`,
      `| Mean top cosine | ${mean(answerable.map((o) => o.topCosine)).toFixed(4)} |`,
      `| Answerable cosine range | ${legitMin.toFixed(3)} to ${(legitCosines[legitCosines.length - 1] ?? 0).toFixed(3)} |`,
      `| Out-of-scope cosine range | ${(oosCosines[0] ?? 0).toFixed(3)} to ${oosMax.toFixed(3)} |`,
      "",
      "## Per question",
      "",
      "| Id | Type | Result | Top cosine | Gated | Retrieved |",
      "|---|---|---|---|---|---|",
      ...outcomes.map((o) =>
        o.skipped
          ? `| ${o.id} | ${o.type} | skipped | | | ${o.skipped} |`
          : `| ${o.id} | ${o.type} | ${o.hit ? "pass" : "**fail**"} | ${o.topCosine.toFixed(3)} | ${o.gated ? "yes" : "no"} | ${o.retrieved.join(", ") || "none"} |`,
      ),
      "",
      "Retrieval only. Answer faithfulness is not measured here, because judging",
      "it needs generation quota that the free tier does not have in one sitting.",
      "",
    ].join("\n");

    const path = resolve(dir, `${date}.md`);
    writeFileSync(path, report, "utf8");
    console.log(`\nWrote ${path}`);
  }
}

main().catch((error) => {
  console.error(`\n${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
