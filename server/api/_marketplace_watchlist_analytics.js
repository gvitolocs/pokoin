function cleanBlueprintId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function cleanWatchlistAction(value) {
  const action = String(value || '').trim().toLowerCase();
  if (['add', 'added', 'watch', 'watchlist_add'].includes(action)) {
    return 'add';
  }
  if (['remove', 'removed', 'unwatch', 'watchlist_remove'].includes(action)) {
    return 'remove';
  }
  return '';
}

function cleanUserUid(value) {
  const uid = String(value || '').trim();
  return uid ? uid.slice(0, 128) : '';
}

function watchlistAnalyticsJoin(candidateAlias = 'c', analyticsAlias = 'watchlist_analytics') {
  return `
    left join public.marketplace_card_watchlist_analytics ${analyticsAlias}
      on (
        ${analyticsAlias}.blueprint_id = ${candidateAlias}.ct_id
        or ${analyticsAlias}.blueprint_id = ${candidateAlias}.card_id
      )
  `;
}

function watchlistCountColumn(analyticsAlias = 'watchlist_analytics') {
  return `coalesce(${analyticsAlias}.watchlist_count, 0) as watchlist_count`;
}

function watchlistCountFromRow(row = {}) {
  const value = Number(
    row.watchlist_count ??
      row.watchlistCount ??
      row.analytics?.watchlistCount ??
      0,
  );
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

async function recordWatchlistChange({
  query,
  cardId,
  action,
  userUid = '',
}) {
  const blueprintId = cleanBlueprintId(cardId);
  const cleanAction = cleanWatchlistAction(action);
  const cleanUid = cleanUserUid(userUid);
  if (!blueprintId || !cleanAction) {
    const error = new Error('Invalid watchlist analytics payload.');
    error.statusCode = 400;
    throw error;
  }
  if (typeof query !== 'function') {
    throw new Error('A marketplace query function is required.');
  }

  const result = cleanUid
    ? await recordSignedInWatchlistChange(query, blueprintId, cleanAction, cleanUid)
    : await recordAnonymousWatchlistChange(query, blueprintId, cleanAction);
  const row = result.rows?.[0] || {};
  return {
    cardId: String(blueprintId),
    action: cleanAction,
    changed: row.changed === true || row.changed === 1 || row.changed === '1',
    watchlistCount: watchlistCountFromRow(row),
    userScoped: Boolean(cleanUid),
  };
}

function recordSignedInWatchlistChange(query, blueprintId, action, userUid) {
  if (action === 'add') {
    return query(
      `
        with membership as (
          insert into public.marketplace_card_watchlist_users (
            blueprint_id,
            user_uid,
            added_at,
            updated_at
          )
          values ($1, $2, now(), now())
          on conflict (blueprint_id, user_uid) do nothing
          returning 1
        ),
        aggregate as (
          insert into public.marketplace_card_watchlist_analytics (
            blueprint_id,
            watchlist_count,
            first_watchlisted_at,
            last_watchlisted_at,
            updated_at
          )
          select $1, 1, now(), now(), now()
          where exists (select 1 from membership)
          on conflict (blueprint_id) do update set
            watchlist_count = public.marketplace_card_watchlist_analytics.watchlist_count + 1,
            first_watchlisted_at = coalesce(
              public.marketplace_card_watchlist_analytics.first_watchlisted_at,
              excluded.first_watchlisted_at
            ),
            last_watchlisted_at = excluded.last_watchlisted_at,
            updated_at = excluded.updated_at
          returning watchlist_count
        )
        select
          coalesce(
            (select watchlist_count from aggregate),
            (select watchlist_count from public.marketplace_card_watchlist_analytics where blueprint_id = $1),
            0
          ) as watchlist_count,
          exists (select 1 from membership) as changed
      `,
      [blueprintId, userUid],
    );
  }

  return query(
    `
      with membership as (
        delete from public.marketplace_card_watchlist_users
        where blueprint_id = $1
          and user_uid = $2
        returning 1
      ),
      aggregate as (
        update public.marketplace_card_watchlist_analytics
        set
          watchlist_count = greatest(0, watchlist_count - 1),
          updated_at = now()
        where blueprint_id = $1
          and exists (select 1 from membership)
        returning watchlist_count
      )
      select
        coalesce(
          (select watchlist_count from aggregate),
          (select watchlist_count from public.marketplace_card_watchlist_analytics where blueprint_id = $1),
          0
        ) as watchlist_count,
        exists (select 1 from membership) as changed
    `,
    [blueprintId, userUid],
  );
}

function recordAnonymousWatchlistChange(query, blueprintId, action) {
  if (action === 'add') {
    return query(
      `
        insert into public.marketplace_card_watchlist_analytics (
          blueprint_id,
          watchlist_count,
          first_watchlisted_at,
          last_watchlisted_at,
          updated_at
        )
        values ($1, 1, now(), now(), now())
        on conflict (blueprint_id) do update set
          watchlist_count = public.marketplace_card_watchlist_analytics.watchlist_count + 1,
          first_watchlisted_at = coalesce(
            public.marketplace_card_watchlist_analytics.first_watchlisted_at,
            excluded.first_watchlisted_at
          ),
          last_watchlisted_at = excluded.last_watchlisted_at,
          updated_at = excluded.updated_at
        returning watchlist_count, true as changed
      `,
      [blueprintId],
    );
  }

  return query(
    `
      update public.marketplace_card_watchlist_analytics
      set
        watchlist_count = greatest(0, watchlist_count - 1),
        updated_at = now()
      where blueprint_id = $1
      returning watchlist_count, true as changed
    `,
    [blueprintId],
  );
}

module.exports = {
  cleanBlueprintId,
  cleanWatchlistAction,
  cleanUserUid,
  recordWatchlistChange,
  watchlistAnalyticsJoin,
  watchlistCountColumn,
  watchlistCountFromRow,
};
