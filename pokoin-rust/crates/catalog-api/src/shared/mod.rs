//! Shared helpers of the catalog BFFs — faithful ports of the live Node
//! `api/_*.js` modules (one Rust module per JS file, same function names in
//! snake_case). The route modules in `pages/`, `reads/` and `market/` build
//! on this API.
//!
//! | Module | Node source | Provides |
//! | --- | --- | --- |
//! | [`js`] | (semantics glue) | `Number`/`String`/`\|\|`/`??`/`slice` over `serde_json::Value` rows |
//! | [`sql_json`] | (plumbing) | verbatim SQL executed as `to_jsonb` rows |
//! | [`row`] | `_marketplace_row.js` | `normalize_marketplace_row`, `rewrite_cdn_pokoin_prefix`, `is_market_available`, … |
//! | [`react_card`] | `_marketplace_react_card.js` | `to_react_card(s)`, image picking, parsers, `json_ok`, `with_timeout` |
//! | [`react_sql`] | `_marketplace_react_sql.js` | every indexed catalog lookup + the canonical/cheapest overlay |
//! | [`slug`] | `_slug.js` | `slug_part`, `slug_parts`, `slugify` |
//! | [`card_emoji`] | `_marketplace_card_emoji.js` | `card_emoji_fields`, `with_card_emoji_fields` |
//! | [`card_rarity`] | `_marketplace_card_rarity.js` | `projected_rarity_sql` |
//! | [`canonical_path`] | `_marketplace_canonical_path.js` | `canonical_path_for_row`, `public_card_id_for_row` |
//! | [`public_canonical_path`] | `_public_canonical_path.js` | `public_canonical_path` |
//! | [`artist_display`] | `_artist_display.js` | display names + lookup/slug aliases |
//! | [`artist_summary`] | `_artist_summary.js` | `marketplace_artist_summary` read |
//! | [`image_log`] | `_marketplace_image_log.js` | the served-image ring + `marketplace-image` log |
//! | [`rails`] | `_marketplace_rails.js` | `read_rails`, `read_tiles`, `publicize_cards`, `assemble_home_vector`, `with_theme_packs` |
//! | [`home_recent`] | `_marketplace_home_recent.js` | `merge_recent_into_home`, `recent_ids_from_url` |
//! | [`card_visual_theme`] | `_card_visual_theme.js` | shade → OKLCH desk palette, `pack_visual_theme` |
//! | [`cache`] | `_redis_ns.js` + `_redis_cache.js` + `_read_model_cache.js` | key namespaces, fail-open Redis ops, generation-scoped read cache, `coalesce` |
//! | [`timing`] | `_request_timing.js` | per-request span + slow-request log |
//! | [`expansions`] | `marketplace-expansions.js` (loaders) | `rows_for_expansions`, `snapshot_for_expansion` |
//! | [`card_versions`] | `marketplace-card-versions.js` + the availability fragments of `marketplace-cards.js` | `rows_for_versions`, `candidate_rows_for_card_id` |
//!
//! Rows are `serde_json::Value` objects, exactly what `to_jsonb(row)` yields.
//! SQL functions take `&PgPool` (the request game's pool; `pokemon` reads the
//! replica via `state.api.read()`) and an explicit `is_pokemon` flag where the
//! Node helpers branched on `isPokemonGame()`. Redis helpers are fail-open.

pub mod artist_display;
pub mod artist_summary;
pub mod cache;
pub mod canonical_path;
pub mod card_emoji;
pub mod card_rarity;
pub mod card_versions;
pub mod card_visual_theme;
pub mod expansions;
pub mod home_recent;
pub mod image_log;
pub mod js;
pub mod public_canonical_path;
pub mod rails;
pub mod react_card;
pub mod react_sql;
pub mod row;
pub mod slug;
pub mod sql_json;
pub mod timing;
