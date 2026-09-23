/**
 * Tests for turning a streamed answer into renderable structure.
 */
import { describe, expect, it } from "vitest";

import { matchSource, orderByCitation, parseAnswer, parseInline } from "@/lib/answer-format";

describe("parseInline", () => {
  it("extracts a citation tag", () => {
    expect(parseInline("Supply is tight [NVDA FY2026 * Item 1A. Risk Factors].")).toEqual([
      { kind: "text", text: "Supply is tight " },
      {
        kind: "cite",
        ticker: "NVDA",
        fiscalYear: "2026",
        section: "Item 1A. Risk Factors",
        raw: "[NVDA FY2026 * Item 1A. Risk Factors]",
      },
      { kind: "text", text: "." },
    ]);
  });

  it("does not mistake the citation asterisk for bold", () => {
    const parts = parseInline("**Revenue** grew [AAPL FY2025 * Item 7. MD&A] and **margin** held");
    expect(parts.map((p) => p.kind)).toEqual(["bold", "text", "cite", "text", "bold", "text"]);
  });

  it("accepts a middle dot as the separator", () => {
    const [cite] = parseInline("[MSFT FY2025 \u00b7 Item 1. Business]");
    expect(cite).toMatchObject({ kind: "cite", ticker: "MSFT", section: "Item 1. Business" });
  });

  it("leaves ordinary brackets alone", () => {
    expect(parseInline("see [note 3]")).toEqual([{ kind: "text", text: "see [note 3]" }]);
  });
});

describe("parseAnswer", () => {
  it("groups bullets into one list and keeps paragraphs apart", () => {
    const blocks = parseAnswer("Main risks:\n\n* Supply\n* Export rules\n\nIn short, two.");
    expect(blocks.map((b) => b.kind)).toEqual(["paragraph", "list", "paragraph"]);
    const list = blocks[1];
    expect(list.kind === "list" && list.items.length).toBe(2);
  });

  it("recognises numbered lists and headings", () => {
    const blocks = parseAnswer("### Summary\n1. First\n2. Second");
    expect(blocks[0].kind).toBe("heading");
    expect(blocks[1]).toMatchObject({ kind: "list", ordered: true });
  });

  it("attaches an indented continuation to the previous item", () => {
    const blocks = parseAnswer("- First point\n  continues here\n- Second");
    const list = blocks[0];
    expect(list.kind === "list" && list.items[0]).toEqual([
      { kind: "text", text: "First point continues here" },
    ]);
  });

  it("survives a half-streamed citation without crashing", () => {
    expect(() => parseAnswer("Growth was strong [NVDA FY20")).not.toThrow();
  });
});

describe("matchSource", () => {
  const sources = [
    { ticker: "NVDA", fiscalYear: "2026", section: "Item 1A. Risk Factors" },
    {
      ticker: "NVDA",
      fiscalYear: "2026",
      section: "Item 7. Management's Discussion and Analysis of Financial Condition",
    },
  ];

  it("matches exactly, ignoring case", () => {
    expect(
      matchSource({ ticker: "NVDA", fiscalYear: "2026", section: "item 1a. risk factors" }, sources),
    ).toBe(0);
  });

  it("falls back to the Item number when the model shortens the title", () => {
    expect(matchSource({ ticker: "NVDA", fiscalYear: "2026", section: "Item 7" }, sources)).toBe(1);
  });

  it("returns -1 for another company or an unknown section", () => {
    expect(
      matchSource({ ticker: "AAPL", fiscalYear: "2026", section: "Item 1A. Risk Factors" }, sources),
    ).toBe(-1);
    expect(matchSource({ ticker: "NVDA", fiscalYear: "2026", section: "Appendix" }, sources)).toBe(-1);
  });
});

describe("orderByCitation", () => {
  const sources = [
    { ticker: "AAPL", fiscalYear: "2025", section: "Item 8. Financial Statements" },
    { ticker: "NVDA", fiscalYear: "2026", section: "Item 15. Exhibits" },
    { ticker: "NVDA", fiscalYear: "2026", section: "Item 7. MD&A" },
  ];

  it("puts the first cited source first and keeps uncited ones at the end", () => {
    const answer =
      "Revenue grew [NVDA FY2026 * Item 7. MD&A]. Apple reports segments [AAPL FY2025 * Item 8. Financial Statements].";
    expect(orderByCitation(answer, sources).map((s) => s.section)).toEqual([
      "Item 7. MD&A",
      "Item 8. Financial Statements",
      "Item 15. Exhibits",
    ]);
  });

  it("is stable as the answer streams in", () => {
    const partial = "Revenue grew [NVDA FY2026 * Item 7. MD&A]. Apple";
    const full = `${partial} reports segments [AAPL FY2025 * Item 8. Financial Statements].`;
    expect(orderByCitation(partial, sources)[0]).toEqual(orderByCitation(full, sources)[0]);
  });

  it("returns the same list when nothing is cited", () => {
    expect(orderByCitation("No citations here.", sources)).toEqual(sources);
  });
});
