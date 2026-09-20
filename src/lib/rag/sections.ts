/**
 * Section detection for SEC 10-K filings.
 *
 * A 10-K has a fixed skeleton of numbered Items (Item 1 Business, Item 1A Risk
 * Factors, Item 7 MD&A, Item 8 Financial Statements, and so on). Detecting
 * those boundaries is what lets a citation say which section an answer came
 * from, and what lets retrieval filter by section later.
 *
 * Two things make it harder than a regex:
 *
 *   1. The Table of Contents lists every Item too, and the body cross-references
 *      them ("see Item 1A"). Both look identical to a real heading.
 *   2. The financial statements stamp "Item 8" on every page, which a naive
 *      boundary detector reads as dozens of tiny sections.
 *
 * The heuristic that survives both: collapse consecutive repeats of the same
 * Item id, then keep the candidate that owns the LARGEST span of text. A TOC
 * entry owns one line, the real section owns thousands of characters.
 *
 * Ported from the Python implementation in FinSight v1, including its fallback:
 * if fewer than three credible sections are found the whole document is
 * returned as one section, so a filing is never silently dropped.
 */

/** Matches an Item heading anchored to the start of a line. */
const ITEM_RE = /^\s*item\s+(\d{1,2}[a-c]?)\b\s*[.):\-\u2013\u2014]?/gim;

/** Canonical, human readable names for the standard 10-K items. */
export const ITEM_NAMES: Record<string, string> = {
  "1": "Item 1. Business",
  "1A": "Item 1A. Risk Factors",
  "1B": "Item 1B. Unresolved Staff Comments",
  "1C": "Item 1C. Cybersecurity",
  "2": "Item 2. Properties",
  "3": "Item 3. Legal Proceedings",
  "4": "Item 4. Mine Safety Disclosures",
  "5": "Item 5. Market for Registrant's Common Equity",
  "6": "Item 6. Selected Financial Data",
  "7": "Item 7. Management's Discussion and Analysis (MD&A)",
  "7A": "Item 7A. Quantitative and Qualitative Disclosures About Market Risk",
  "8": "Item 8. Financial Statements and Supplementary Data",
  "9": "Item 9. Changes in and Disagreements with Accountants",
  "9A": "Item 9A. Controls and Procedures",
  "9B": "Item 9B. Other Information",
  "10": "Item 10. Directors, Executive Officers and Corporate Governance",
  "11": "Item 11. Executive Compensation",
  "12": "Item 12. Security Ownership of Certain Beneficial Owners",
  "13": "Item 13. Certain Relationships and Related Transactions",
  "14": "Item 14. Principal Accountant Fees and Services",
  "15": "Item 15. Exhibits and Financial Statement Schedules",
};

/** Below this, a detected "section" is noise: a TOC line or a cross-reference. */
export const MIN_SECTION_CHARS = 400;

/** The name used when no credible Item skeleton is found. */
export const FULL_FILING = "Full Filing";

export interface Section {
  name: string;
  body: string;
}

/**
 * Split a filing into `[{ name, body }]`, one entry per detected Item.
 *
 * Always returns at least one section, so callers never have to handle an empty
 * result.
 */
export function splitIntoSections(text: string): Section[] {
  ITEM_RE.lastIndex = 0;
  const matches = [...text.matchAll(ITEM_RE)];
  if (matches.length === 0) {
    return [{ name: FULL_FILING, body: text }];
  }

  // Collapse runs of the same item id. Repeated page headers inside a section
  // (for example "Item 8" on every page of the financials) would otherwise
  // shatter it, so a section runs from its first heading to the next DIFFERENT
  // item.
  const collapsed: Array<{ itemId: string; offset: number }> = [];
  for (const match of matches) {
    const itemId = match[1].toUpperCase();
    if (collapsed.length > 0 && collapsed[collapsed.length - 1].itemId === itemId) {
      continue;
    }
    collapsed.push({ itemId, offset: match.index });
  }

  // Each heading owns the text up to the next heading. Keep the largest span
  // per item id, which discards TOC entries and inline references.
  const bounds = [...collapsed.map((c) => c.offset), text.length];
  const best = new Map<string, { length: number; body: string; offset: number }>();
  collapsed.forEach(({ itemId, offset }, i) => {
    const body = text.slice(offset, bounds[i + 1]).trim();
    const current = best.get(itemId);
    if (!current || body.length > current.length) {
      best.set(itemId, { length: body.length, body, offset });
    }
  });

  const sections = [...best.entries()]
    .filter(([, v]) => v.length >= MIN_SECTION_CHARS)
    .sort((a, b) => a[1].offset - b[1].offset) // document order
    .map(([itemId, v]) => ({
      name: ITEM_NAMES[itemId] ?? `Item ${itemId}`,
      body: v.body,
    }));

  if (sections.length < 3) {
    return [{ name: FULL_FILING, body: text }];
  }
  return sections;
}
