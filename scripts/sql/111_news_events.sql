-- Pokoin News first-party reading stats (POST /api/news-event, read by the
-- admin-only GET /api/news-stats behind pokoin.com/news/dashboard).
-- One row per beacon: list impressions and clicks, article views, scroll
-- milestones and active seconds before leaving. `visitor` is a daily salted
-- hash of ip + user agent; no raw ip, cookie or account id is stored.
-- Writes: nezopt marketplace writer (MARKETPLACE_WRITER_DATABASE_URL).
-- Pi replica streams — never migrate on the replica.

set statement_timeout = 0;

create table if not exists public.news_events (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  event_type text not null check (event_type in ('impression', 'click', 'view', 'read', 'leave')),
  article_id text not null,
  article_path text not null,
  pv text not null,
  visitor text not null,
  source text,
  position smallint,
  depth smallint,
  seconds integer
);

create index if not exists news_events_article_time_idx
  on public.news_events (article_id, created_at);

create index if not exists news_events_time_idx
  on public.news_events (created_at);
