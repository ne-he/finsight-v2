/**
 * Parity tests for 10-K section detection, ported from the Python suite.
 *
 * Two failure modes are pinned here because both happened on real filings:
 * the Table of Contents winning over the real section, and repeated page
 * headers shattering the financial statements into fragments.
 */
import { describe, expect, it } from "vitest";

import { FULL_FILING, splitIntoSections } from "@/lib/rag/sections";

const TOC = [
  "Table of Contents",
  "Item 1. Business 1",
  "Item 1A. Risk Factors 5",
  "Item 7. MD&A 20",
  "Item 8. Financial Statements 40",
  "Item 9. Other 60",
  "",
  "",
].join("\n");

const BODY = [
  "Item 1. Business\n\n",
  "We design and sell graphics processors. ".repeat(20),
  "\n\nItem 1A. Risk Factors\n\n",
  "Competition is intense and demand may fall. ".repeat(20),
  "\n\nItem 7. Management's Discussion and Analysis\n\n",
  "Revenue increased due to data center growth. ".repeat(20),
  "\n\nItem 8. Financial Statements\n\n",
  // Repeated page-header noise that must be collapsed, not treated as boundaries.
  "Item 8.\n".repeat(30),
  "Total revenue was reported as a specific figure here. ".repeat(20),
  "\n\nItem 9. Other Information\n\nshort tail",
].join("");

function sectionMap(text: string): Map<string, string> {
  return new Map(splitIntoSections(text).map((s) => [s.name, s.body]));
}

describe("splitIntoSections", () => {
  it("detects the major items", () => {
    const names = [...sectionMap(TOC + BODY).keys()];

    expect(names.some((n) => n.includes("Risk Factors"))).toBe(true);
    expect(names.some((n) => n.includes("MD&A"))).toBe(true);
    expect(names.some((n) => n.includes("Financial Statements"))).toBe(true);
    expect(names.length).toBeGreaterThanOrEqual(3);
  });

  it("prefers the real section body over the table of contents entry", () => {
    const sections = sectionMap(TOC + BODY);
    const risk = [...sections].find(([name]) => name.includes("Risk Factors"))?.[1] ?? "";

    expect(risk).toContain("Competition is intense");
  });

  it("collapses repeated page headers and keeps the section body", () => {
    const sections = sectionMap(TOC + BODY);
    const financials =
      [...sections].find(([name]) => name.includes("Financial Statements"))?.[1] ?? "";

    expect(financials).toContain("Total revenue was reported");
  });

  it("returns the whole document when no items are present", () => {
    const text = "Just some prose with no item headings at all. ".repeat(30);

    expect(splitIntoSections(text)).toEqual([{ name: FULL_FILING, body: text }]);
  });

  it("returns the whole document when too few credible sections are found", () => {
    const text = `Item 1. Business\n\n${"x".repeat(600)}`;

    expect(splitIntoSections(text)).toEqual([{ name: FULL_FILING, body: text }]);
  });

  it("keeps sections in document order", () => {
    const names = splitIntoSections(TOC + BODY).map((s) => s.name);
    const sorted = [...names];

    // Business precedes Risk Factors precedes MD&A in a 10-K, and the detector
    // must not reorder them just because the map iteration order differs.
    expect(names).toEqual(sorted);
    expect(names.indexOf("Item 1. Business")).toBeLessThan(
      names.indexOf("Item 1A. Risk Factors"),
    );
  });
});
