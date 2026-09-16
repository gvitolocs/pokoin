-- CLIP artwork layout: window vs full-bleed vs landscape.
-- One label per pokoin_version_sets key (JP/CN reprints of the same painting).
-- Mixed clusters (Prize Pack FA sitting on an Ultra Rare pin) override per leftover.

set statement_timeout = 0;

alter table public.pokoin_version_sets
  add column if not exists art_layout text not null default '';

alter table public.pokoin_version_sets
  add column if not exists art_layout_source text not null default '';

alter table public.marketplace_search_candidates
  add column if not exists art_layout text not null default '';

create table if not exists public.marketplace_leftover_art_layouts (
  ct_id bigint primary key,
  layout text not null,
  source text not null default '',
  version text not null default '',
  sampled_at timestamptz not null default now(),
  constraint marketplace_leftover_art_layouts_layout
    check (layout in ('window', 'bleed', 'landscape', 'halfart'))
);

create index if not exists marketplace_leftover_art_layouts_version_idx
  on public.marketplace_leftover_art_layouts (version);

grant select, insert, update, delete on public.marketplace_leftover_art_layouts
  to pokoin_marketplace;
