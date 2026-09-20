# FinSight v2

A retrieval-augmented question answering system over SEC 10-K filings. Ask what
a public company said about its risks, segments or revenue drivers, and get an
answer built only from the filing text, cited down to the section, or an honest
refusal when the documents do not support one.

v2 is a rewrite of [the original Python system](https://github.com/ne-he/RAG_businessAnalysis_assist)
as a single Next.js application on Vercel, with Supabase for authentication,
conversation history and vector search.

> **Status: in development.** The retrieval core, the database schema, the API
> routes and the test suite are in place and the project builds. There is no
> user interface yet, nothing has been deployed, and none of the quality
> metrics have been measured on this implementation. See
> [What is not done yet](#what-is-not-done-yet).

---

## Why it is not a chatbot wrapper

| Concern | A naive wrapper | FinSight |
|---|---|---|
| Source of facts | The model's memory, stale and unattributable | Retrieved 10-K excerpts only |
| Document structure | Raw text, blind splitting | Section-aware chunking per 10-K Item |
| Retrieval | One vector search | Hybrid vector plus full-text, fused with RRF |
| Targeting | One global search | Company and fiscal year filters applied inside the ranking |
| Citations | None, or invented | Exact: `[NVDA FY2026 * Item 1A. Risk Factors]` plus source URL |
| Hallucination control | Hope | A confidence gate that refuses below a measured threshold |
| When the model is down | An error, or silence | A degraded answer quoted from the retrieved passages |
| Quality | "Looks fine" | An eval harness over a golden set |

---

## Architecture

```
Browser
   |
   |  question
   v
Vercel  (Next.js App Router: pages + /api routes)
   |                                    |
   |  fs_match_chunks RPC               |  embed + generate
   v                                    v
Supabase                            Gemini API
  Auth, Postgres, pgvector
```

Everything runs in one deployment. There is no separate backend service, no
container, and nothing to keep warm except the database.

### The serverless constraints, and what they forced

A function here has a time limit and no memory between requests. Both shaped
the design rather than being worked around.

| Constraint | Consequence |
|---|---|
| A request cannot run for minutes | Ingest is a resumable state machine, sliced into batches |
| Nothing survives between requests | Ranking runs in Postgres; the daily quota counter lives in a table |
| Free-tier embedding quota is 1,000 per day | Embeddings are cached by content hash, so a repeat ingest is nearly free |
| Free-tier generation quota is per model | Generation falls back through a list of models, but only before the first token |
| Supabase pauses an idle project | A scheduled keep-alive touches the database, with a second scheduler as backup |

### Ingest as a state machine

Adding a company means downloading a 10-K, splitting it into hundreds of
chunks, and calling an embedding API once per chunk. That cannot fit in one
request, so the job row *is* the progress:

```
queued -> fetching -> chunking -> embedding -> ready
               \          \           \
                +----------+-----------+--> failed
```

The admin page calls `/api/admin/ingest/step` in a loop until the job reports
`done`. Driving that loop from the browser rather than a scheduler means it
needs no cron frequency guarantee from the hosting plan, it gives the operator
a live progress bar, and closing the tab pauses the job instead of losing it.

---

## Stack

Next.js 16 (App Router, Turbopack) * TypeScript * Tailwind CSS 4 *
Supabase (Postgres, pgvector, Auth, RLS) * Gemini
(`gemini-2.5-flash` for answers, `gemini-embedding-001` at 768 dimensions) *
Vitest * GitHub Actions.

Gemini is called over its REST API rather than through an SDK. The two things
this app needs, `outputDimensionality` on embeddings and `thinkingConfig` on
generation, are awkward or unavailable through the JavaScript client, and the
direct calls remove a deprecated dependency.

---

## Running it locally

```bash
npm install
cp .env.example .env.local     # then fill in the values
```

Apply the SQL in `supabase/migrations/` in order, through the Supabase SQL
editor. Then:

```bash
npm run dev        # http://localhost:3000
npm test           # unit tests, no network needed
npm run typecheck
npm run build
```

Promote your account to administrator once, after signing up:

```sql
update fs_profiles set role = 'admin' where email = 'you@example.com';
```

---

## Layout

```
src/
  config.ts              tuning knobs, no secrets
  proxy.ts               session refresh on every request
  lib/
    env.ts               validated server environment
    gemini.ts            embeddings and streaming generation over REST
    sse.ts               incremental SSE decoder, and the encoder for our own stream
    auth.ts              who is calling, and whether they may
    ingest.ts            the ingest state machine
    supabase/            browser, user-session and service-role clients
    rag/
      edgar.ts           SEC lookup and HTML to text
      sections.ts        10-K Item detection
      chunking.ts        paragraph-aware chunking with overlap
      filters.ts         which company and year a question is about
      prompt.ts          system prompt, context wrapping, degraded answer
      retrieve.ts        hybrid search and the confidence gate
  app/api/               chat, health, keep-alive, admin ingest
supabase/migrations/     schema, RLS policies, search function, rate limit
tests/                   Vitest, offline
docs/ARCHITECTURE.md     decisions and trade-offs
```

---

## What is not done yet

Listed rather than implied, because a README that reads as finished when the
project is not is the easiest kind of documentation to get wrong.

- **No user interface.** Sign in, chat, history and the admin page are not built.
- **Not deployed.** No Supabase project provisioned, no Vercel project linked.
- **No measured quality.** `CONFIDENCE_THRESHOLD` is inherited from v1, where it
  was tuned against a BM25 retriever. v2 ranks with Postgres full-text search
  instead, so the threshold and every retrieval metric have to be measured
  again before they can be quoted. The eval harness is not written.
- **No integration tests** against a live database. Unit tests cover the pure
  logic only.

---

## Disclaimer

FinSight is an informational tool over public filings. It is not investment
advice. Always verify figures against the original filing through the cited
source URL.
