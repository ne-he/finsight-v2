/**
 * Give every company in a comparison its own share of the context.
 *
 * One ranked search across two filings is dominated by whichever filing
 * happens to phrase the topic closer to the question. Measured on the golden
 * set, "compare the revenue of NVIDIA and Apple" came back with all six chunks
 * from NVIDIA, so the answer could only ever describe one side. Searching each
 * company separately and interleaving the results guarantees both appear.
 */

/** How many results to request from each list so the merge can fill `limit`. */
export function perListQuota(lists: number, limit: number): number {
  return Math.max(1, Math.ceil(limit / Math.max(1, lists)));
}

/**
 * Round-robin merge: the best of each list first, then the second best of
 * each, and so on. Capped at `limit`, but never below one item per non-empty
 * list, so a three-way comparison with a small limit still covers everyone.
 */
export function balanceAcross<T>(lists: T[][], limit: number): T[] {
  const merged: T[] = [];
  const longest = lists.reduce((max, list) => Math.max(max, list.length), 0);

  for (let rank = 0; rank < longest; rank++) {
    for (const list of lists) {
      if (rank < list.length) merged.push(list[rank]);
    }
  }

  const nonEmpty = lists.filter((list) => list.length > 0).length;
  return merged.slice(0, Math.max(limit, nonEmpty));
}
