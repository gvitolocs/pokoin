-- Game-scoped recently seen. One card_ids[] per (user_uid, game).
-- Writes stay on the nezopt marketplace writer; Pi replica streams.
-- Legacy unscoped rows become game = 'pokemon' (disposable UX history).
-- Mirror of cardvault oracle-postgres/schema/090_marketplace_user_recents_game.sql.

set statement_timeout = 0;

alter table public.marketplace_user_recents
  add column if not exists game text;

update public.marketplace_user_recents
   set game = 'pokemon'
 where game is null or btrim(game) = '';

alter table public.marketplace_user_recents
  alter column game set default 'pokemon';

alter table public.marketplace_user_recents
  alter column game set not null;

do $$
begin
  if exists (
    select 1
      from pg_constraint
     where conrelid = 'public.marketplace_user_recents'::regclass
       and contype = 'p'
       and conname = 'marketplace_user_recents_pkey'
  ) then
    alter table public.marketplace_user_recents
      drop constraint marketplace_user_recents_pkey;
  end if;
end $$;

alter table public.marketplace_user_recents
  add primary key (user_uid, game);

create index if not exists marketplace_user_recents_game_updated_idx
  on public.marketplace_user_recents (game, updated_at desc);
