"use client";

import { CONFIDENCE_THRESHOLD } from "@/config";

/**
 * How close the best retrieved passage was, against the line the answer had
 * to clear. Drawn on a 0.40 to 0.90 scale, because cosine similarity on this
 * corpus never uses the ends of its theoretical range and a full 0 to 1 bar
 * would compress every real difference into a few pixels.
 */
const FLOOR = 0.4;
const CEILING = 0.9;

const position = (value: number) =>
  Math.min(100, Math.max(0, ((value - FLOOR) / (CEILING - FLOOR)) * 100));

export function MatchMeter({ score }: { score: number }) {
  const below = score < CONFIDENCE_THRESHOLD;

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="label">Best match</span>
        <span className={`font-mono text-sm ${below ? "text-signal" : ""}`}>
          {score.toFixed(3)}
        </span>
      </div>

      <div className="relative mt-2 h-2 bg-rule-soft">
        <div
          className={`h-full ${below ? "bg-signal" : "bg-foreground"}`}
          style={{ width: `${position(score)}%` }}
        />
        <div
          className="absolute -top-1 h-4 w-px bg-signal"
          style={{ left: `${position(CONFIDENCE_THRESHOLD)}%` }}
          aria-hidden
        />
      </div>

      <div className="mt-1.5 flex justify-between font-mono text-[10px] text-muted">
        <span>{FLOOR.toFixed(2)}</span>
        <span className="text-signal">gate {CONFIDENCE_THRESHOLD.toFixed(2)}</span>
        <span>{CEILING.toFixed(2)}</span>
      </div>

      <p className="mt-3 text-xs leading-relaxed text-muted">
        {below
          ? `Below the gate, so the answer is limited to saying what the filings do not cover.`
          : `Above the gate, so the filings were close enough to answer from.`}
      </p>
    </div>
  );
}
