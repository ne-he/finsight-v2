/**
 * Server-Sent Events helpers.
 *
 * Used on both sides of the app: to read Gemini's streaming REST response, and
 * to write our own stream to the browser. Keeping the decoder as a small pure
 * class makes it unit-testable, which matters because the failure it prevents
 * is subtle: a network chunk can split an event anywhere, including in the
 * middle of a JSON payload, and a naive parser silently drops those tokens.
 */

/** Incremental SSE parser. Feed it raw text, get back complete `data:` payloads. */
export class SseDecoder {
  private buffer = "";

  push(chunk: string): string[] {
    this.buffer += chunk.replace(/\r\n/g, "\n");
    const events: string[] = [];

    let boundary = this.buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const raw = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);

      const data = raw
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data.length > 0) events.push(data);

      boundary = this.buffer.indexOf("\n\n");
    }
    return events;
  }

  /** Any trailing payload left when the stream ends without a final blank line. */
  flush(): string[] {
    const rest = this.buffer;
    this.buffer = "";
    if (!rest.trim()) return [];
    const data = rest
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    return data.length > 0 ? [data] : [];
  }
}

/** Format one event for the browser. */
export function sseEvent(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** Terminator the client watches for. */
export const SSE_DONE = "data: [DONE]\n\n";
