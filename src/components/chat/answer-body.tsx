"use client";

import { useMemo, type ReactNode } from "react";

import { matchSource, parseAnswer, type Inline } from "@/lib/answer-format";

import type { Source } from "./types";

interface Props {
  text: string;
  sources: Source[];
  streaming: boolean;
  activeSource: number | null;
  onCite: (sourceIndex: number, claim: string) => void;
}

/**
 * The answer, with every citation tag turned into a numbered button.
 *
 * The claim a citation supports is taken to be the text between it and the
 * previous citation in the same paragraph or bullet. That is what gets sent to
 * the evidence panel so it can highlight the closest sentence in the passage.
 */
export function AnswerBody({ text, sources, streaming, activeSource, onCite }: Props) {
  const blocks = useMemo(() => parseAnswer(text), [text]);

  const render = (inlines: Inline[], keyBase: string, withCaret: boolean): ReactNode[] => {
    const nodes: ReactNode[] = [];
    let claim = "";

    inlines.forEach((inline, i) => {
      const key = `${keyBase}-${i}`;
      if (inline.kind === "text") {
        claim += inline.text;
        nodes.push(<span key={key}>{inline.text}</span>);
        return;
      }
      if (inline.kind === "bold") {
        claim += inline.text;
        nodes.push(
          <strong key={key} className="font-medium">
            {inline.text}
          </strong>,
        );
        return;
      }

      const index = matchSource(inline, sources);
      const supported = claim.trim();
      claim = "";

      if (index < 0) {
        // A tag that matches no retrieved passage. Shown, not hidden: a
        // citation nobody can open is exactly the thing a reader should see.
        nodes.push(
          <span
            key={key}
            title="This tag does not match any retrieved passage"
            className="mx-0.5 font-mono text-[11px] text-signal"
          >
            {inline.raw}
          </span>,
        );
        return;
      }

      const source = sources[index];
      nodes.push(
        <button
          key={key}
          type="button"
          onClick={() => onCite(index, supported)}
          aria-label={`Show source ${index + 1}: ${source.ticker} FY${source.fiscalYear} ${source.section}`}
          title={`${source.ticker} FY${source.fiscalYear} / ${source.section}`}
          className={`mx-[3px] inline-flex h-[19px] min-w-[19px] items-center justify-center px-1 align-[1px] font-mono text-[11px] leading-none transition-colors ${
            activeSource === index
              ? "bg-marker text-marker-ink ring-1 ring-border"
              : "bg-foreground text-background hover:bg-marker hover:text-marker-ink"
          }`}
        >
          {index + 1}
        </button>,
      );
    });

    if (withCaret) nodes.push(<span key={`${keyBase}-caret`} className="caret" />);
    return nodes;
  };

  const lastIndex = blocks.length - 1;

  return (
    <div className="space-y-4 text-[15px] leading-[1.75]">
      {blocks.map((block, i) => {
        const caret = streaming && i === lastIndex;

        if (block.kind === "heading") {
          return (
            <h3 key={i} className="pt-2 font-serif text-xl">
              {render(block.inlines, `h${i}`, caret)}
            </h3>
          );
        }

        if (block.kind === "list") {
          const List = block.ordered ? "ol" : "ul";
          return (
            <List key={i} className="space-y-2 pl-1">
              {block.items.map((item, j) => (
                <li key={j} className="grid grid-cols-[18px_minmax(0,1fr)] gap-1">
                  <span className="pt-[2px] font-mono text-xs text-muted">
                    {block.ordered ? `${j + 1}.` : "/"}
                  </span>
                  <span>
                    {render(item, `l${i}-${j}`, caret && j === block.items.length - 1)}
                  </span>
                </li>
              ))}
            </List>
          );
        }

        return (
          <p key={i} className="whitespace-pre-line">
            {render(block.inlines, `p${i}`, caret)}
          </p>
        );
      })}
    </div>
  );
}
