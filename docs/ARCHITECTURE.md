# Architecture decisions

Written 20 September 2026, at the start of the v2 rewrite. Each section records
a decision, the alternatives that were rejected, and what it costs. Entries
marked `[?]` are unverified and must be checked before they are relied on.

---

## 1. Why rewrite v1 at all

FinSight v1 is a Python FastAPI service. It works, it is measured, and it is
tested. It has one problem that no amount of polish fixes: it has never been
deployed, because it needs a host that runs a Python process continuously, and
the obvious free options each carry an unresolved question about payment
details or plan limits.

The Next.js rewrite removes the question entirely. Vercel already hosts a
sibling project on this account, with a working daily cron and a 30 second
function ceiling proven in production.

**Cost, stated plainly.** Every line of the retrieval engine is rewritten, and
every number v1 measured stops being evidence for v2. That is not a formality:
during v1 development a single change to chunk overlap moved retrieval hit-rate
from 16/16 to 14/16. A port can move it the same way.

---

## 2. One Vercel deployment, not a split frontend and backend

**Decided:** a single Next.js app serving both pages and `/api` routes.

**Rejected:** a separate Python service behind a Next.js frontend. It keeps the
measured v1 engine, but reintroduces the hosting problem the rewrite exists to
solve, and adds CORS and two deployments to keep in step.

**Cost:** answering is bound by the function time limit. Acceptable, because
retrieval plus a streamed answer finishes in seconds. Ingest is not acceptable
under that limit, which is what section 4 is about.

---

## 3. Supabase, sharing a project with another app

**Decided:** reuse the existing Supabase project, with every object prefixed
`fs_`.

**Why:** the free plan allows two active projects and the slots are in use.
A prefix costs nothing and keeps the two apps visibly separate.

**Consequences taken on:**

- `auth.users` is shared. Profiles are therefore created lazily by the app
  rather than by a trigger on that table, which would create FinSight profiles
  for the other app's users too.
- A mistake in a migration can affect the other app. Migrations are numbered,
  committed, and only ever create `fs_` objects.

**Rejected:** Firebase. Firestore is a document store, so vector search and the
relational history model would both need rework, and the schema here is
genuinely relational: users own conversations, conversations own messages,
messages own feedback.

---

## 4. Ingest is a resumable state machine

**The problem:** one 10-K produces several hundred chunks, each needing an
embedding call. Minutes of work, in an environment that allows seconds.

**Decided:** slice it. A row in `fs_ingest_jobs` holds the status and the
counters, and each call to `/api/admin/ingest/step` performs exactly one slice
and returns.

```
queued -> fetching -> chunking -> embedding -> ready
               \          \           \
                +----------+-----------+--> failed
```

Stages are split so the slowest and least predictable part, a multi-megabyte
download from a third party, owns a request by itself.

**Who drives the loop:** the admin's browser. A scheduler was rejected because
cron frequency on the free plan is `[?]` unverified, and a once-daily tick
would make a single ingest take weeks. The browser loop needs no guarantee from
the platform, shows real progress, and a closed tab pauses the job rather than
losing it.

**Why chunks are inserted with a null embedding:** a partly finished job then
leaves rows that are visibly not ready, and search skips them. The alternative,
holding everything until the end, turns any interruption into lost work.

---

## 5. Ranking moved into Postgres

**Decided:** one SQL function, `fs_match_chunks`, runs the vector search and the
full-text search, fuses them with Reciprocal Rank Fusion, and returns the top k.

**Why it had to move:** v1 held the whole index in process memory. On
serverless there is no process to hold it.

**What improves:** the company and year filter now applies *inside* the
ranking. v1's Supabase path filtered after the query returned, so an
over-fetched result could still come back with fewer than k usable rows.

**What gets worse, and must not be glossed over:**

1. The keyword arm is `ts_rank_cd`, not BM25. Same idea, different scoring.
   Rankings will not match v1.
2. There is no cross-encoder reranking stage. Running one inside SQL is not
   practical, and pulling in a PyTorch model contradicts the whole reason for
   this rewrite.
3. Ranking logic in SQL is harder to unit test than a TypeScript function. It
   is covered by the eval harness and by integration tests, not by Vitest.

**Therefore:** `CONFIDENCE_THRESHOLD = 0.68` was inherited, not established,
and no v1 metric was allowed to stand for v2 until it had been re-measured.

**Measured, 20 September 2026** (NVDA FY2026 and AAPL FY2025, 582 chunks, 18
questions): hit-rate@6 13/14, gate accuracy 4/4, no false refusals, mean top
cosine 0.765, a clean gap of 0.110. The single miss was a comparison question
that retrieved only one of the two companies.

**Re-measured, 21 September 2026** (MSFT FY2026 added, 936 chunks, 22
questions, comparison retrieval fixed below): hit-rate@6 18/18, gate accuracy
4/4, no false refusals, mean top cosine 0.763. Answerable questions scored
0.707 to 0.815 and out-of-scope ones 0.472 to 0.612, a gap of 0.095. The
lowest answerable score is a three-way comparison, only 0.027 above 0.68, so
the gate moved to the midpoint of the measured gap, 0.66. The threshold is now
a result of the measurement rather than a number carried over from v1.

