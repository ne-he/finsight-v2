/**
 * SEC EDGAR: resolve a ticker to its most recent 10-K and return clean text.
 *
 * EDGAR requires a descriptive User-Agent with contact details on every
 * request. That is a published condition of use, not a nicety, and requests
 * without it are refused.
 *
 * The HTML stripper is hand written rather than a DOM library. A 10-K primary
 * document is several megabytes of deeply nested layout markup, and parsing it
 * into a tree costs far more memory than walking it once with regular
 * expressions. Memory is the scarce resource on serverless, so this trades a
 * little fidelity for a lot of headroom.
 */

const TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";
const SUBMISSIONS_URL = "https://data.sec.gov/submissions/CIK{cik10}.json";
const DOC_URL = "https://www.sec.gov/Archives/edgar/data/{cik}/{acc}/{doc}";

/** Refuse anything implausibly large before reading it into memory. */
export const MAX_DOCUMENT_BYTES = 40 * 1024 * 1024;

export interface FilingRecord {
  ticker: string;
  company: string;
  fiscalYear: string;
  sourceUrl: string;
  accession: string;
  filingDate: string;
  text: string;
}

export class EdgarError extends Error {}

async function edgarFetch(url: string, userAgent: string): Promise<Response> {
  const response = await fetch(url, {
    headers: { "User-Agent": userAgent, "Accept-Encoding": "gzip, deflate" },
  });
  if (!response.ok) {
    throw new EdgarError(`SEC request failed (${response.status}) for ${url}`);
  }
  return response;
}

interface TickerRow {
  cik_str: number;
  ticker: string;
  title: string;
}

async function resolveTicker(
  ticker: string,
  userAgent: string,
): Promise<{ cik: number; company: string }> {
  const response = await edgarFetch(TICKERS_URL, userAgent);
  const rows = (await response.json()) as Record<string, TickerRow>;
  const wanted = ticker.toUpperCase();

  for (const row of Object.values(rows)) {
    if (row.ticker?.toUpperCase() === wanted) {
      return { cik: Number(row.cik_str), company: row.title };
    }
  }
  throw new EdgarError(`Ticker ${wanted} is not in the SEC company list.`);
}

async function latestTenK(cik: number, userAgent: string) {
  const url = SUBMISSIONS_URL.replace("{cik10}", String(cik).padStart(10, "0"));
  const response = await edgarFetch(url, userAgent);
  const data = (await response.json()) as {
    filings: {
      recent: {
        form: string[];
        accessionNumber: string[];
        primaryDocument: string[];
        reportDate: string[];
        filingDate: string[];
      };
    };
  };

  const recent = data.filings.recent;
  const index = recent.form.findIndex((form) => form === "10-K");
  if (index === -1) throw new EdgarError("No 10-K filing found for this company.");

  return {
    accession: recent.accessionNumber[index],
    primaryDoc: recent.primaryDocument[index],
    reportDate: recent.reportDate[index],
    filingDate: recent.filingDate[index],
  };
}

/** Download the most recent 10-K for a ticker and return it as clean text. */
export async function fetchLatestTenK(
  ticker: string,
  userAgent: string,
): Promise<FilingRecord> {
  const { cik, company } = await resolveTicker(ticker, userAgent);
  const filing = await latestTenK(cik, userAgent);

  const sourceUrl = DOC_URL.replace("{cik}", String(cik))
    .replace("{acc}", filing.accession.replaceAll("-", ""))
    .replace("{doc}", filing.primaryDoc);

  const response = await edgarFetch(sourceUrl, userAgent);
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_DOCUMENT_BYTES) {
    throw new EdgarError(
      `Filing document is ${Math.round(declaredLength / 1024 / 1024)} MB, which exceeds the ingest limit.`,
    );
  }

  const text = htmlToText(await response.text());
  if (text.length < 5000) {
    throw new EdgarError("Downloaded filing produced almost no text, refusing to ingest.");
  }

  return {
    ticker: ticker.toUpperCase(),
    company,
    fiscalYear: filing.reportDate.slice(0, 4),
    sourceUrl,
    accession: filing.accession,
    filingDate: filing.filingDate,
    text,
  };
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#8217": "'",
  "#8216": "'",
  "#8220": '"',
  "#8221": '"',
  "#160": " ",
};

/**
 * Strip HTML to readable text.
 *
 * Block-level tags become newlines so the paragraph structure the chunker
 * depends on survives. Without that, the whole filing arrives as one line and
 * paragraph-aware chunking degrades into a blind character split.
 */
export function htmlToText(html: string): string {
  let text = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|tr|table|section|article|h[1-6]|li|ul|ol)>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/td>/gi, " ")
    .replace(/<[^>]+>/g, " ");

  text = text.replace(/&(#?\w+);/g, (match, entity: string) => {
    const known = ENTITIES[entity.toLowerCase()];
    if (known !== undefined) return known;
    if (/^#\d+$/.test(entity)) {
      return String.fromCodePoint(Number(entity.slice(1)));
    }
    return match;
  });

  return text
    .replace(/ /g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
