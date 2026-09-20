/**
 * Prompt assembly: the analyst persona, and the wrapper that pins every
 * company-specific claim to a retrieved excerpt.
 *
 * The rules below are the product. A finance assistant that rounds a number,
 * infers a trend, or answers without a citation is worse than no assistant,
 * because it is wrong in a way that looks right.
 */
import type { RetrievedChunk } from "./retrieve";

export const SYSTEM_PROMPT = `You are "FinSight", a financial-analysis assistant that answers questions about public companies strictly from their SEC 10-K filings.

PRINCIPLES
- Be factual, precise, and neutral. You are an analyst, not a salesperson.
- Every company-specific fact (numbers, dates, segments, risks, named items) MUST come from the retrieved CONTEXT below. Quote figures exactly as written. Never round, infer, extrapolate, or invent a number.
- Cite the source of each fact inline using the citation tag shown on each excerpt, for example [NVDA FY2024 * Item 1A. Risk Factors]. Put the citation immediately after the claim it supports.
- If the CONTEXT does not contain the answer, or you see the [WEAK RETRIEVAL] flag, say plainly that it was not found in the available filings. Do not guess.
- For comparisons across companies, only compare figures actually present in the context. If one side is missing, say so instead of filling the gap.
- You may explain general finance terms (gross margin, deferred revenue) from your own knowledge, but keep that clearly separate from company-specific facts, which must be cited.
- Answer in the language the question was asked in. Citations keep their original wording either way, because they point at English source documents.
- This is informational only, not investment advice.

STYLE
- Lead with the direct answer, then brief supporting detail. Short paragraphs or bullets. Analysts value signal over length.`;

const WEAK_FLAG =
  "[WEAK RETRIEVAL] No sufficiently relevant filing excerpts were found.\n\n";

/** The tag the model is told to cite, and the tag shown in the UI. */
export function citationOf(chunk: {
  ticker: string;
  fiscalYear: string;
  section: string;
}): string {
  return `[${chunk.ticker} FY${chunk.fiscalYear} * ${chunk.section}]`;
}

export function buildContextBlock(chunks: RetrievedChunk[]): string {
  if (chunks.length === 0) {
    return "[WEAK RETRIEVAL] No relevant filing excerpts found.";
  }
  return chunks
    .map((chunk, i) => {
      const source = chunk.sourceUrl ? ` (source: ${chunk.sourceUrl})` : "";
      const company = chunk.company || chunk.ticker;
      return `### Excerpt ${i + 1} ${citationOf(chunk)} (company: ${company})${source}\n${chunk.content}`;
    })
    .join("\n\n");
}

export function buildUserTurn(
  query: string,
  chunks: RetrievedChunk[],
  gated: boolean,
): string {
  const flag = gated ? WEAK_FLAG : "";
  return [
    `${flag}CONTEXT (retrieved 10-K excerpts):`,
    buildContextBlock(chunks),
    "",
    "---",
    "QUESTION:",
    query,
    "",
    "Answer using ONLY the context for company-specific facts, with inline citations.",
  ].join("\n");
}

/** Shown above quoted text so nobody mistakes it for a written answer. */
export const FALLBACK_NOTICE =
  "The language model is unavailable right now, so the passages below are quoted directly from the filings rather than summarised. Citations are unaffected.";

/**
 * The degraded answer.
 *
 * Retrieval and generation fail independently, and only generation needs a
 * third party. When Gemini refuses, retrieval has already done the expensive
 * part: it found the right sections of the right filings. Showing nothing
 * throws that away. Quoting the passages is visibly worse than a written
 * answer, says so, and keeps every citation intact.
 */
export function extractiveAnswer(chunks: RetrievedChunk[], gated: boolean): string {
  if (gated || chunks.length === 0) {
    return "I could not find an answer to that in the available filings.";
  }
  const passages = chunks.slice(0, 3).map((chunk) => {
    const excerpt = chunk.content.trim().slice(0, 700);
    const trimmed = excerpt.length < chunk.content.trim().length ? `${excerpt}...` : excerpt;
    return `${citationOf(chunk)}\n${trimmed}`;
  });
  return [FALLBACK_NOTICE, "", ...passages].join("\n\n");
}
