/**
 * Find the sentence in a passage that a claim most likely came from.
 *
 * When a reader clicks a citation, the evidence panel highlights one sentence
 * of the retrieved passage. The model does not report which sentence it used,
 * so this is an estimate: the sentence sharing the most meaningful words with
 * the claim. It is shown as "closest match", never as proof, and it returns
 * nothing rather than a weak guess when the overlap is thin, which is what
 * happens when the answer is in Indonesian and the filing is in English.
 */

export interface Span {
  start: number;
  end: number;
}

const STOPWORDS = new Set(
  (
    "the and for are was were with that this from its their our has have had not but " +
    "can may will would could should such than then them they these those which while " +
    "into also any all each other more most some only over under about between within " +
    "company companies including includes include based being been does did per new use " +
    "used using its it's what how why who when where"
  ).split(" "),
);

function normalise(word: string): string {
  // A light stem, enough to match "customers" with "customer" and "risks"
  // with "risk" without a dictionary.
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && word.endsWith("es")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s")) return word.slice(0, -1);
  return word;
}

export function terms(text: string): Set<string> {
  const words = text.toLowerCase().match(/[a-z0-9][a-z0-9$%.\-]*[a-z0-9%]|[a-z0-9]/g) ?? [];
  const out = new Set<string>();
  for (const word of words) {
    if (word.length < 3 || STOPWORDS.has(word)) continue;
    out.add(normalise(word));
  }
  return out;
}

/** Sentence boundaries as offsets into the original text. */
export function sentenceSpans(text: string): Span[] {
  const spans: Span[] = [];
  // A sentence ends at terminal punctuation followed by anything that does not
  // continue it, and every line break is a boundary too: filings put bullets
  // and table rows on their own lines, and those should highlight one at a time.
  const boundary = /(?<=[.!?;:])\s+(?=[^\sa-z,;)])|\s*\n\s*/g;
  let start = 0;
  for (const match of text.matchAll(boundary)) {
    const end = match.index ?? 0;
    if (end > start) spans.push({ start, end });
    start = end + match[0].length;
  }
  if (start < text.length) spans.push({ start, end: text.length });

  // Trim surrounding whitespace so the highlight hugs the words.
  return spans
    .map(({ start: s, end: e }) => {
      while (s < e && /\s/.test(text[s])) s++;
      while (e > s && /\s/.test(text[e - 1])) e--;
      return { start: s, end: e };
    })
    .filter((span) => span.end > span.start);
}

export interface SentenceMatch extends Span {
  shared: number;
}

/**
 * The best-matching sentence, or null when nothing overlaps enough to be
 * worth pointing at. Two shared words are required, or one when the claim
 * itself is that short.
 */
export function bestSentence(passage: string, claim: string): SentenceMatch | null {
  const wanted = terms(claim);
  if (wanted.size === 0) return null;
  const minimum = wanted.size <= 2 ? 1 : 2;

  let best: SentenceMatch | null = null;
  let bestDensity = 0;

  for (const span of sentenceSpans(passage)) {
    const have = terms(passage.slice(span.start, span.end));
    let shared = 0;
    for (const term of wanted) if (have.has(term)) shared++;
    if (shared < minimum) continue;

    // Ties go to the tighter sentence, so a long list does not win just by
    // containing every word.
    const density = shared / Math.sqrt(have.size + 1);
    if (!best || shared > best.shared || (shared === best.shared && density > bestDensity)) {
      best = { ...span, shared };
      bestDensity = density;
    }
  }
  return best;
}

/**
 * Trim a chunk to whole sentences for display. Chunks begin with an overlap
 * carried over from the previous chunk, which usually starts mid-sentence.
 */
export function cleanExcerpt(text: string, maxChars: number): string {
  let body = text.trim();
  if (/^[a-z,;)]/.test(body)) {
    const firstEnd = body.search(/[.!?]\s+[^\sa-z,;)]/);
    if (firstEnd > 0 && firstEnd < body.length / 2) body = body.slice(firstEnd + 1).trim();
  }
  if (body.length <= maxChars) return body;

  const cut = body.slice(0, maxChars);
  const lastEnd = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf(".\n"));
  return lastEnd > maxChars / 3 ? cut.slice(0, lastEnd + 1) : `${cut.trimEnd()}...`;
}
