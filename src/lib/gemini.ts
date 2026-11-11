/**
 * Gemini access over the REST API.
 *
 * No SDK on purpose. The two things this app needs from Gemini are both
 * awkward through a client library: `outputDimensionality` on embeddings (the
 * legacy JS SDK has no field for it, so v1 of the sibling project ended up
 * calling REST anyway) and `thinkingConfig` on generation. Talking to the
 * documented endpoints directly removes a deprecated dependency, keeps the
 * serverless bundle small, and makes the failure modes visible instead of
 * wrapped in SDK error classes.
 *
 * Every call is written for the free tier, where a 429 mid-demo is routine
 * rather than exotic.
 */
import { CHAT_MODELS, EMBEDDING_DIM, EMBEDDING_MODEL } from "@/config";
import { env } from "@/lib/env";
import { SseDecoder } from "@/lib/sse";

const API_ROOT = "https://generativelanguage.googleapis.com/v1beta/models";

export class GenerationFailed extends Error {}

/** Quota exhaustion is not a bug in our code, and clients should see 429. */
export function isQuotaError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /\b429\b|quota|rate.?limit|RESOURCE_EXHAUSTED|exhaust/i.test(text);
}

function isTransient(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /\b50\d\b|overload|unavailable|fetch failed|ECONNRESET|ETIMEDOUT|timeout/i.test(text);
}

/**
 * Google retires model names with little notice (2.0 Flash in Oct 2026, 3.5 and
 * 3.7 Flash soon after). A retired name answers 404, and the next model in the
 * list is still a better outcome than no answer.
 */
function isRetired(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /\b404\b|not found/i.test(text);
}

/**
 * How long one model may take to produce its first token before the next one is
 * tried. Retrieval takes about 3 s and the route is cut at 30 s, so four models
 * at 6 s each still leave room for the quoted fallback answer.
 */
const FIRST_TOKEN_TIMEOUT_MS = 6_000;

/** One line for the server log. Never sent to the browser. */
function describeRaw(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/\s+/g, " ").slice(0, 160);
}

/**
 * A short explanation that is safe to show a user.
 *
 * The provider's raw error body can be several kilobytes of JSON and may echo
 * back request details, so it never reaches the browser. The API key is never
 * part of the message.
 */
export function describeFailure(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (isQuotaError(text)) {
    return "Gemini rate limit reached. The free tier allows only a few requests per minute.";
  }
  if (/api key|unauthenticated|permission|401|403/.test(text)) {
    return "Gemini rejected the API key.";
  }
  if (/not found|404/.test(text)) {
    return "The configured Gemini model is unavailable.";
  }
  if (/timeout|deadline|connection|network|fetch failed/.test(text)) {
    return "Could not reach Gemini.";
  }
  return "The Gemini request failed.";
}

/**
 * Turn text into a unit-normalised 768-dim vector.
 *
 * Normalising is recommended for reduced Matryoshka dimensions and is harmless
 * for cosine similarity, so retrieval behaves the same whichever distance
 * operator the SQL side uses.
 */
export async function embed(text: string): Promise<number[]> {
  const response = await fetch(`${API_ROOT}/${EMBEDDING_MODEL}:embedContent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": env().GEMINI_API_KEY,
    },
    body: JSON.stringify({
      content: { parts: [{ text }] },
      outputDimensionality: EMBEDDING_DIM,
    }),
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 200);
    throw new Error(`embedContent ${response.status}: ${detail}`);
  }

  const json = (await response.json()) as { embedding?: { values?: number[] } };
  const values = json.embedding?.values;
  if (!values || values.length !== EMBEDDING_DIM) {
    throw new Error(
      `embedContent returned ${values?.length ?? 0} dimensions, expected ${EMBEDDING_DIM}`,
    );
  }

  const norm = Math.sqrt(values.reduce((sum, x) => sum + x * x, 0)) || 1;
  return values.map((x) => x / norm);
}

export interface ChatTurn {
  role: "user" | "model";
  text: string;
}

interface StreamParams {
  systemInstruction: string;
  history: ChatTurn[];
  prompt: string;
}

/**
 * Stream an answer, yielding text as it arrives.
 *
 * Model fallback: free-tier quota is per model, so one exhausted model would
 * otherwise take the app down for the day. We retry the same turn on the next
 * model in the list, but only BEFORE the first token has been emitted. Once the
 * reader is looking at a partial answer, restarting elsewhere would duplicate
 * text on screen, so a mid-stream failure is reported instead of retried. That
 * asymmetry is the whole design.
 */
export async function* streamAnswer({
  systemInstruction,
  history,
  prompt,
}: StreamParams): AsyncGenerator<string> {
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: systemInstruction }] },
    contents: [
      ...history.map((turn) => ({ role: turn.role, parts: [{ text: turn.text }] })),
      { role: "user", parts: [{ text: prompt }] },
    ],
    // This model reasons before answering by default, which adds seconds of
    // first-token latency. The answer here only synthesises context that
    // retrieval already found, so that budget buys nothing.
    generationConfig: { thinkingConfig: { thinkingBudget: 0 } },
  });

  let lastError: unknown = new GenerationFailed("No model was attempted.");

  for (let i = 0; i < CHAT_MODELS.length; i++) {
    const model = CHAT_MODELS[i];
    let emitted = false;
    // A model under load sometimes accepts the request and then sends nothing
    // for a minute or more (gemini-flash-latest, 11 Nov 2026: no byte in 45 s).
    // Without a clock the whole request dies at the platform limit with no
    // answer at all, so a model that has not produced its first token in time
    // is abandoned for the next one.
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(`${model}: no first token, timeout after ${FIRST_TOKEN_TIMEOUT_MS} ms`)),
      FIRST_TOKEN_TIMEOUT_MS,
    );
    try {
      const response = await fetch(
        `${API_ROOT}/${model}:streamGenerateContent?alt=sse`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": env().GEMINI_API_KEY,
          },
          body,
          signal: controller.signal,
        },
      );

      if (!response.ok || !response.body) {
        const detail = response.body ? (await response.text()).slice(0, 200) : "no body";
        throw new Error(`streamGenerateContent ${response.status}: ${detail}`);
      }

      const reader = response.body.getReader();
      const utf8 = new TextDecoder();
      const decoder = new SseDecoder();

      for (;;) {
        const { done, value } = await reader.read();
        const payloads = done
          ? decoder.flush()
          : decoder.push(utf8.decode(value, { stream: true }));

        for (const payload of payloads) {
          if (payload === "[DONE]") continue;
          const text = extractText(payload);
          if (text) {
            if (!emitted) clearTimeout(timer);
            emitted = true;
            yield text;
          }
        }
        if (done) break;
      }
      clearTimeout(timer);
      return;
    } catch (error) {
      clearTimeout(timer);
      lastError = error;
      const worthRotating = isQuotaError(error) || isTransient(error) || isRetired(error);
      if (!emitted) console.warn(`[gemini] ${model} skipped:`, describeRaw(error));
      if (emitted || !worthRotating || i === CHAT_MODELS.length - 1) {
        throw new GenerationFailed(describeFailure(error));
      }
    }
  }

  throw new GenerationFailed(describeFailure(lastError));
}

/** Pull the text out of one streamed chunk, tolerating shapes without it. */
function extractText(payload: string): string {
  try {
    const parsed = JSON.parse(payload) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    return (parsed.candidates?.[0]?.content?.parts ?? [])
      .map((part) => part.text ?? "")
      .join("");
  } catch {
    // A malformed chunk is not worth failing a whole answer over.
    return "";
  }
}
