/**
 * Tests for the SSE decoder.
 *
 * The bug this guards against is invisible in a happy-path demo: a network
 * chunk can split an event anywhere, including inside a JSON payload, and a
 * decoder that assumes one chunk is one event silently drops those tokens.
 */
import { describe, expect, it } from "vitest";

import { SseDecoder, sseEvent } from "@/lib/sse";

describe("SseDecoder", () => {
  it("reads a single complete event", () => {
    expect(new SseDecoder().push('data: {"a":1}\n\n')).toEqual(['{"a":1}']);
  });

  it("reads several events from one chunk", () => {
    expect(new SseDecoder().push("data: one\n\ndata: two\n\n")).toEqual(["one", "two"]);
  });

  it("joins an event split across chunks", () => {
    const decoder = new SseDecoder();

    expect(decoder.push('data: {"text":"hel')).toEqual([]);
    expect(decoder.push('lo"}\n\n')).toEqual(['{"text":"hello"}']);
  });

  it("handles a boundary split across chunks", () => {
    const decoder = new SseDecoder();

    expect(decoder.push("data: one\n")).toEqual([]);
    expect(decoder.push("\ndata: two\n\n")).toEqual(["one", "two"]);
  });

  it("accepts carriage returns", () => {
    expect(new SseDecoder().push("data: one\r\n\r\n")).toEqual(["one"]);
  });

  it("ignores comments and unknown fields", () => {
    expect(new SseDecoder().push(": keep-alive\nevent: ping\ndata: one\n\n")).toEqual([
      "one",
    ]);
  });

  it("joins multi-line data fields", () => {
    expect(new SseDecoder().push("data: line one\ndata: line two\n\n")).toEqual([
      "line one\nline two",
    ]);
  });

  it("returns a trailing event with no final blank line on flush", () => {
    const decoder = new SseDecoder();

    expect(decoder.push("data: last")).toEqual([]);
    expect(decoder.flush()).toEqual(["last"]);
    expect(decoder.flush()).toEqual([]);
  });
});

describe("sseEvent", () => {
  it("writes a parseable frame", () => {
    const frame = sseEvent({ type: "token", text: "hi\n" });

    expect(frame.endsWith("\n\n")).toBe(true);
    expect(new SseDecoder().push(frame)).toEqual([
      JSON.stringify({ type: "token", text: "hi\n" }),
    ]);
  });

  it("escapes newlines so a token cannot end its own frame early", () => {
    // A raw newline inside the payload would terminate the data field and
    // truncate every token containing a line break.
    expect(sseEvent({ text: "a\n\nb" })).not.toContain("a\n\nb");
  });
});
