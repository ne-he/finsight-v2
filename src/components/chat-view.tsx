"use client";

import { useEffect, useRef, useState } from "react";

import { SseDecoder } from "@/lib/sse";

export interface Source {
  ticker: string;
  fiscalYear: string;
  section: string;
  sourceUrl: string;
  score: number;
}

export interface ChatMessage {
  id?: string;
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
  topCosine?: number;
  gated?: boolean;
  degraded?: boolean;
  notice?: string;
}

interface Props {
  conversationId?: string;
  initialMessages?: ChatMessage[];
  suggestions?: string[];
}

export function ChatView({ conversationId, initialMessages = [], suggestions = [] }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [threadId, setThreadId] = useState<string | undefined>(conversationId);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function ask(question: string) {
    const trimmed = question.trim();
    if (!trimmed || busy) return;

    setBusy(true);
    setError(null);
    setInput("");

    // Only completed turns are sent back as history, so a failed answer never
    // becomes context for the next question.
    const history = messages
      .filter((m) => m.content.length > 0)
      .map((m) => ({ role: m.role, content: m.content }));

    setMessages((current) => [
      ...current,
      { role: "user", content: trimmed },
      { role: "assistant", content: "" },
    ]);

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
          } else if (event.type === "token") {
            answer += event.text as string;
            patchLast({ content: answer });
          } else if (event.type === "error") {
            patchLast({
              notice: event.message as string,
              degraded: event.recovered === true,
            });
          } else if (event.type === "done") {
            setThreadId((event.conversationId as string) ?? threadId);
            patchLast({ id: event.messageId as string });
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

  const empty = messages.length === 0;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4">
      <div className="flex-1 space-y-6 py-8">
        {empty ? (
          <div className="pt-8">
            <p className="text-sm text-muted">
              Ask about a company FinSight has ingested. Questions outside the
              filings are refused rather than guessed at.
            </p>
            {suggestions.length > 0 ? (
              <div className="mt-4 flex flex-wrap gap-2">
                {suggestions.map((s) => (
                  <button
                    key={s}
                    onClick={() => ask(s)}
                    className="rounded-full border border-border px-3 py-1.5 text-sm text-muted transition-colors hover:border-accent hover:text-foreground"
                  >
                    {s}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        {messages.map((message, i) =>
          message.role === "user" ? (
            <div key={i} className="flex justify-end">
              <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-accent px-4 py-2.5 text-sm text-accent-foreground">
                {message.content}
              </div>
            </div>
          ) : (
            <AssistantBubble key={i} message={message} busy={busy && i === messages.length - 1} />
          ),
        )}

        <div ref={bottomRef} />
      </div>

      {error ? (
        <p role="alert" className="mb-3 text-sm text-danger">
          {error}
        </p>
      ) : null}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          ask(input);
        }}
        className="sticky bottom-0 flex gap-2 border-t border-border bg-background py-4"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="What are NVIDIA's main risk factors?"
          maxLength={2000}
          disabled={busy}
          className="h-11 flex-1 rounded-md border border-border bg-surface-raised px-3.5 text-sm outline-none focus:border-accent disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={busy || input.trim().length === 0}
          className="h-11 rounded-md bg-accent px-5 text-sm font-medium text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          Ask
        </button>
      </form>
    </div>
  );
}

function AssistantBubble({ message, busy }: { message: ChatMessage; busy: boolean }) {
  const waiting = busy && message.content.length === 0;

  return (
    <div className="space-y-3">
      {message.gated ? (
        <p className="rounded-md border border-warning-border bg-warning-surface px-3 py-2 text-xs text-warning-foreground">
          Retrieval was weak for this question, so the answer is limited to
          saying what the filings do not cover.
        </p>
      ) : null}

      {waiting ? (
        <p className="flex gap-1 text-muted" aria-label="Thinking">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="typing-dot"
              style={{ animationDelay: `${i * 0.15}s` }}
            >
              &#9679;
            </span>
          ))}
        </p>
      ) : (
        <div className="answer-text text-sm leading-relaxed">{message.content}</div>
      )}

      {message.degraded ? (
        <p className="text-xs text-muted">
          Quoted directly from the filings because the model was unavailable.
        </p>
      ) : null}

      {message.notice && !message.degraded ? (
        <p className="text-xs text-danger">{message.notice}</p>
      ) : null}

      {message.sources && message.sources.length > 0 ? (
        <Sources sources={message.sources} topCosine={message.topCosine} />
      ) : null}

      {message.id ? <Feedback messageId={message.id} /> : null}
    </div>
  );
}

function Sources({ sources, topCosine }: { sources: Source[]; topCosine?: number }) {
  return (
    <details className="rounded-md border border-border bg-surface px-3 py-2">
      <summary className="cursor-pointer text-xs text-muted">
        {sources.length} source{sources.length === 1 ? "" : "s"}
        {typeof topCosine === "number" ? ` * top match ${topCosine.toFixed(3)}` : ""}
      </summary>
      <ul className="mt-2 space-y-1.5">
        {sources.map((source) => (
          <li key={`${source.ticker}-${source.section}`} className="text-xs">
            <span className="font-mono text-muted">
              [{source.ticker} FY{source.fiscalYear}]
            </span>{" "}
            {source.sourceUrl ? (
              <a
                href={source.sourceUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="text-accent hover:underline"
              >
                {source.section}
              </a>
            ) : (
              <span>{source.section}</span>
            )}
          </li>
        ))}
      </ul>
    </details>
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

  if (sent !== null) {
    return <p className="text-xs text-muted">Thanks, that helps.</p>;
  }

  return (
    <div className="flex gap-3 text-xs text-muted">
      <button onClick={() => rate(1)} className="hover:text-foreground transition-colors">
        Helpful
      </button>
      <button onClick={() => rate(-1)} className="hover:text-foreground transition-colors">
        Not helpful
      </button>
    </div>
  );
}
