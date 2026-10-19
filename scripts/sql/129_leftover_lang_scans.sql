-- Language scans of western leftover printings (docs/CARD_LANGUAGE_SCANS.md).
-- One row per CardTrader leftover (ct_id) and language that has a TCGdex scan
-- of the same card: cdn.pokoin.com/tcgdex/{language}/{scan_path}.webp.
-- A western blueprint is one printing for every western language, so these
-- are pictures of that printing, not separate printings. Japanese, Korean and
-- Chinese print families are their own printings and never get a row here
-- (Codevira D000065, D000084).
--
-- Written by tools/lang-scans (mapping.tsv -> tools/lang-scans/load.sql);
-- read by the card rows in pokoin-rust apps/api catalog_api::cards. Additive;
-- idempotent. Apply on the nezopt writer as the migrator.

create table if not exists public.marketplace_leftover_lang_scans (
  ct_id bigint not null,
  language text not null,
  scan_path text not null,
  source text not null default 'tcgdex',
  loaded_at timestamptz not null default now(),
  primary key (ct_id, language),
  constraint marketplace_leftover_lang_scans_language
    check (language in ('it', 'fr', 'de', 'es', 'pt')),
  -- {serie}/{set}/{localId}, e.g. swsh/swsh3/136
  constraint marketplace_leftover_lang_scans_path
    check (scan_path ~ '^[A-Za-z0-9.-]+/[A-Za-z0-9.-]+/[A-Za-z0-9.-]+$')
);

comment on table public.marketplace_leftover_lang_scans is
  'TCGdex scan of a western leftover printing per language: cdn.pokoin.com/tcgdex/{language}/{scan_path}.webp';

-- Reads come from the API pools; the loader runs as pokoin_jobs once the
-- least-privilege roles (migration 124) exist. Until then every client is
-- the container superuser and these grants are skipped.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'pokoin_api_read') then
    grant select on public.marketplace_leftover_lang_scans to pokoin_api_read, pokoin_api_write;
  end if;
  if exists (select 1 from pg_roles where rolname = 'pokoin_jobs') then
    grant select, insert, update, delete on public.marketplace_leftover_lang_scans to pokoin_jobs;
  end if;
end $$;
