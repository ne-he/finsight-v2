/**
 * Download one filing and report what the parser makes of it, without writing
 * anything or spending any embedding quota.
 *
 * This is the check unit tests cannot give. The tests run against synthetic
 * text that was written to exercise the code; a real 10-K is 300 pages of
 * layout markup written by lawyers. Section detection either survives that or
 * it does not, and the only way to know is to look.
 *
 *     npm run inspect -- NVDA
 */
import "./load-env";

import { CHUNK_OVERLAP, CHUNK_SIZE } from "../src/config";
import { chunkFiling } from "../src/lib/rag/chunking";
import { fetchLatestTenK } from "../src/lib/rag/edgar";
import { splitIntoSections } from "../src/lib/rag/sections";

function bar(fraction: number, width = 24): string {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)));
  return "#".repeat(filled) + ".".repeat(width - filled);
}

async function main() {
  const ticker = (process.argv[2] ?? "NVDA").trim().toUpperCase();
  console.log(`Fetching the latest 10-K for ${ticker}...\n`);

  const filing = await fetchLatestTenK(ticker, process.env.EDGAR_USER_AGENT!);

  console.log(`  company      ${filing.company}`);
  console.log(`  fiscal year  ${filing.fiscalYear}`);
  console.log(`  filed        ${filing.filingDate}`);
  console.log(`  clean text   ${filing.text.length.toLocaleString()} chars`);
  console.log(`  source       ${filing.sourceUrl}\n`);

  const sections = splitIntoSections(filing.text);
  const covered = sections.reduce((sum, s) => sum + s.body.length, 0);

  if (sections.length === 1 && sections[0].name === "Full Filing") {
    console.log("  WARNING: no Item skeleton detected, the whole filing is one section.");
    console.log("  Citations will not name a section. Check the HTML stripper.\n");
  }

  console.log(`Sections (${sections.length}, covering ${((covered / filing.text.length) * 100).toFixed(1)}% of the text)`);
  for (const section of sections) {
    const share = section.body.length / filing.text.length;
    console.log(
      `  ${bar(share)}  ${(section.body.length / 1000).toFixed(0).padStart(4)}k  ${section.name}`,
    );
  }

  const chunks = chunkFiling(
    filing.text,
    {
      ticker: filing.ticker,
      company: filing.company,
      fiscalYear: filing.fiscalYear,
      sourceUrl: filing.sourceUrl,
    },
    CHUNK_SIZE,
    CHUNK_OVERLAP,
  );

  const lengths = chunks.map((c) => c.text.length).sort((a, b) => a - b);
  const median = lengths[Math.floor(lengths.length / 2)] ?? 0;
  const ids = new Set(chunks.map((c) => c.chunkId));

  console.log(`\nChunks (size ${CHUNK_SIZE}, overlap ${CHUNK_OVERLAP})`);
  console.log(`  count        ${chunks.length}`);
  console.log(`  unique ids   ${ids.size}${ids.size === chunks.length ? "" : "  <-- COLLISION"}`);
  console.log(`  length       min ${lengths[0]}, median ${median}, max ${lengths[lengths.length - 1]}`);
  console.log(`  embed cost   ${chunks.length} requests of the 1,000 daily free tier`);

  // The bug that cost 11% of the v1 corpus. Worth re-checking on every real
  // filing, because it was invisible in citations and only showed up in the
  // degraded answer.
  const repeats = chunks.filter((c) => {
    const head = c.text.slice(0, CHUNK_OVERLAP).trim();
    return head.length >= 40 && c.text.indexOf(head, CHUNK_OVERLAP / 2) !== -1;
  });
  console.log(
    `  duplicated openings  ${repeats.length}${repeats.length === 0 ? "" : "  <-- overlap applied twice"}`,
  );

  const tiny = chunks.filter((c) => c.text.length < 100);
  if (tiny.length > 0) {
    console.log(`  WARNING: ${tiny.length} chunks under 100 chars, likely parse noise.`);
  }

  console.log("\nSample chunk\n");
  const sample = chunks.find((c) => c.section.includes("Risk Factors")) ?? chunks[0];
  console.log(`  [${sample.ticker} FY${sample.fiscalYear} * ${sample.section}]`);
  console.log(`  ${sample.text.slice(0, 300).replace(/\n/g, " ")}...`);
}

main().catch((error) => {
  console.error(`\nFailed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
