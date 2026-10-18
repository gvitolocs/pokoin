-- A TCGplayer sale is not Pokoin sold-price evidence. The box lowers a
-- listing inside a transaction that sets
-- pokoin.listing_change_source = 'channel:…' (set local). Counting that
-- decrease as a Pokoin sale at price_pkn would put a TCGplayer price into
-- native sold stats and weights. This is the same split 092 made for
-- CardTrader mirrors (cardtrader_synced): the decrease is channel_synced.
--
-- Replaces marketplace_user_listings_audit, last defined in
-- 092_cardtrader_sale_dedupe.sql, with that one branch added after the
-- CardTrader link check. Does not rewrite historical rows.
-- Apply on the nezopt writer; the Pi replica follows.

create or replace function public.marketplace_user_listings_audit()
returns trigger
language plpgsql
as $$
declare
  ev text;
  card text;
  q_before integer;
  q_after integer;
  sold_qty integer := 0;
  is_new boolean := false;
  is_sold boolean := false;
  is_removed boolean := false;
  is_cardtrader_link boolean := false;
begin
  if tg_op = 'INSERT' then
    is_cardtrader_link := lower(coalesce(new.source_listing_id, '')) like 'ct:%';
    card := new.card_id;
    ev := 'listed';
    q_before := 0;
    q_after := coalesce(new.quantity_available, 0);
    is_new := true;
  elsif tg_op = 'DELETE' then
    is_cardtrader_link := lower(coalesce(old.source_listing_id, '')) like 'ct:%';
    card := old.card_id;
    q_before := coalesce(old.quantity_available, 0);
    q_after := 0;
    if lower(coalesce(old.status, '')) in ('sold_out', 'sold') or q_before > 0 then
      ev := 'sold';
      sold_qty := q_before;
      is_sold := true;
    else
      ev := 'removed';
      is_removed := true;
    end if;
  else
    is_cardtrader_link := lower(coalesce(new.source_listing_id, old.source_listing_id, '')) like 'ct:%';
    card := coalesce(new.card_id, old.card_id);
    q_before := coalesce(old.quantity_available, 0);
    q_after := coalesce(new.quantity_available, 0);
    if q_after < q_before then
      sold_qty := q_before - q_after;
      is_sold := true;
      ev := case
        when q_after = 0 or lower(coalesce(new.status, '')) in ('sold_out', 'sold')
        then 'sold'
        else 'quantity_decreased'
      end;
    elsif lower(coalesce(new.status, '')) in ('sold_out', 'sold')
      and lower(coalesce(old.status, '')) not in ('sold_out', 'sold') then
      ev := 'sold';
      sold_qty := greatest(q_before, 1);
      is_sold := true;
    elsif lower(coalesce(new.status, '')) in ('paused', 'cancelled', 'removed', 'inactive')
      and lower(coalesce(old.status, '')) = 'active' then
      ev := 'removed';
      is_removed := true;
    else
      ev := 'updated';
    end if;
  end if;

  if is_cardtrader_link and is_sold then
    ev := 'cardtrader_synced';
    sold_qty := 0;
    is_sold := false;
  end if;
  if is_sold and coalesce(current_setting('pokoin.listing_change_source', true), '') like 'channel:%' then
    ev := 'channel_synced';
    sold_qty := 0;
    is_sold := false;
  end if;

  if card is null or card = '' then
    return coalesce(new, old);
  end if;

  insert into public.marketplace_user_listing_events (
    listing_id,
    card_id,
    seller_uid,
    event_type,
    quantity_before,
    quantity_after,
    status_before,
    status_after,
    price_pkn,
    occurred_at
  )
  values (
    coalesce(new.id, old.id),
    card,
    coalesce(new.seller_uid, old.seller_uid, ''),
    ev,
    q_before,
    q_after,
    case when tg_op = 'INSERT' then null else old.status end,
    case when tg_op = 'DELETE' then old.status else new.status end,
    coalesce(new.price_pkn, old.price_pkn),
    now()
  );

  insert into public.marketplace_listing_stats_daily (
    card_id,
    observed_day,
    source,
    new_listings,
    new_quantity,
    sold_listings,
    sold_quantity,
    refreshed_at
  )
  values (
    card,
    (timezone('utc', now()))::date,
    'native',
    case when is_new then 1 else 0 end,
    case when is_new then q_after else 0 end,
    case when is_sold then 1 else 0 end,
    case when is_sold then sold_qty else 0 end,
    now()
  )
  on conflict (card_id, observed_day, source) do update set
    new_listings = public.marketplace_listing_stats_daily.new_listings + excluded.new_listings,
    new_quantity = public.marketplace_listing_stats_daily.new_quantity + excluded.new_quantity,
    sold_listings = public.marketplace_listing_stats_daily.sold_listings + excluded.sold_listings,
    sold_quantity = public.marketplace_listing_stats_daily.sold_quantity + excluded.sold_quantity,
    refreshed_at = now();

  if is_removed then
    null;
  end if;

  return coalesce(new, old);
end;
$$;
