function cleanBlueprintId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function cleanCartAction(value) {
  const action = String(value || '').trim().toLowerCase();
  if (['add', 'added', 'cart_add', 'add_to_cart'].includes(action)) {
    return 'add';
  }
  if (['remove', 'removed', 'cart_remove', 'remove_from_cart', 'clear'].includes(action)) {
    return 'remove';
  }
  return '';
}

function cleanHolderId(value) {
  const holderId = String(value || '').trim();
  return holderId ? holderId.slice(0, 128) : '';
}

function holderKeyFor({ userUid = '', anonymousId = '' } = {}) {
  const cleanUid = cleanHolderId(userUid);
  if (cleanUid) {
    return `uid:${cleanUid}`;
  }
  const cleanAnonymousId = cleanHolderId(anonymousId);
  if (cleanAnonymousId) {
    return `anon:${cleanAnonymousId}`;
  }
  return '';
}

function cartAnalyticsJoin(candidateAlias = 'c', analyticsAlias = 'cart_analytics') {
  return `
    left join public.marketplace_card_cart_analytics ${analyticsAlias}
      on (
        ${analyticsAlias}.blueprint_id = ${candidateAlias}.ct_id
        or ${analyticsAlias}.blueprint_id = ${candidateAlias}.card_id
      )
  `;
}

function cartHolderCountColumn(analyticsAlias = 'cart_analytics') {
  return `coalesce(${analyticsAlias}.cart_holder_count, 0) as cart_holder_count`;
}

function cartHolderCountFromRow(row = {}) {
  const value = Number(
    row.cart_holder_count ??
      row.cartHolderCount ??
      row.analytics?.cartHolderCount ??
      row.analytics?.cart_holder_count ??
      0,
  );
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

async function recordCartChange({
  query,
  cardId,
  action,
  userUid = '',
  anonymousId = '',
}) {
  const blueprintId = cleanBlueprintId(cardId);
  const cleanAction = cleanCartAction(action);
  const holderKey = holderKeyFor({ userUid, anonymousId });
  if (!blueprintId || !cleanAction || !holderKey) {
    const error = new Error('Invalid cart analytics payload.');
    error.statusCode = 400;
    throw error;
  }
  if (typeof query !== 'function') {
    throw new Error('A marketplace query function is required.');
  }

  const result = await recordHolderCartChange(query, blueprintId, cleanAction, holderKey);
  const row = result.rows?.[0] || {};
  return {
    cardId: String(blueprintId),
    action: cleanAction,
    changed: row.changed === true || row.changed === 1 || row.changed === '1',
    cartHolderCount: cartHolderCountFromRow(row),
    userScoped: holderKey.startsWith('uid:'),
  };
}

function recordHolderCartChange(query, blueprintId, action, holderKey) {
  if (action === 'add') {
    return query(
      `
        with membership as (
          insert into public.marketplace_card_cart_users (
            blueprint_id,
            holder_key,
            added_at,
            updated_at
          )
          values ($1, $2, now(), now())
          on conflict (blueprint_id, holder_key) do nothing
          returning 1
        ),
        aggregate as (
          insert into public.marketplace_card_cart_analytics (
            blueprint_id,
            cart_holder_count,
            first_added_at,
            last_added_at,
            updated_at
          )
          select $1, 1, now(), now(), now()
          where exists (select 1 from membership)
          on conflict (blueprint_id) do update set
            cart_holder_count = public.marketplace_card_cart_analytics.cart_holder_count + 1,
            first_added_at = coalesce(
              public.marketplace_card_cart_analytics.first_added_at,
              excluded.first_added_at
            ),
            last_added_at = excluded.last_added_at,
            updated_at = excluded.updated_at
          returning cart_holder_count
        )
        select
          coalesce(
            (select cart_holder_count from aggregate),
            (select cart_holder_count from public.marketplace_card_cart_analytics where blueprint_id = $1),
            0
          ) as cart_holder_count,
          exists (select 1 from membership) as changed
      `,
      [blueprintId, holderKey],
    );
  }

  return query(
    `
      with membership as (
        delete from public.marketplace_card_cart_users
        where blueprint_id = $1
          and holder_key = $2
        returning 1
      ),
      aggregate as (
        update public.marketplace_card_cart_analytics
        set
          cart_holder_count = greatest(0, cart_holder_count - 1),
          updated_at = now()
        where blueprint_id = $1
          and exists (select 1 from membership)
        returning cart_holder_count
      )
      select
        coalesce(
          (select cart_holder_count from aggregate),
          (select cart_holder_count from public.marketplace_card_cart_analytics where blueprint_id = $1),
          0
        ) as cart_holder_count,
        exists (select 1 from membership) as changed
    `,
    [blueprintId, holderKey],
  );
}

module.exports = {
  cartAnalyticsJoin,
  cartHolderCountColumn,
  cartHolderCountFromRow,
  cleanBlueprintId,
  cleanCartAction,
  cleanHolderId,
  holderKeyFor,
  recordCartChange,
};
