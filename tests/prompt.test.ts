/**
 * Tests for prompt assembly and the degraded answer.
 *
 * These pin behaviour that is easy to break and hard to notice: the weak
 * retrieval flag reaching the model, and the fallback never inventing prose.
 */
import { describe, expect, it } from "vitest";

import {
  buildContextBlock,
  buildUserTurn,
  citationOf,
  extractiveAnswer,
  FALLBACK_NOTICE,
  SYSTEM_PROMPT,
} from "@/lib/rag/prompt";
import type { RetrievedChunk } from "@/lib/rag/retrieve";

function chunk(overrides: Partial<RetrievedChunk> = {}): RetrievedChunk {
  return {
    chunkId: "NVDA_FY2026::Item 1A. Risk Factors::0",
    content: "Competition in our markets is intense.",
    ticker: "NVDA",
    company: "NVIDIA Corporation",
    fiscalYear: "2026",
    section: "Item 1A. Risk Factors",
    sourceUrl: "https://sec.gov/nvda.htm",
    similarity: 0.78,
    ...overrides,
  };
}

describe("citationOf", () => {
  it("names the company, year and section", () => {
    expect(citationOf(chunk())).toBe("[NVDA FY2026 * Item 1A. Risk Factors]");
  });
});

describe("buildContextBlock", () => {
  it("numbers excerpts and carries the source url", () => {
    const block = buildContextBlock([chunk(), chunk({ ticker: "AAPL" })]);

    expect(block).toContain("### Excerpt 1");
    expect(block).toContain("### Excerpt 2");
    expect(block).toContain("https://sec.gov/nvda.htm");
  });

  it("says so plainly when nothing was retrieved", () => {
    expect(buildContextBlock([])).toContain("[WEAK RETRIEVAL]");
  });
});

describe("buildUserTurn", () => {
  it("includes the question and the context", () => {
    const turn = buildUserTurn("What are the risks?", [chunk()], false);

    expect(turn).toContain("What are the risks?");
    expect(turn).toContain("Competition in our markets is intense.");
    expect(turn).not.toContain("[WEAK RETRIEVAL]");
  });

  it("flags weak retrieval so the model refuses instead of guessing", () => {
    expect(buildUserTurn("Tesla stock price?", [chunk()], true)).toContain(
      "[WEAK RETRIEVAL]",
    );
  });
});

describe("extractiveAnswer", () => {
  it("refuses when the gate fired", () => {
    const answer = extractiveAnswer([chunk()], true);

    expect(answer).toContain("could not find");
    expect(answer).not.toContain(FALLBACK_NOTICE);
  });

  it("refuses when nothing was retrieved", () => {
    expect(extractiveAnswer([], false)).toContain("could not find");
  });

  it("quotes retrieved passages with their citations, and labels itself", () => {
    const answer = extractiveAnswer([chunk()], false);

    expect(answer).toContain(FALLBACK_NOTICE);
    expect(answer).toContain("[NVDA FY2026 * Item 1A. Risk Factors]");
    expect(answer).toContain("Competition in our markets is intense.");
  });

  it("truncates a very long passage rather than dumping a whole chunk", () => {
    const answer = extractiveAnswer([chunk({ content: "x".repeat(2000) })], false);

    expect(answer).toContain("...");
    expect(answer.length).toBeLessThan(1200);
  });
});

describe("SYSTEM_PROMPT", () => {
  it("states the rules that make the product what it is", () => {
    expect(SYSTEM_PROMPT).toContain("Never round, infer, extrapolate, or invent a number");
    expect(SYSTEM_PROMPT).toContain("not investment advice");
    expect(SYSTEM_PROMPT).toContain("Answer in the language the question was asked in");
  });
});
