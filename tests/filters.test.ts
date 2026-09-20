/**
 * Tests for query understanding: which filing should a question be routed to.
 */
import { describe, expect, it } from "vitest";

import { buildAliasIndex, detectFilters, isOverConstrained } from "@/lib/rag/filters";

const FILINGS = [
  { ticker: "NVDA", company: "NVIDIA Corporation", fiscalYear: "2026" },
  { ticker: "AAPL", company: "Apple Inc.", fiscalYear: "2025" },
  { ticker: "MSFT", company: "Microsoft Corporation", fiscalYear: "2025" },
];

describe("buildAliasIndex", () => {
  it("maps both the ticker and the company name to the ticker", () => {
    const alias = buildAliasIndex(FILINGS);

    expect(alias.get("nvda")).toBe("NVDA");
    expect(alias.get("nvidia")).toBe("NVDA");
    expect(alias.get("apple")).toBe("AAPL");
    expect(alias.get("microsoft")).toBe("MSFT");
  });

  it("does not turn corporate suffixes into aliases", () => {
    const alias = buildAliasIndex(FILINGS);

    // "corporation" appears in two company names, so aliasing it would route
    // every question mentioning it to whichever filing was ingested first.
    expect(alias.has("corporation")).toBe(false);
    expect(alias.has("inc")).toBe(false);
  });
});

describe("detectFilters", () => {
  it("detects a single company by name", () => {
    expect(detectFilters("What are NVIDIA's main risk factors?", FILINGS)).toEqual({
      tickers: ["NVDA"],
      years: [],
    });
  });

  it("detects a company by ticker", () => {
    expect(detectFilters("msft cloud revenue", FILINGS).tickers).toEqual(["MSFT"]);
  });

  it("keeps both companies in a comparison", () => {
    const filters = detectFilters(
      "Compare the revenue drivers of NVIDIA and Microsoft.",
      FILINGS,
    );

    // Dropping one side here is what makes a comparison answer half-blind.
    expect(filters.tickers).toEqual(["MSFT", "NVDA"]);
  });

  it("keeps a year only when that year was actually ingested", () => {
    expect(detectFilters("Apple net sales in 2025", FILINGS).years).toEqual(["2025"]);
    expect(detectFilters("Apple net sales in 2019", FILINGS).years).toEqual([]);
  });

  it("returns an empty filter for an out-of-scope question", () => {
    expect(detectFilters("What is the weather in Jakarta tomorrow?", FILINGS)).toEqual({
      tickers: [],
      years: [],
    });
  });

  it("is case insensitive", () => {
    expect(detectFilters("nvidia RISK factors", FILINGS).tickers).toEqual(["NVDA"]);
  });
});

describe("isOverConstrained", () => {
  it("is false when the filter selects at least one filing", () => {
    expect(
      isOverConstrained({ tickers: ["AAPL"], years: ["2025"] }, FILINGS),
    ).toBe(false);
  });

  it("is true when company and year cannot both be satisfied", () => {
    // NVDA exists and 2025 exists, but no NVDA FY2025 filing does. Searching
    // with this filter would return nothing and the gate would refuse a
    // question the corpus can partly answer.
    expect(isOverConstrained({ tickers: ["NVDA"], years: ["2025"] }, FILINGS)).toBe(true);
  });

  it("is false when there is no filter at all", () => {
    expect(isOverConstrained({ tickers: [], years: [] }, FILINGS)).toBe(false);
  });
});
