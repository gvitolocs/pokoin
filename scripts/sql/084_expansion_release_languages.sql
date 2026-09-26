-- Languages each expansion was actually published in.
-- Source: TCGdex set indexes (https://api.tcgdex.net/v2/{lang}/sets).
-- A set id listed under a language was released in that language.
-- Japanese 151 (sv2a) is a different expansion from English 151 (sv03.5).

create table if not exists public.expansion_release_languages (
  expansion_id integer not null,
  language text not null,
  source text not null default 'tcgdex',
  source_id text not null default '',
  updated_at timestamptz not null default now(),
  primary key (expansion_id, language),
  constraint expansion_release_languages_language_check check (language = any (array[
    'EN','IT','FR','DE','ES','PT','NL','PL','RU','JP','KO','ZH','ZHT','ID','TH','VI'
  ]::text[]))
);

comment on table public.expansion_release_languages is
  'Print languages TCGdex has published for an expansion. Not display-name translations.';