### 5a. A search per company in a comparison

**Problem:** one ranked search over two filings returns whichever filing
phrases the topic closer to the question. "Compare the revenue drivers of
NVIDIA and Apple" returned six NVIDIA chunks and no Apple, so the answer could
only ever describe one side.

**Decided:** when query understanding detects more than one company, run one
search per company with the same embedding and interleave the results by rank,
never fewer than one passage per company.

**Cost:** n round trips to Postgres instead of one, on comparison questions
only. No extra embedding call, because the vector is computed once.

**Alternative rejected:** raising `final_k` for comparisons. That makes the
dominant filing take more of the context as well, so it does not guarantee the
other company appears at all.

---

## 6. Gemini over REST, with no SDK

**Decided:** call `embedContent` and `streamGenerateContent` directly.

**Why:** the app needs `outputDimensionality` on embeddings, which the legacy
JavaScript SDK has no field for, and `thinkingConfig` on generation. Both are
plain fields in the REST body. Going direct also removes a deprecated
dependency and shrinks the serverless bundle.

**Cost:** an SSE parser has to be written and tested. It is, in `src/lib/sse.ts`,
and the tests cover the case that actually breaks naive parsers: an event split
across network chunks.

**Retry policy, and the asymmetry in it:** generation falls back to the next
model on quota or transient errors, but only *before* the first token is
emitted. Once the reader is looking at a partial answer, restarting elsewhere
would duplicate text on screen, so a mid-stream failure is reported instead.

---

## 7. Degrading instead of dying

Retrieval and generation fail independently, and only generation needs a third
party. When Gemini refuses, retrieval has already done the expensive part: it
found the right sections of the right filings.

So the stream emits `sources` first, then tokens. If generation fails before
any token, the answer becomes passages quoted from those chunks, labelled as
degraded, with citations intact. If it fails after, an explicit `error` event
tells the client the answer is truncated.

The failure this prevents is specific and was observed in v1: citations render,
then nothing, forever, with no error anywhere.

---

## 8. Security posture

- **Row Level Security on every table.** The browser holds the anon key and can
  call the Supabase REST API directly, so a user must not be able to read
  another user's conversations even if an API route forgets to check.
- **Role is not client-writable.** A user who could update their own profile row
  would set `role = 'admin'`. Promotion happens with the service role key.
- **The service role key is server only** and never prefixed `NEXT_PUBLIC_`.
- **Provider errors never reach the browser verbatim.** They can be kilobytes of
  JSON echoing request details. `describeFailure` maps them to one safe line.
- **The ticker is validated against a strict pattern** before being interpolated
  into an SEC URL.
- **The rate limit lives in the database**, incremented and checked in a single
  statement, because a counter in process memory resets whenever the platform
  replaces the function.
- **Prompt injection is an accepted, unmitigated risk for now.** Filing text is
  fetched from SEC and placed in the model's context. SEC documents are a
  low-risk source, but the system prompt is not a security boundary. `[?]` Worth
  a written threat model before launch.

---

## 9. Open questions

| Question | Why it matters | How to settle it |
|---|---|---|
| Vercel Hobby function ceiling `[?]` | Decides whether 30 seconds can be raised | Read the plan limits page, or test a long response |
| Vercel Hobby cron frequency `[?]` | Decides whether ingest could ever be scheduled | Same |
| Supabase free storage headroom `[?]` | Filing text plus chunks plus cache adds up | Check the project dashboard after the first ingest |
| ~~Does `hnsw` build on this Postgres version~~ | Resolved 20 Sep: migration 0001 applied cleanly | |
| ~~Indonesian question quality~~ | Resolved 20 Sep: two Indonesian questions are in the golden set and both route correctly, and answers come back in Indonesian with English citations | |
| Answer faithfulness | Retrieval is measured, generation is not | Needs an LLM judge and more generation quota than one day allows |

---

## 9a. The evidence panel is part of the argument

**Decided:** ship the retrieved passages to the browser with the answer, and
show them beside it.

Citations that only name a section still ask the reader to open a 300 page
filing and search it. The panel closes that gap: a numbered citation opens the
passage it points at, with the sentence closest in wording to the claim
highlighted.

**The honest limit:** the model does not report which sentence it used. The
highlight is a word-overlap estimate, labelled as one, and suppressed entirely
when the overlap is thin, which is what happens when an Indonesian answer
cites an English filing. A confident highlight on the wrong sentence would be
worse than no highlight.

**Cost:** roughly 8 KB of passage text per answer, stored on the message row
so a saved conversation can still be checked later.

---

## 10. Deliberately out of scope

- A cross-encoder reranker. See section 5.
- Multiple fiscal years per company. The schema allows it; the ingest flow
  fetches only the latest 10-K.
- Any new machine learning component. The value here is in engineering, and
  effort spent on modelling buys nothing this project is judged on.
- Microservices. One deployment, one database, a modular monolith.
