/**
 * Turn a streamed answer into structure the page can render safely.
 *
 * Gemini writes light Markdown (paragraphs, bullets, **bold**) and the
 * citation tags the system prompt asks for, such as
 * [NVDA FY2026 * Item 1A. Risk Factors]. Rendering that as plain text leaves
 * asterisks on screen and makes every citation a dead string.
 *
 * This is deliberately a tiny parser rather than a Markdown library. It covers
 * exactly what the prompt produces, it runs on every streamed token, and it
 * returns data rather than HTML, so nothing the model writes can ever reach
 * the page as markup.
 */

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "cite"; ticker: string; fiscalYear: string; section: string; raw: string };

export type Block =
  | { kind: "paragraph"; inlines: Inline[] }
  | { kind: "heading"; inlines: Inline[] }
  | { kind: "list"; ordered: boolean; items: Inline[][] };

export interface CitableSource {
  ticker: string;
  fiscalYear: string;
  section: string;
}

// The prompt asks for " * " between the year and the section. Models sometimes
// substitute a middle dot, a bullet or a pipe, so those are accepted too.
const CITE_RE = /\[([A-Z][A-Z.\-]{0,9}) FY(\d{4}) [*\u00b7\u2022|] ([^\]]+?)\]/g;
const BOLD_RE = /\*\*(.+?)\*\*/g;
const BULLET_RE = /^\s*[-*\u2022]\s+(.*)$/;
const ORDERED_RE = /^\s*\d{1,2}[.)]\s+(.*)$/;
const HEADING_RE = /^\s*#{1,6}\s+(.*)$/;

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];

  const pushText = (segment: string) => {
    if (!segment) return;
    let last = 0;
    for (const match of segment.matchAll(BOLD_RE)) {
      const at = match.index ?? 0;
      if (at > last) out.push({ kind: "text", text: segment.slice(last, at) });
      out.push({ kind: "bold", text: match[1] });
      last = at + match[0].length;
    }
    if (last < segment.length) out.push({ kind: "text", text: segment.slice(last) });
  };

  let last = 0;
  for (const match of text.matchAll(CITE_RE)) {
    const at = match.index ?? 0;
    pushText(text.slice(last, at));
    out.push({
      kind: "cite",
      ticker: match[1],
      fiscalYear: match[2],
      section: match[3].trim(),
      raw: match[0],
    });
    last = at + match[0].length;
  }
  pushText(text.slice(last));
  return out;
}

export function parseAnswer(text: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ kind: "paragraph", inlines: parseInline(paragraph.join("\n")) });
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list) {
      blocks.push({ kind: "list", ordered: list.ordered, items: list.items.map(parseInline) });
      list = null;
    }
  };

  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (line.trim() === "") {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = line.match(HEADING_RE);
    const bullet = line.match(BULLET_RE);
    const ordered = bullet ? null : line.match(ORDERED_RE);

    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({ kind: "heading", inlines: parseInline(heading[1]) });
    } else if (bullet || ordered) {
      flushParagraph();
      const isOrdered = Boolean(ordered);
      if (list && list.ordered !== isOrdered) flushList();
      list ??= { ordered: isOrdered, items: [] };
      list.items.push((bullet ?? ordered)![1]);
    } else if (list && /^\s{2,}\S/.test(line)) {
      // An indented continuation line belongs to the previous list item.
      list.items[list.items.length - 1] += ` ${line.trim()}`;
    } else {
      flushList();
      paragraph.push(line);
    }
  }

  flushParagraph();
  flushList();
  return blocks;
}

/**
 * Which listed source does a citation tag point at, or -1 for none.
 *
 * Exact match first. Failing that, the same filing and the same Item number,
 * because a model occasionally shortens "Item 7. Management's Discussion and
 * Analysis..." to "Item 7".
 */
export function matchSource(
  cite: { ticker: string; fiscalYear: string; section: string },
  sources: CitableSource[],
): number {
  const exact = sources.findIndex(
    (s) =>
      s.ticker === cite.ticker &&
      s.fiscalYear === cite.fiscalYear &&
      s.section.toLowerCase() === cite.section.toLowerCase(),
  );
  if (exact >= 0) return exact;

  const item = (section: string) => section.match(/^item\s+(\d{1,2}[a-c]?)/i)?.[1]?.toLowerCase();
  const wanted = item(cite.section);
  if (!wanted) return -1;

  return sources.findIndex(
    (s) =>
      s.ticker === cite.ticker &&
      s.fiscalYear === cite.fiscalYear &&
      item(s.section) === wanted,
  );
}
