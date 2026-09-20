/**
 * Query understanding: which company and which fiscal year is being asked about.
 *
 * "What are NVIDIA's risk factors?" should search NVDA's filing only, so a
 * paragraph about Apple's risks cannot win a slot in the top k. A question that
 * names two companies keeps both, otherwise a comparison can only ever retrieve
 * half its answer.
 *
 * v1 built the alias table by scanning every chunk in memory. v2 cannot do that
 * on serverless, and does not need to: the aliases only depend on the list of
 * ingested filings, which is a handful of rows. The caller passes that list in.
 */

/** Corporate suffixes and glue words that must not become company aliases. */
const STOPWORDS = new Set([
  "inc",
  "corp",
  "corporation",
  "co",
  "company",
  "ltd",
  "limited",
  "plc",
  "holdings",
  "group",
  "the",
  "and",
]);

const YEAR_RE = /\b(?:19|20)\d{2}\b/g;

export interface FilingRef {
  ticker: string;
  company: string;
  fiscalYear: string;
}

export interface QueryFilters {
  tickers: string[];
  years: string[];
}

/**
 * Build `token -> ticker` from the ingested filings.
 *
 * Both the ticker itself ("nvda") and each meaningful word of the company name
 * ("nvidia") map to the ticker, so either phrasing is detected.
 */
export function buildAliasIndex(filings: FilingRef[]): Map<string, string> {
  const alias = new Map<string, string>();
  for (const filing of filings) {
    if (!filing.ticker) continue;
    alias.set(filing.ticker.toLowerCase(), filing.ticker);
    for (const token of (filing.company || "").toLowerCase().match(/[a-z0-9]+/g) ?? []) {
      if (token.length > 1 && !STOPWORDS.has(token) && !alias.has(token)) {
        alias.set(token, filing.ticker);
      }
    }
  }
  return alias;
}

/**
 * Detect the companies and fiscal years a query refers to.
 *
 * Years are intersected with the years actually ingested, so "revenue in 2019"
 * against a corpus of 2025 filings does not produce a filter that matches
 * nothing. An over-constrained filter is worse than no filter: it starves
 * retrieval and the confidence gate then refuses a question the corpus could
 * have answered.
 */
export function detectFilters(query: string, filings: FilingRef[]): QueryFilters {
  const alias = buildAliasIndex(filings);
  const knownYears = new Set(filings.map((f) => String(f.fiscalYear)));

  const tokens = new Set(query.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  const tickers = new Set<string>();
  for (const token of tokens) {
    const ticker = alias.get(token);
    if (ticker) tickers.add(ticker);
  }

  const years = new Set<string>();
  for (const match of query.matchAll(YEAR_RE)) {
    if (knownYears.has(match[0])) years.add(match[0]);
  }

  return { tickers: [...tickers].sort(), years: [...years].sort() };
}

/**
 * Would this filter select nothing at all?
 *
 * When true the caller should search unfiltered and let the confidence gate
 * decide, which is how v1 behaved.
 */
export function isOverConstrained(filters: QueryFilters, filings: FilingRef[]): boolean {
  if (filters.tickers.length === 0 && filters.years.length === 0) return false;
  return !filings.some(
    (f) =>
      (filters.tickers.length === 0 || filters.tickers.includes(f.ticker)) &&
      (filters.years.length === 0 || filters.years.includes(String(f.fiscalYear))),
  );
}
