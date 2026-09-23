"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AnswerBody } from "@/components/chat/answer-body";
import { EvidencePanel } from "@/components/chat/evidence-panel";
import { MatchMeter } from "@/components/chat/match-meter";
import type { ChatMessage, CorpusItem, EvidenceFocus, Source } from "@/components/chat/types";
import { orderByCitation } from "@/lib/answer-format";
import { joinNames } from "@/lib/company";
import { SseDecoder } from "@/lib/sse";

export type { ChatMessage, Source } from "@/components/chat/types";

interface Props {
  conversationId?: string;
  initialMessages?: ChatMessage[];
  corpus: CorpusItem[];
  suggestions?: string[];
}

/**
 * The desk: the conversation on the left, the evidence on the right.
 *
 * Two panes that scroll independently inside one screen, rather than a page
 * that grows downwards, because the whole point of the layout is to read an
 * answer and its source side by side without losing either.
 */
export function ChatView({
  conversationId,
  initialMessages = [],
  corpus,
  suggestions = [],
}: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [threadId, setThreadId] = useState<string | undefined>(conversationId);
  const [focus, setFocus] = useState<EvidenceFocus | null>(() => lastWithSources(initialMessages));
  const [sheetOpen, setSheetOpen] = useState(false);

  const threadRef = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  // Follow the answer while it streams, but stop fighting the reader the
  // moment they scroll up to re-read something.
  useEffect(() => {
    const pane = threadRef.current;
    if (pane && nearBottom.current) pane.scrollTop = pane.scrollHeight;
  }, [messages]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const tag = (event.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      event.preventDefault();
      composerRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const openEvidence = useCallback(
    (messageIndex: number, sourceIndex: number, claim: string | null) => {
      setFocus({ messageIndex, sourceIndex, claim });
      if (window.matchMedia("(max-width: 1023px)").matches) setSheetOpen(true);
    },
    [],
  );

  async function ask(question: string) {
    const trimmed = question.trim();
    if (!trimmed || busy) return;

    setBusy(true);
    setError(null);
    setInput("");
    if (composerRef.current) composerRef.current.style.height = "auto";

    // Only completed turns are sent back as history, so a failed answer never
    // becomes context for the next question.
    const history = messages
      .filter((m) => m.content.length > 0)
      .map((m) => ({ role: m.role, content: m.content }));

    let answerIndex = 0;
    setMessages((current) => {
      answerIndex = current.length + 1;
      return [
        ...current,
        { role: "user", content: trimmed },
        { role: "assistant", content: "" },
      ];
    });
    nearBottom.current = true;

    const patchLast = (patch: Partial<ChatMessage>) =>
      setMessages((current) => {
        const next = [...current];
        next[next.length - 1] = { ...next[next.length - 1], ...patch };
        return next;
      });

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: trimmed, history, conversationId: threadId }),
      });

      if (!response.ok || !response.body) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "The request failed.");
      }

      const reader = response.body.getReader();
      const utf8 = new TextDecoder();
      const decoder = new SseDecoder();
      let answer = "";

      for (;;) {
        const { done, value } = await reader.read();
        const payloads = done
          ? decoder.flush()
          : decoder.push(utf8.decode(value, { stream: true }));

        for (const payload of payloads) {
          if (payload === "[DONE]") continue;
          const event = JSON.parse(payload) as Record<string, unknown>;

          if (event.type === "sources") {
            patchLast({
              sources: event.sources as Source[],
              topCosine: event.topCosine as number,
              gated: event.gated as boolean,
            });
            // Fill the panel as soon as retrieval reports, so the reader can
            // see what the answer is being built from while it is written.
            setFocus({ messageIndex: answerIndex, sourceIndex: 0, claim: null });
          } else if (event.type === "token") {
            answer += event.text as string;
            patchLast({ content: answer });
          } else if (event.type === "error") {
            patchLast({
              notice: event.message as string,
              degraded: event.recovered === true,
            });
          } else if (event.type === "done") {
            const id = (event.conversationId as string) ?? threadId;
            setThreadId(id);
            patchLast({
              id: event.messageId as string,
              latencyMs: event.latencyMs as number,
            });
            // Make the conversation linkable without a navigation.
            if (id && window.location.pathname === "/chat") {
              window.history.replaceState(null, "", `/chat/${id}`);
            }
          }
        }
        if (done) break;
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Something went wrong.";
      setError(message);
      // Drop the empty assistant bubble so the page does not sit there blank.
      setMessages((current) => {
        const next = [...current];
        if (next[next.length - 1]?.content === "") next.pop();
        return next;
      });
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setMessages([]);
    setThreadId(undefined);
    setFocus(null);
    setError(null);
    window.history.replaceState(null, "", "/chat");
    composerRef.current?.focus();
  }

  const empty = messages.length === 0;
  const focused = focus ? (messages[focus.messageIndex] ?? null) : null;
  const names = corpus.map((c) => c.name);
  const placeholder =
    names.length === 0 ? "Ask about a company in the corpus" : "Ask about the filings";

  // The panel and the numbered chips must agree, so both read the same
  // citation-ordered list rather than the raw retrieval ranking.
  const focusedSources = useMemo(
    () => orderByCitation(focused?.content ?? "", focused?.sources ?? []),
    [focused?.content, focused?.sources],
  );

  return (
    <div className="grid h-[calc(100dvh-var(--nav-h))] w-full grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(380px,460px)]">
      <section className="flex min-h-0 flex-col">
        <header className="flex shrink-0 items-center gap-4 border-b border-rule-soft px-4 py-2.5 sm:px-8">
          <span className="label hidden sm:inline">In the corpus</span>
          <ul className="flex flex-wrap items-baseline gap-x-4 gap-y-1 font-mono text-[11px]">
            {corpus.map((c) => (
              <li key={c.ticker}>
                {c.ticker} <span className="text-muted">FY{c.fiscalYear}</span>
              </li>
            ))}
          </ul>
          {!empty ? (
            <button
              type="button"
              onClick={reset}
              className="ml-auto shrink-0 border border-rule-soft px-2.5 py-1 text-xs transition-colors hover:border-border"
            >
              New question
            </button>
          ) : null}
        </header>

        <div
          ref={threadRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
          }}
          className="pane min-h-0 flex-1 overflow-y-auto"
        >
          <div className="mx-auto w-full max-w-[760px] px-4 py-10 sm:px-8">
            {empty ? (
              <EmptyState names={names} suggestions={suggestions} onPick={ask} />
            ) : (
              <div className="space-y-12">
                {messages.map((message, i) =>
                  message.role === "user" ? (
                    <div key={i}>
                      <p className="label">You asked</p>
                      <h2 className="mt-2 font-serif text-[30px] leading-[1.08] text-balance sm:text-[36px]">
                        {message.content}
                      </h2>
                    </div>
                  ) : (
                    <Answer
                      key={i}
                      message={message}
                      index={i}
                      streaming={busy && i === messages.length - 1}
                      activeSource={focus?.messageIndex === i ? focus.sourceIndex : null}
                      onCite={openEvidence}
                      onOpenSheet={() => openEvidence(i, focus?.sourceIndex ?? 0, focus?.claim ?? null)}
                    />
                  ),
                )}
              </div>
            )}
          </div>
        </div>

        <div className="shrink-0 border-t border-border bg-background px-4 py-4 sm:px-8">
          <div className="mx-auto w-full max-w-[760px]">
            {error ? (
              <p role="alert" className="mb-3 border-l-2 border-danger pl-3 text-sm text-danger">
                {error}
              </p>
            ) : null}

            <form
              onSubmit={(e) => {
                e.preventDefault();
                ask(input);
              }}
              className="flex items-end gap-2 border border-border bg-surface-raised p-2 focus-within:shadow-[inset_0_-2px_0_0_var(--foreground)]"
            >
              <textarea
                ref={composerRef}
                value={input}
                rows={1}
                onChange={(e) => {
                  setInput(e.target.value);
                  e.target.style.height = "auto";
                  e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    ask(input);
                  }
                }}
                placeholder={placeholder}
                maxLength={2000}
                disabled={busy}
                className="max-h-40 min-h-[36px] flex-1 resize-none bg-transparent px-2 py-2 text-[15px] outline-none disabled:opacity-60"
              />
              <button
                type="submit"
                disabled={busy || input.trim().length === 0}
                className="h-10 shrink-0 bg-accent px-6 text-sm font-medium text-accent-foreground transition-opacity hover:opacity-85 disabled:opacity-40"
              >
                {busy ? "Reading" : "Ask"}
              </button>
            </form>

            <div className="mt-2 flex justify-between gap-4 font-mono text-[10px] text-muted">
              <span className="hidden sm:inline">
                Enter to ask, Shift and Enter for a new line
              </span>
              <span>Informational only, not investment advice</span>
            </div>
          </div>
        </div>
      </section>

      <aside className="hidden min-h-0 border-l border-border bg-surface-raised lg:flex lg:flex-col">
        <EvidencePanel
          message={focused}
          sources={focusedSources}
          focus={focus}
          onSelect={(sourceIndex) =>
            setFocus((current) =>
              current ? { ...current, sourceIndex, claim: null } : current,
            )
          }
        />
      </aside>

      {sheetOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            aria-label="Close evidence"
            onClick={() => setSheetOpen(false)}
            className="absolute inset-0 bg-foreground/30"
          />
          <div className="sheet-up absolute inset-x-0 bottom-0 flex max-h-[82dvh] flex-col border-t border-border bg-surface-raised">
            <EvidencePanel
              message={focused}
              sources={focusedSources}
              focus={focus}
              onSelect={(sourceIndex) =>
                setFocus((current) =>
                  current ? { ...current, sourceIndex, claim: null } : current,
                )
              }
              onClose={() => setSheetOpen(false)}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Answer({
  message,
  index,
  streaming,
  activeSource,
  onCite,
  onOpenSheet,
}: {
  message: ChatMessage;
  index: number;
  streaming: boolean;
  activeSource: number | null;
  onCite: (messageIndex: number, sourceIndex: number, claim: string) => void;
  onOpenSheet: () => void;
}) {
  const sources = useMemo(
    () => orderByCitation(message.content, message.sources ?? []),
    [message.content, message.sources],
  );
  const waiting = streaming && message.content.length === 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <span className="label">Answer</span>
        <span className="h-px flex-1 bg-rule-soft" />
      </div>

      {message.gated ? (
        <p className="border-l-2 border-warning-border bg-warning-surface px-4 py-3 text-sm leading-relaxed text-warning-foreground">
          The closest passage scored below the gate, so this answer is limited
          to saying what the filings do not cover.
        </p>
      ) : null}

      {waiting ? (
        <p className="font-mono text-xs text-muted">
          {sources.length === 0 ? "Searching the filings" : `Reading ${sources.length} sections`}
          <span className="caret" />
        </p>
      ) : (
        <AnswerBody
          text={message.content}
          sources={sources}
          streaming={streaming}
          activeSource={activeSource}
          onCite={(sourceIndex, claim) => onCite(index, sourceIndex, claim)}
        />
      )}

      {message.degraded ? (
        <p className="text-xs text-muted">
          Quoted directly from the filings because the model was unavailable.
        </p>
      ) : null}

      {message.notice && !message.degraded ? (
        <p className="text-xs text-signal">{message.notice}</p>
      ) : null}

      {!waiting && sources.length > 0 ? (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-rule-soft pt-3 font-mono text-[11px] text-muted">
          <span>{sources.length} sections</span>
          {typeof message.topCosine === "number" ? (
            <span>best match {message.topCosine.toFixed(3)}</span>
          ) : null}
          {typeof message.latencyMs === "number" ? (
            <span>{(message.latencyMs / 1000).toFixed(1)} s</span>
          ) : null}
          <button
            type="button"
            onClick={onOpenSheet}
            className="underline underline-offset-4 transition-colors hover:text-foreground lg:hidden"
          >
            Show evidence
          </button>
          {message.id ? <Feedback messageId={message.id} /> : null}
        </div>
      ) : null}

      {message.gated && typeof message.topCosine === "number" ? (
        <div className="max-w-xs pt-2 lg:hidden">
          <MatchMeter score={message.topCosine} />
        </div>
      ) : null}
    </div>
  );
}

