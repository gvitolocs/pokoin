-- Display names for title language (LangToggle), not print language.
-- English identity stays on pokoin_pokemon_blueprints.name /
-- pokoin_pokemon_expansions.name / the printed rarity key.
-- Tall tables: match TCGDex / pokemontcg English names, then store the
-- localized string. Do not add name_it columns. marketplace_card_names_*
-- stay the search lexicon.

set statement_timeout = 0;

create table if not exists public.card_name_languages (
  name text not null,
  language text not null,
  localized_name text not null,
  source text not null default '',
  source_id text not null default '',
  updated_at timestamptz not null default now(),
  primary key (name, language),
  constraint card_name_languages_language_check
    check (language = any (array[
      'en','it','fr','de','es','jp','pt','nl','pl','ru','ko','zh','zht','id','th','vi'
    ])),
  constraint card_name_languages_name_check check (name <> ''),
  constraint card_name_languages_localized_check check (localized_name <> '')
);

create index if not exists card_name_languages_language_idx
  on public.card_name_languages (language, localized_name);

create table if not exists public.rarity_languages (
  rarity text not null,
  language text not null,
  localized_name text not null,
  source text not null default '',
  source_id text not null default '',
  updated_at timestamptz not null default now(),
  primary key (rarity, language),
  constraint rarity_languages_language_check
    check (language = any (array[
      'en','it','fr','de','es','jp','pt','nl','pl','ru','ko','zh','zht','id','th','vi'
    ])),
  constraint rarity_languages_rarity_check check (rarity <> ''),
  constraint rarity_languages_localized_check check (localized_name <> '')
);

create index if not exists rarity_languages_language_idx
  on public.rarity_languages (language, localized_name);

-- expansion_id is unique when present (partial unique index on
-- pokoin_pokemon_expansions). Postgres cannot FK a partial unique index.
create table if not exists public.expansion_languages (
  expansion_id integer not null,
  language text not null,
  localized_name text not null,
  source text not null default '',
  source_id text not null default '',
  updated_at timestamptz not null default now(),
  primary key (expansion_id, language),
  constraint expansion_languages_language_check
    check (language = any (array[
      'en','it','fr','de','es','jp','pt','nl','pl','ru','ko','zh','zht','id','th','vi'
    ])),
  constraint expansion_languages_localized_check check (localized_name <> '')
);

create index if not exists expansion_languages_language_idx
  on public.expansion_languages (language, localized_name);
