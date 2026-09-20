/**
 * Parity tests for the chunker, ported from the Python suite.
 *
 * The three overlap tests are the important ones. They pin the bug that cost
 * 11% of the v1 corpus to duplicated text, and the shape of the fix: overlap
 * must be applied exactly once, never twice, and never zero times.
 */
import { describe, expect, it } from "vitest";

import { chunkFiling, splitLong } from "@/lib/rag/chunking";

/** Distinct characters, so a real overlap is distinguishable from a duplicated one. */
function distinctText(length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += String.fromCharCode("a".charCodeAt(0) + (i % 26));
  }
  return out;
}

describe("splitLong", () => {
  it("returns short text unchanged and drops empty text", () => {
    expect(splitLong("short", 900, 150)).toEqual(["short"]);
    expect(splitLong("   ", 900, 150)).toEqual([]);
  });

  it("splits on paragraphs and keeps the overlap", () => {
    const overlap = 30;
    const size = 120;
    const text = ["a".repeat(100), "b".repeat(100), "c".repeat(100)].join("\n\n");
    const chunks = splitLong(text, size, overlap);

    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[1].startsWith(chunks[0].slice(-overlap))).toBe(true);
  });

  it("never lets a long paragraph be overlapped twice", () => {
    const overlap = 20;
    const size = 100;
    const chunks = splitLong(distinctText(500), size, overlap);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(
        chunk.slice(0, overlap),
        `chunk repeats its own opening: ${JSON.stringify(chunk.slice(0, 2 * overlap))}`,
      ).not.toBe(chunk.slice(overlap + 1, 2 * overlap + 1));
    }
  });

  it("still overlaps consecutive chunks exactly once", () => {
    const overlap = 20;
    const size = 100;
    const chunks = splitLong(distinctText(500), size, overlap);

    for (let i = 1; i < chunks.length; i++) {
      expect(
        chunks[i].startsWith(chunks[i - 1].slice(-overlap)),
        "context continuity was lost",
      ).toBe(true);
    }
  });

  it("covers the whole source text with no gaps", () => {
    const overlap = 20;
    const size = 100;
    const para = distinctText(500);
    const chunks = splitLong(para, size, overlap);

    const rebuilt = chunks[0] + chunks.slice(1).map((c) => c.slice(overlap)).join("");
    expect(rebuilt.replaceAll("\n", "")).toBe(para);
  });
});

describe("chunkFiling", () => {
  const meta = {
    ticker: "nvda",
    company: "NVIDIA Corporation",
    fiscalYear: "2024",
    sourceUrl: "https://sec.gov/x.htm",
    filingType: "10-K",
  };

  const filing = [
    "Item 1. Business\n\n",
    "We design and sell graphics processors. ".repeat(20),
    "\n\nItem 1A. Risk Factors\n\n",
    "Competition is intense and demand may fall. ".repeat(20),
    "\n\nItem 7. Management's Discussion and Analysis\n\n",
    "Revenue increased due to data center growth. ".repeat(20),
    "\n\nItem 8. Financial Statements\n\n",
    "Total revenue was reported as a specific figure here. ".repeat(20),
  ].join("");

  it("carries provenance onto every chunk", () => {
    const chunks = chunkFiling(filing, meta, 1200, 200);

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].ticker).toBe("NVDA"); // upper-cased
    expect(chunks[0].company).toBe("NVIDIA Corporation");
    expect(chunks[0].fiscalYear).toBe("2024");
    expect(chunks[0].sourceUrl).toBe("https://sec.gov/x.htm");
    expect(chunks[0].chunkId.startsWith("NVDA_FY2024::")).toBe(true);
    expect(chunks.every((c) => c.section.length > 0)).toBe(true);
  });

  it("gives every chunk a unique id and a contiguous ordinal", () => {
    const chunks = chunkFiling(filing, meta, 1200, 200);
    const ids = new Set(chunks.map((c) => c.chunkId));

    expect(ids.size).toBe(chunks.length);
    expect(chunks.map((c) => c.ordinal)).toEqual(chunks.map((_, i) => i));
  });
});
