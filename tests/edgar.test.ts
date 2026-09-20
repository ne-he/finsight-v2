/**
 * Tests for the HTML to text converter.
 *
 * The property that matters most is paragraph preservation. If block tags do
 * not become blank lines, the whole filing arrives as a single line and the
 * paragraph-aware chunker silently degrades into a blind character split,
 * which is exactly the kind of failure that produces worse answers without
 * producing an error.
 */
import { describe, expect, it } from "vitest";

import { htmlToText } from "@/lib/rag/edgar";

describe("htmlToText", () => {
  it("strips tags and keeps the words", () => {
    expect(htmlToText("<p>Hello <b>world</b></p>")).toBe("Hello world");
  });

  it("turns block elements into paragraph breaks", () => {
    const text = htmlToText("<p>First paragraph.</p><p>Second paragraph.</p>");

    expect(text.split(/\n\s*\n/)).toEqual(["First paragraph.", "Second paragraph."]);
  });

  it("drops script and style content entirely", () => {
    const text = htmlToText(
      "<div>Keep</div><script>var secret = 1;</script><style>.a{color:red}</style>",
    );

    expect(text).toContain("Keep");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("color:red");
  });

  it("decodes the entities that appear in filings", () => {
    expect(htmlToText("<p>R&amp;D rose 5&#37;</p>")).toContain("R&D");
    expect(htmlToText("<p>&#8220;risk&#8221;</p>")).toContain('"risk"');
  });

  it("collapses runs of blank lines and non-breaking spaces", () => {
    const text = htmlToText("<p>A</p><p></p><p></p><p>B&nbsp;&nbsp;C</p>");

    expect(text).not.toMatch(/\n{3,}/);
    expect(text).toContain("B C");
  });

  it("keeps an Item heading at the start of its own line", () => {
    // Section detection anchors on a line start, so a heading swallowed into
    // the previous line would make the whole filing one unsectioned block.
    const text = htmlToText("<div>Item 1A.</div><div>Risk Factors text.</div>");

    expect(text.split("\n\n")[0]).toBe("Item 1A.");
  });

  it("does not leave raw angle brackets behind", () => {
    expect(htmlToText('<td nowrap="nowrap">12,345</td>')).not.toContain("<");
  });
});
