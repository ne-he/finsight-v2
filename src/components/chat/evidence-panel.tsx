"use client";

import { useEffect, useMemo, useRef } from "react";

import { bestSentence } from "@/lib/highlight";

import { MatchMeter } from "./match-meter";
import type { ChatMessage, EvidenceFocus, Source } from "./types";

interface Props {
  message: ChatMessage | null;
  /** The focused answer's sources, ordered the way the answer cites them. */
  sources: Source[];
  focus: EvidenceFocus | null;
  onSelect: (sourceIndex: number) => void;
  onClose?: () => void;
}

/**
 * The right-hand desk: the passages an answer was built from.
 *
 * Nothing here is generated. Every word is text pulled out of the filing and
 * handed to the model, which is the point: a reader can check a claim against
 * the sentence it came from without opening a 300 page document.
 */
export function EvidencePanel({ message, sources, focus, onSelect, onClose }: Props) {
  const index = Math.min(focus?.sourceIndex ?? 0, Math.max(sources.length - 1, 0));
  const source = sources[index];
  const claim = focus?.claim ?? null;
  const passages = useMemo(() => source?.passages ?? [], [source]);

  // Highlight the sentence closest to the clicked claim, in whichever of this
  // section's passages matches it best.
  const highlight = useMemo(() => {
    if (!claim) return null;
    type Hit = { passage: number; start: number; end: number; shared: number };
    return passages.reduce<Hit | null>((best, passage, i) => {
      const match = bestSentence(passage, claim);
      if (match && (!best || match.shared > best.shared)) {
        return { passage: i, start: match.start, end: match.end, shared: match.shared };
      }
      return best;
    }, null);
  }, [claim, passages]);

  // Bring the highlighted sentence into view. A passage can be longer than
  // the panel, and a highlight nobody can see is the same as no highlight.
  const markRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    markRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [index, claim]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-3 border-b border-rule-soft px-5 py-3">
        <span className="label">Evidence</span>
        <span className="font-mono text-[11px] text-muted">
          {sources.length > 0 ? `${sources.length} sections retrieved` : "nothing yet"}
        </span>
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            className="ml-auto text-sm text-muted transition-colors hover:text-foreground"
          >
            Close
          </button>
        ) : null}
      </header>

      {!message || sources.length === 0 ? (
        <div className="px-5 py-8 text-sm leading-relaxed text-muted">
          <p>
            Ask a question and the passages behind the answer appear here. Every
            claim carries a numbered citation, and clicking one opens its
            passage with the closest sentence highlighted.
          </p>
          <p className="mt-4">
            FinSight only ever quotes from these passages. If they do not cover
            the question, it refuses instead of filling the gap from memory.
          </p>
        </div>
      ) : (
        <div className="pane min-h-0 flex-1 overflow-y-auto">
          <div className="flex flex-wrap gap-1.5 border-b border-rule-soft px-5 py-3">
            {sources.map((s, i) => (
              <button
                key={`${s.ticker}-${s.section}-${i}`}
                type="button"
                onClick={() => onSelect(i)}
                className={`flex items-center gap-1.5 border px-2 py-1 font-mono text-[11px] transition-colors ${
                  i === index
                    ? "border-border bg-foreground text-background"
                    : "border-rule-soft text-muted hover:border-border hover:text-foreground"
                }`}
              >
                <span>{i + 1}</span>
                <span>{s.ticker}</span>
                <span className={i === index ? "opacity-70" : ""}>
                  {s.section.split(".")[0]}
                </span>
              </button>
            ))}
          </div>

          {source ? (
            <div key={`${index}-${claim ?? ""}`} className="fade-in px-5 py-5">
              <p className="label">
                Source {index + 1} &middot; {source.ticker} FY{source.fiscalYear}
              </p>
              <h3 className="mt-1.5 font-serif text-[22px] leading-tight">{source.section}</h3>
              <p className="mt-1 font-mono text-[11px] text-muted">
                passage match {source.score.toFixed(3)}
              </p>

              {passages.length > 0 ? (
                <div className="mt-4 space-y-3">
                  {passages.map((passage, i) => (
                    <div key={i}>
                      {passages.length > 1 ? (
                        <p className="label mb-1">
                          Passage {i + 1} of {passages.length}
                        </p>
                      ) : null}
                      <blockquote className="border-l-2 border-rule-soft pl-4 text-[13.5px] leading-[1.75] whitespace-pre-line">
                        {highlight && highlight.passage === i ? (
                          <>
                            {passage.slice(0, highlight.start)}
                            <mark className="marker" ref={markRef}>
                              {passage.slice(highlight.start, highlight.end)}
                            </mark>
                            {passage.slice(highlight.end)}
                          </>
                        ) : (
                          passage
                        )}
                      </blockquote>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mt-4 text-sm text-muted">
                  This answer was saved before passages were stored, so only the
                  citation remains. Open the filing to read the section.
                </p>
              )}

              <p className="mt-4 text-xs leading-relaxed text-muted">
                {claim && highlight
                  ? "Highlighted: the sentence closest in wording to the claim you clicked. The model does not report which sentence it used, so this is the best estimate."
                  : claim
                    ? "No sentence here closely matches the wording of that claim, so the whole passage is shown."
                    : "Click a numbered citation in the answer to highlight the sentence behind it."}
              </p>

              {source.sourceUrl ? (
                <a
                  href={source.sourceUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="mt-4 inline-flex items-center gap-1.5 border-b border-border pb-0.5 text-sm transition-opacity hover:opacity-70"
                >
                  Open the full filing on SEC.gov
                  <span aria-hidden>&#8599;</span>
                </a>
              ) : null}
            </div>
          ) : null}

          {typeof message.topCosine === "number" ? (
            <div className="border-t border-rule-soft px-5 py-5">
              <MatchMeter score={message.topCosine} />
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
