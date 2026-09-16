-- Caption-bar color sampled from the leftover illustration window.
-- One row per leftover ct_id. SPA album tiles read this; they do not
-- average pixels in the browser.

set statement_timeout = 0;

create table if not exists public.marketplace_leftover_art_shades (
  ct_id bigint primary key,
  shade text not null,
  sampled_at timestamptz not null default now(),
  constraint marketplace_leftover_art_shades_hex
    check (shade ~ '^#[0-9a-f]{6}$')
);

create index if not exists marketplace_leftover_art_shades_sampled_idx
  on public.marketplace_leftover_art_shades (sampled_at desc);
