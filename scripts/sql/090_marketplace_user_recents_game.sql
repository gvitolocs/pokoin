-- Game-scoped recently seen. One card_ids[] per (user_uid, game).
-- Writes: nezopt marketplace writer (MARKETPLACE_WRITER_DATABASE_URL).
-- Pi replica streams — never migrate on the replica.
--
-- Legacy unscoped rows (no game column / empty game) are ambiguous and may
-- mix TCGs. Discard them. Do NOT assign game='pokemon'.

set statement_timeout = 0;

alter table public.marketplace_user_recents
  add column if not exists game text;

-- Ambiguous / unscoped history only.
delete from public.marketplace_user_recents
 where game is null or btrim(game) = '';

alter table public.marketplace_user_recents
  alter column game set default 'pokemon';

-- After the delete, remaining rows (if any) already have a real game value.
-- Empty table is fine — Recently Seen is disposable UX state.
do $$
begin
  if exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'marketplace_user_recents'
       and column_name = 'game'
       and is_nullable = 'YES'
  ) then
    -- Any leftover nulls are unscoped; drop them before NOT NULL.
    delete from public.marketplace_user_recents where game is null;
    alter table public.marketplace_user_recents
      alter column game set not null;
  end if;
end $$;

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
