/**
 * What FinSight can currently answer about, for the pages that show it.
 *
 * Read with the service role key on the server only. The filing list is not
 * secret, but reading it this way keeps the public pages independent of how
 * Row Level Security is configured for signed-out visitors.
 */
import { displayName } from "@/lib/company";
import { bestSentence, cleanExcerpt } from "@/lib/highlight";
import { supabaseAdmin } from "@/lib/supabase/server";

export interface CorpusEntry {
  ticker: string;
  company: string;
  name: string;
  fiscalYear: string;
  chunkCount: number;
  sourceUrl: string;
}

export async function loadCorpus(): Promise<CorpusEntry[]> {
  const { data, error } = await supabaseAdmin()
    .from("fs_filings")
    .select("ticker, company, fiscal_year, chunk_count, source_url")
    .eq("is_ready", true)
    .order("ticker");

  if (error) {
    console.error("[corpus] could not load filings", error);
    return [];
  }
  return (data ?? []).map((row) => ({
    ticker: row.ticker as string,
    company: row.company as string,
    name: displayName(row.company as string),
    fiscalYear: String(row.fiscal_year),
    chunkCount: Number(row.chunk_count ?? 0),
    sourceUrl: row.source_url as string,
  }));
}

/**
 * Starter questions built from what is actually ingested, so the first thing a
 * new user tries cannot be a question the corpus has no chance of answering.
 * Each one mirrors a question in the golden set that is measured to retrieve.
 */
export function suggestionsFor(corpus: CorpusEntry[]): string[] {
  if (corpus.length === 0) return [];
  const first = corpus[0].name;
  const second = corpus[1]?.name ?? first;
  const last = corpus[corpus.length - 1].name;

  return [
    `What are ${last}'s main risk factors?`,
    `How does ${second} describe competition in its markets?`,
    corpus.length > 1
      ? `Compare the revenue drivers of ${last} and ${first}.`
      : `What does ${first} say about its business segments?`,
    `How does ${first} manage cybersecurity risk?`,
  ];
}

export interface Specimen {
  ticker: string;
  name: string;
  fiscalYear: string;
  section: string;
  claim: string;
  passage: string;
  highlight: { start: number; end: number } | null;
}

/** The claim the landing page example demonstrates, checked against real text. */
const SPECIMEN_CLAIM = "A large share of revenue comes from a limited number of customers.";

/**
 * A real passage for the landing page, so the example shows the corpus as it
 * is rather than a mock. Picks the risk-factor chunk that best supports the
 * example claim, and returns null when none does, in which case the page
 * simply leaves the example out.
 */
export async function loadSpecimen(corpus: CorpusEntry[]): Promise<Specimen | null> {
  const filing = corpus.find((c) => c.ticker === "NVDA") ?? corpus[0];
  if (!filing) return null;

  const query = () =>
    supabaseAdmin()
      .from("fs_chunks")
      .select("content, section")
      .eq("ticker", filing.ticker)
      .ilike("section", "Item 1A%");

  // Candidates that mention customers first, because that is what the example
  // claim is about. If the filing never uses the word, fall back to the start
  // of the risk factors so the page still shows something real.
  let { data } = await query().ilike("content", "%customer%").limit(12);
  if (!data || data.length === 0) ({ data } = await query().order("chunk_id").limit(8));
  if (!data || data.length === 0) return null;

  let best: Specimen | null = null;
  let bestShared = 0;
  for (const row of data) {
    const passage = cleanExcerpt(row.content as string, 520);
    const match = bestSentence(passage, SPECIMEN_CLAIM);
    const shared = match?.shared ?? 0;
    if (best && shared <= bestShared) continue;
    bestShared = shared;
    best = {
      ticker: filing.ticker,
      name: filing.name,
      fiscalYear: filing.fiscalYear,
      section: row.section as string,
      claim: SPECIMEN_CLAIM,
      passage,
      highlight: match ? { start: match.start, end: match.end } : null,
    };
  }
  return best;
}
