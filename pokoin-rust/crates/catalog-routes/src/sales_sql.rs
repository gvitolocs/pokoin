//! GET /api/marketplace-card-sales — CardTrader historical sold graph.
//!
//! Reference (read-only): `.reference-node/api/marketplace-card-sales.js`.
//! This is the CardTrader `cardtrader_removed_sale` / `cardtrader_sold_daily`
//! read model. Native Pokoin order sales are NOT substituted: `includeNative`
//! is a Firebase/Firefox-era path with no native equivalent here, so the Rust
//! handler keeps only the authoritative Oracle (Postgres) side.

use std::collections::BTreeMap;

use serde_json::Value;

use crate::util::*;

pub const SOLD_CONDITION_ORDER: [&str; 5] = ["NM", "SP", "MP", "PL", "Poor"];
pub const SOLD_LANGUAGE_ORDER: [&str; 16] = [
    "EN", "IT", "JP", "FR", "DE", "ES", "KO", "ZH", "ZHT", "PT", "NL", "PL", "RU", "ID", "TH", "VI",
];

/// Public cardId is leftover ct_id x 2, so it can collide with another blueprint.
/// Prefer our card_id; leftover ct_id only when that number is not a card_id.
pub const SALES_BLUEPRINT_SQL: &str = "
  select ct_id
  from public.marketplace_search_candidates
  where card_id = $1::bigint
     or ct_id = $1::bigint
  order by
    case when card_id = $1::bigint then 0 else 1 end,
    card_id
  limit 1
";

/// Condition normalization for raw CardTrader leftover strings.
pub const SOLD_CONDITION_SQL: &str = "
  case
    when lower(btrim(coalesce(condition, ''))) in ('nm', 'mint', 'near mint', 'near mint foil') then 'NM'
    when lower(btrim(coalesce(condition, ''))) in ('sp', 'slightly played', 'lightly played', 'lp', 'excellent', 'ex') then 'SP'
    when lower(btrim(coalesce(condition, ''))) in ('mp', 'moderately played', 'played good', 'good', 'gd') then 'MP'
    when lower(btrim(coalesce(condition, ''))) in ('poor', 'po', 'damaged', 'dmg') then 'Poor'
    when lower(btrim(coalesce(condition, ''))) in ('pl', 'played', 'poor played') then 'PL'
    else nullif(btrim(condition), '')
  end
";

pub const SOLD_LANGUAGE_SQL: &str = "
  case
    when lower(btrim(coalesce(language, ''))) in ('en', 'english') then 'EN'
    when lower(btrim(coalesce(language, ''))) in ('it', 'italian') then 'IT'
    when lower(btrim(coalesce(language, ''))) in ('fr', 'french') then 'FR'
    when lower(btrim(coalesce(language, ''))) in ('de', 'german') then 'DE'
    when lower(btrim(coalesce(language, ''))) in ('es', 'spanish') then 'ES'
    when lower(btrim(coalesce(language, ''))) in ('jp', 'ja', 'japanese') then 'JP'
    when lower(btrim(coalesce(language, ''))) in ('pt', 'portuguese') then 'PT'
    when lower(btrim(coalesce(language, ''))) in ('nl', 'dutch') then 'NL'
    when lower(btrim(coalesce(language, ''))) in ('pl', 'polish') then 'PL'
    when lower(btrim(coalesce(language, ''))) in ('ru', 'russian') then 'RU'
    when lower(btrim(coalesce(language, ''))) in ('ko', 'kr', 'korean') then 'KO'
    when lower(btrim(coalesce(language, ''))) in ('zh-tw', 'zht', 'zh_hant', 'zh-hant') then 'ZHT'
    when lower(btrim(coalesce(language, ''))) in ('zh', 'zh-cn', 'zh_hans', 'zh-hans', 'chinese') then 'ZH'
    when lower(btrim(coalesce(language, ''))) in ('id', 'indonesian', 'indonesia') then 'ID'
    else nullif(upper(btrim(language)), '')
  end
";

/// Inferred_sale listing ids that only appear on one day. Repeats are snapshot flicker.
pub const SOLD_ONCE_LISTING_SQL: &str = "
  (
    split_part(source_item_id, ':', 4) = 'quantity_decreased'
    or split_part(source_item_id, ':', 2) in (
      select split_part(source_item_id, ':', 2)
      from public.marketplace_price_observations
      where source = 'cardtrader_removed_sale'
        and split_part(source_item_id, ':', 4) is distinct from 'quantity_decreased'
      group by 1
      having count(distinct (observed_at at time zone 'utc')::date) = 1
    )
  )
";
