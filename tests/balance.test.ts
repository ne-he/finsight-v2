/**
 * Tests for splitting the context fairly between companies in a comparison.
 */
import { describe, expect, it } from "vitest";

import { balanceAcross, perListQuota } from "@/lib/rag/balance";

describe("perListQuota", () => {
  it("splits the limit evenly, rounding up", () => {
    expect(perListQuota(2, 6)).toBe(3);
    expect(perListQuota(3, 6)).toBe(2);
    expect(perListQuota(4, 6)).toBe(2);
  });

  it("never asks for zero", () => {
    expect(perListQuota(10, 6)).toBe(1);
    expect(perListQuota(0, 6)).toBe(6);
  });
});

describe("balanceAcross", () => {
  it("interleaves the lists by rank", () => {
    const merged = balanceAcross(
      [
        ["n1", "n2", "n3"],
        ["a1", "a2", "a3"],
      ],
      6,
    );
    expect(merged).toEqual(["n1", "a1", "n2", "a2", "n3", "a3"]);
  });

  it("keeps both companies even when one list is much longer", () => {
    const merged = balanceAcross([["n1", "n2", "n3", "n4", "n5", "n6"], ["a1"]], 4);
    expect(merged).toEqual(["n1", "a1", "n2", "n3"]);
  });

  it("covers every non-empty list even when that exceeds the limit", () => {
    expect(balanceAcross([["a"], ["b"], ["c"]], 2)).toEqual(["a", "b", "c"]);
  });

  it("skips empty lists", () => {
    expect(balanceAcross([[], ["a1", "a2"]], 6)).toEqual(["a1", "a2"]);
  });
});
