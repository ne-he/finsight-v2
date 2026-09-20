-- Hybrid retrieval, executed inside the database.
--
-- v1 did this in Python: it loaded the whole index into memory, ran a NumPy
-- cosine search and a BM25 search, fused the two rankings with Reciprocal Rank
-- Fusion, and filtered by company afterwards. That design cannot survive on
-- serverless, where a process may handle one request and disappear.
--
-- So the fusion moves into SQL. One round trip, nothing held in memory between
-- requests, and the company/year filter is applied INSIDE the ranking rather
-- than after it. The v1 Supabase path filtered client-side and therefore could
-- return fewer than k usable rows; this cannot.
--
-- Two honest differences from v1, both of which change the numbers:
--   1. The keyword arm is Postgres `ts_rank_cd`, not BM25. Same idea, different
--      scoring, so rankings will not match v1 exactly.
--   2. There is no cross-encoder reranking stage.
-- Neither is a reason to reuse v1's measured results. Re-run the eval harness.

create or replace function fs_match_chunks(
  query_embedding  vector(768),
  query_text       text,
  filter_tickers   text[] default '{}',
  filter_years     text[] default '{}',
  k_dense          int default 10,
  k_sparse         int default 10,
  rrf_k            int default 60,
  final_k          int default 6
)
returns table (
  chunk_id     text,
  content      text,
  ticker       text,
  company      text,
  fiscal_year  text,
  section      text,
  source_url   text,
  similarity   real,
  rrf_score    real,
  top_cosine   real
)
language sql
stable
as $$
with q as (
  select websearch_to_tsquery('english', coalesce(query_text, '')) as tsq
),
dense as (
  select
    c.chunk_id as id,
    (1 - (c.embedding <=> query_embedding))::real as sim,
    row_number() over (order by c.embedding <=> query_embedding) as rnk
  from fs_chunks c
  where c.embedding is not null
    and (coalesce(cardinality(filter_tickers), 0) = 0 or c.ticker = any (filter_tickers))
    and (coalesce(cardinality(filter_years), 0) = 0 or c.fiscal_year = any (filter_years))
  order by c.embedding <=> query_embedding
  limit k_dense
),
sparse as (
  select
    c.chunk_id as id,
    row_number() over (order by ts_rank_cd(c.fts, q.tsq) desc) as rnk
  from fs_chunks c
  cross join q
  where numnode(q.tsq) > 0
    and c.fts @@ q.tsq
    and (coalesce(cardinality(filter_tickers), 0) = 0 or c.ticker = any (filter_tickers))
    and (coalesce(cardinality(filter_years), 0) = 0 or c.fiscal_year = any (filter_years))
  order by ts_rank_cd(c.fts, q.tsq) desc
  limit k_sparse
),
fused as (
  -- A full outer join keeps chunks that only one arm found. That is the whole
  -- point of hybrid search: the dense arm catches paraphrases, the keyword arm
  -- catches exact tickers and accounting terms, and neither alone is enough.
  select
    coalesce(d.id, s.id) as id,
    coalesce(d.sim, 0)::real as sim,
    (coalesce(1.0 / (rrf_k + d.rnk), 0) + coalesce(1.0 / (rrf_k + s.rnk), 0))::real as score
  from dense d
  full outer join sparse s on s.id = d.id
)
select
  f.id,
  c.content,
  c.ticker,
  c.company,
  c.fiscal_year,
  c.section,
  c.source_url,
  f.sim,
  f.score,
  -- The confidence gate keys off the best DENSE cosine, measured before
  -- fusion, so it stays comparable to v1 even though the fused ordering is
  -- different. Returned on every row because a set-returning SQL function has
  -- nowhere else to put a scalar.
  (select coalesce(max(d2.sim), 0)::real from dense d2) as top_cosine
from fused f
join fs_chunks c on c.chunk_id = f.id
order by f.score desc, f.sim desc
limit final_k;
$$;

-- The anon key may call this: RLS still restricts which rows the caller can
-- see, and the function is STABLE, so it cannot write anything.
grant execute on function fs_match_chunks(vector, text, text[], text[], int, int, int, int)
  to anon, authenticated;
