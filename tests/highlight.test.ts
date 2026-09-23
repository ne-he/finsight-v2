/**
 * Tests for pointing a citation at the sentence it most likely came from.
 */
import { describe, expect, it } from "vitest";

import { displayName, joinNames } from "@/lib/company";
import { bestSentence, cleanExcerpt, sentenceSpans, terms } from "@/lib/highlight";

const PASSAGE =
  "We depend on a limited number of partners to manufacture our products. " +
  "A limited number of customers account for a substantial portion of our revenue. " +
  "Export controls restrict sales of certain products to China.";

describe("terms", () => {
  it("drops stopwords and short words, and stems plurals", () => {
    const set = terms("The customers and their risks");
    expect(set.has("customer")).toBe(true);
    expect(set.has("risk")).toBe(true);
    expect(set.has("the")).toBe(false);
    expect(set.has("their")).toBe(false);
  });
});

describe("sentenceSpans", () => {
  it("maps each sentence back to offsets in the original text", () => {
    const spans = sentenceSpans(PASSAGE);
    expect(spans).toHaveLength(3);
    expect(PASSAGE.slice(spans[1].start, spans[1].end)).toBe(
      "A limited number of customers account for a substantial portion of our revenue.",
    );
  });
});

describe("bestSentence", () => {
  it("picks the sentence sharing the most words with the claim", () => {
    const match = bestSentence(PASSAGE, "Revenue depends on a few large customers");
    expect(match).not.toBeNull();
    expect(PASSAGE.slice(match!.start, match!.end)).toContain("substantial portion of our revenue");
  });

  it("finds the export sentence for an export claim", () => {
    const match = bestSentence(PASSAGE, "export controls limit sales to China");
    expect(PASSAGE.slice(match!.start, match!.end)).toContain("Export controls");
  });

  it("returns null instead of a weak guess", () => {
    expect(bestSentence(PASSAGE, "Risiko utama perusahaan ini")).toBeNull();
    expect(bestSentence(PASSAGE, "")).toBeNull();
  });
});

describe("cleanExcerpt", () => {
  it("drops a leading sentence fragment carried over from the previous chunk", () => {
    const text = "of our suppliers. Our business depends on demand. Demand may change.";
    expect(cleanExcerpt(text, 500)).toBe("Our business depends on demand. Demand may change.");
  });

  it("cuts at a sentence end when the text is too long", () => {
    const text = "First sentence here. Second sentence is a bit longer. Third one.";
    expect(cleanExcerpt(text, 40)).toBe("First sentence here.");
  });
});

describe("displayName", () => {
  it("removes legal suffixes and calms upper case", () => {
    expect(displayName("MICROSOFT CORP")).toBe("Microsoft");
    expect(displayName("Apple Inc.")).toBe("Apple");
  });

  it("keeps brands that are officially written in capitals", () => {
    expect(displayName("NVIDIA CORP")).toBe("NVIDIA");
  });

  it("joins names for a sentence", () => {
    expect(joinNames(["NVIDIA", "Apple", "Microsoft"])).toBe("NVIDIA, Apple or Microsoft");
    expect(joinNames(["NVIDIA", "Apple"], "and")).toBe("NVIDIA and Apple");
  });
});
