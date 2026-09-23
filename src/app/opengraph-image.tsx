/**
 * The card that appears when the link is pasted into a chat, a slide or a post.
 *
 * Drawn here rather than shipped as a static file so the numbers on it come
 * from the database at request time: a preview that claims a corpus size the
 * app no longer has is worse than no preview.
 */
import { ImageResponse } from "next/og";

import { loadCorpus } from "@/lib/corpus";
import { CONFIDENCE_THRESHOLD } from "@/config";

// Rendered per request rather than at build time, so ingesting a company
// updates the card without a redeploy. Only crawlers fetch this route.
export const dynamic = "force-dynamic";

export const alt = "FinSight: answers from SEC 10-K filings, with a citation on every claim.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const PAPER = "#f3efe6";
const INK = "#1b1a17";
const MUTED = "#6b665c";
const MARKER = "#e4f24a";

export default async function Image() {
  const corpus = await loadCorpus().catch(() => []);
  const passages = corpus.reduce((total, entry) => total + entry.chunkCount, 0);

  const facts = [
    ["Filings", String(corpus.length)],
    ["Passages", String(passages)],
    ["Minimum match", CONFIDENCE_THRESHOLD.toFixed(2)],
  ];

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: PAPER,
          color: INK,
          padding: "64px 72px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <div style={{ fontSize: 34, letterSpacing: "-0.02em" }}>FinSight</div>
          <div style={{ fontSize: 18, letterSpacing: "0.18em", color: MUTED }}>
            10-K EVIDENCE DESK
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", fontSize: 76, lineHeight: 1.05 }}>
            Answers from the filing,
          </div>
          <div style={{ display: "flex", alignItems: "flex-end", marginTop: 4 }}>
            <div
              style={{
                display: "flex",
                fontSize: 76,
                lineHeight: 1.05,
                background: MARKER,
                padding: "0 10px",
              }}
            >
              not from memory.
            </div>
          </div>
          <div
            style={{
              display: "flex",
              marginTop: 28,
              fontSize: 26,
              color: MUTED,
              maxWidth: 880,
            }}
          >
            Every claim carries a citation, and clicking it opens the exact passage.
          </div>
        </div>

        <div style={{ display: "flex", gap: 56, borderTop: `1px solid ${INK}`, paddingTop: 24 }}>
          {facts.map(([label, value]) => (
            <div key={label} style={{ display: "flex", flexDirection: "column" }}>
              <div style={{ fontSize: 16, letterSpacing: "0.16em", color: MUTED }}>
                {label.toUpperCase()}
              </div>
              <div style={{ fontSize: 40, marginTop: 6 }}>{value}</div>
            </div>
          ))}
        </div>
      </div>
    ),
    size,
  );
}
