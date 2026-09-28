-- Western leftover PP-OCRv5 card chrome for Poko card_ocr.
-- Public card_id is leftover (ct_id) × 2. Apply on the marketplace writer
-- only; replica follows. Do not ingest from a deploy that restarts the
-- shared Pi API while Honcho hermes-peer1 / poko-peer1 are live.

create table if not exists public.marketplace_card_ocr (
  card_id text primary key,
  leftover_id bigint not null,
  name text,
  set_name text,
  card_number text,
  text text not null,
  junk boolean not null default false,
  ok boolean not null default true,
  engine text,
  crop text,
  line_count integer,
  updated_at timestamptz not null default now()
);

create index if not exists marketplace_card_ocr_leftover_idx
  on public.marketplace_card_ocr (leftover_id);

comment on table public.marketplace_card_ocr is
  'Approximate western leftover OCR (attacks/rules/HP). Not official card text.';
