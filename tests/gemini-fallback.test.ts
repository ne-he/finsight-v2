import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { CHAT_MODELS } from "@/config";

beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  process.env.GEMINI_API_KEY = "test-key";
  process.env.EDGAR_USER_AGENT = "Test test@example.com";
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function sseResponse(text: string): Response {
  const body = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] })}\n\n`;
  return new Response(body, { status: 200 });
}

/** A request that never answers until its signal aborts, like a model under load. */
function hanging(init?: RequestInit): Promise<Response> {
  return new Promise((_, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
  });
}

async function collect(gen: AsyncGenerator<string>): Promise<string> {
  let out = "";
  for await (const t of gen) out += t;
  return out;
}

describe("streamAnswer model fallback", () => {
  it("abandons a model that sends no first token and answers from the next", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const calls: string[] = [];
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      calls.push(url);
      return calls.length === 1 ? hanging(init) : Promise.resolve(sseResponse("from model two"));
    });

    const { streamAnswer } = await import("@/lib/gemini");
    const pending = collect(streamAnswer({ systemInstruction: "s", history: [], prompt: "p" }));
    await vi.advanceTimersByTimeAsync(6_100);

    await expect(pending).resolves.toBe("from model two");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain(CHAT_MODELS[0]);
    expect(calls[1]).toContain(CHAT_MODELS[1]);
  });

  it("moves past a retired model that answers 404", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let n = 0;
    vi.stubGlobal("fetch", () =>
      Promise.resolve(n++ === 0 ? new Response("models/x is not found", { status: 404 }) : sseResponse("ok")),
    );

    const { streamAnswer } = await import("@/lib/gemini");
    await expect(collect(streamAnswer({ systemInstruction: "s", history: [], prompt: "p" }))).resolves.toBe("ok");
    expect(n).toBe(2);
  });

  it("does not retry a bad API key", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let n = 0;
    vi.stubGlobal("fetch", () => {
      n++;
      return Promise.resolve(new Response("API key not valid", { status: 400 }));
    });

    const { streamAnswer } = await import("@/lib/gemini");
    await expect(collect(streamAnswer({ systemInstruction: "s", history: [], prompt: "p" }))).rejects.toThrow();
    expect(n).toBe(1);
  });
});
