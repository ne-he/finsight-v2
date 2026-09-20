# FinSight v2

A retrieval-augmented question answering system over SEC 10-K filings. Ask what
a public company said about its risks, segments or revenue drivers, and get an
answer built only from the filing text, cited down to the section, or an honest
refusal when the documents do not support one.

v2 is a rewrite of [the original Python system](https://github.com/ne-he/RAG_businessAnalysis_assist)
as a single Next.js application on Vercel, with Supabase for authentication,
conversation history and vector search.

> **Status: working locally, not deployed.** Sign in, ask, history and admin
> ingest all run against a live database. Retrieval quality is measured on this
> implementation, not inherited. See [What is not done yet](#what-is-not-done-yet).

---

## Why it is not a chatbot wrapper

| Concern | A naive wrapper | FinSight |
|---|---|---|
| Source of facts | The model's memory, stale and unattributable | Retrieved 10-K excerpts only |
| Document structure | Raw text, blind splitting | Section-aware chunking per 10-K Item |
| Retrieval | One vector search | Hybrid vector plus full-text, fused with RRF |
| Targeting | One global search | Company and fiscal year filters applied inside the ranking |
| Citations | None, or invented | Exact: `[NVDA FY2026 * Item 1A. Risk Factors]` plus source URL |
| Hallucination control | Hope | A confidence gate tuned from measured data |
| When the model is down | An error, or silence | A degraded answer quoted from the retrieved passages |
| Quality | "Looks fine" | An eval harness over a golden set |

---

## Measured results

Corpus: NVDA FY2026 and AAPL FY2025, 582 chunks. Golden set of 18 questions,
`gemini-embedding-001` at 768 dimensions, k = 6. Run with `npm run eval`, full
report in [`evals/results/`](evals/results).

| Metric | Result | What it shows |
|---|---|---|
| Retrieval hit-rate@6 | **13/14** | The right company's filing reaches the top 6 |
| Out-of-scope gate accuracy | **4/4** | Unanswerable questions are refused, not guessed |
| False refusals | **0** | The gate never blocked a question the corpus could answer |
| Mean top cosine | **0.765** | Healthy distance above the 0.68 gate |
| Answerable cosine range | 0.722 to 0.808 | |
| Out-of-scope cosine range | 0.472 to 0.612 | A clean gap of 0.110 |

The threshold is chosen from that gap rather than guessed, and this run
confirms 0.68 still sits inside it on the new retriever.

**The one miss is worth naming.** `Compare the revenue drivers of NVIDIA and
Apple` retrieved only NVIDIA. Comparison questions have to win slots for two
companies inside one top 6, and they are the first thing to break whenever
retrieval is tuned. The same question class was what failed in v1 when chunk
overlap was changed, so it stays in the golden set as an early warning.

Cross-language retrieval is also measured, not asserted: two questions written
in Indonesian both routed to the correct filing, and the answer comes back in
Indonesian with English citations intact.

Answer faithfulness is not measured yet. Judging it needs generation quota the
free tier does not have in one sitting.

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

Measured on real filings: NVIDIA FY2026 produced 362 chunks in 404 seconds,
Apple FY2025 produced 220 chunks in 237 seconds.

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
editor. Then check the setup before trusting it:

```bash
npm run verify     # tables, policies, functions, credentials, neighbours
npm run dev        # http://localhost:3000
```

The first account to sign up becomes the administrator, so a fresh deployment
is usable without opening the SQL editor. Every later account is an ordinary
user; `npm run promote -- someone@example.com` changes that.

### Everyday commands

| Command | What it does |
|---|---|
| `npm run verify` | Reports whether the environment and database are ready |
| `npm run inspect -- NVDA` | Parses a real filing and reports sections and chunks, no quota spent |
| `npm run ingest -- NVDA AAPL` | Ingests from the command line, useful for seeding |
| `npm run eval -- --write` | Measures retrieval and writes a dated report |
| `npm test` | Unit tests, offline |
| `npm run typecheck` / `npm run lint` / `npm run build` | The checks CI runs |

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
    auth.ts · guards.ts  who is calling, and whether they may
    ingest.ts            the ingest state machine
    supabase/            browser, user-session and service-role clients
    rag/
      edgar.ts           SEC lookup and HTML to text
      sections.ts        10-K Item detection
      chunking.ts        paragraph-aware chunking with overlap
      filters.ts         which company and year a question is about
      prompt.ts          system prompt, context wrapping, degraded answer
      retrieve.ts        hybrid search and the confidence gate
  app/                   pages, and api/ for chat, health, keep-alive, admin, feedback
  components/            nav, auth form, chat view, ingest panel
supabase/migrations/     schema, RLS policies, search function, rate limit, bootstrap
scripts/                 verify, inspect, ingest, eval, promote
evals/                   golden set and dated result reports
tests/                   Vitest, offline
docs/ARCHITECTURE.md     decisions and trade-offs
```

---

## What is not done yet

Listed rather than implied, because a README that reads as finished when the
project is not is the easiest kind of documentation to get wrong.

- **Not deployed.** No Vercel project is linked, so there is no public URL.
- **Answer faithfulness is unmeasured.** Retrieval is; generation quality is not.
- **One comparison question misses.** See [Measured results](#measured-results).
- **No integration tests** against a live database. Unit tests cover the pure
  logic; the database path is covered by `npm run verify` and the eval harness,
  which are run deliberately rather than in CI.
- **Prompt injection is unmitigated.** Filing text from SEC is placed in the
  model's context. That is a low-risk source, but the system prompt is not a
  security boundary.

---

## Disclaimer

FinSight is an informational tool over public filings. It is not investment
advice. Always verify figures against the original filing through the cited
source URL.