function Feedback({ messageId }: { messageId: string }) {
  const [sent, setSent] = useState<number | null>(null);

  async function rate(rating: 1 | -1) {
    setSent(rating);
    await fetch("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageId, rating }),
    }).catch(() => setSent(null));
  }

  if (sent !== null) return <span className="ml-auto">Thanks, that helps</span>;

  return (
    <span className="ml-auto flex gap-4">
      <button
        onClick={() => rate(1)}
        className="underline underline-offset-4 transition-colors hover:text-foreground"
      >
        Helpful
      </button>
      <button
        onClick={() => rate(-1)}
        className="underline underline-offset-4 transition-colors hover:text-foreground"
      >
        Not helpful
      </button>
    </span>
  );
}

function EmptyState({
  names,
  suggestions,
  onPick,
}: {
  names: string[];
  suggestions: string[];
  onPick: (question: string) => void;
}) {
  return (
    <div className="pt-6 sm:pt-12">
      <p className="label reveal" style={{ "--i": 0 } as React.CSSProperties}>
        Ask the filings
      </p>
      <h1
        className="reveal mt-4 max-w-2xl font-serif text-[40px] leading-[1.02] text-balance sm:text-[52px]"
        style={{ "--i": 1 } as React.CSSProperties}
      >
        What do you want to know about {joinNames(names)}?
      </h1>
      <p
        className="reveal mt-5 max-w-xl text-[15px] leading-relaxed text-muted"
        style={{ "--i": 2 } as React.CSSProperties}
      >
        Answers come only from the latest annual report of each company, with a
        citation on every claim. Ask in English or Indonesian.
      </p>

      <div className="mt-10 grid gap-3 sm:grid-cols-2">
        {suggestions.map((suggestion, i) => (
          <button
            key={suggestion}
            onClick={() => onPick(suggestion)}
            className="reveal group border border-rule-soft bg-surface-raised p-4 text-left transition-colors hover:border-border"
            style={{ "--i": 3 + i } as React.CSSProperties}
          >
            <span className="label">Try</span>
            <span className="mt-2 block text-[15px] leading-snug">{suggestion}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Where the evidence panel should start when a saved conversation is opened. */
function lastWithSources(messages: ChatMessage[]): EvidenceFocus | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant" && (messages[i].sources?.length ?? 0) > 0) {
      return { messageIndex: i, sourceIndex: 0, claim: null };
    }
  }
  return null;
}
