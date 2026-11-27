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
  // gemini.ts remembers which models refused thinkingBudget, so each test gets a fresh module.
  vi.resetModules();
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

  it("never sends thinkingBudget to 3.5 Flash-Lite, retries a refusing model without it, and rotates on 400", async () => {
    // 27 Nov 2026: gemini-3.5-flash-lite answers 400 INVALID_ARGUMENT to any thinkingBudget.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const calls: { model: string; thinking: boolean }[] = [];
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      const model = url.split("/models/")[1].split(":")[0];
      const thinking = String(init?.body).includes("thinkingConfig");
      calls.push({ model, thinking });
      if (model === "gemini-3.6-flash" && !thinking) return Promise.resolve(sseResponse("ok"));
      return Promise.resolve(
        new Response('{"error":{"code":400,"status":"INVALID_ARGUMENT"}}', { status: 400 }),
      );
    });

    const { streamAnswer } = await import("@/lib/gemini");
    await expect(collect(streamAnswer({ systemInstruction: "s", history: [], prompt: "p" }))).resolves.toBe("ok");
    expect(CHAT_MODELS.slice(0, 2)).toEqual(["gemini-3.5-flash-lite", "gemini-3.6-flash"]);
    expect(calls).toEqual([
      { model: "gemini-3.5-flash-lite", thinking: false },
      { model: "gemini-3.6-flash", thinking: true },
      { model: "gemini-3.6-flash", thinking: false },
    ]);
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
