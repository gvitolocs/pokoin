//! Where a seller's listing came from (docs/INVENTORY_ORIGIN.md). The SPA
//! twin is `market/src/inventory-origin.js`; both keep the same rules.

/// Every origin id, in the order the inventory filter lists them.
pub const ORIGINS: [&str; 6] = ["pokoin", "cardrails", "cardtrader", "cardmarket", "tcgplayer", "csv"];

/// The origin of one listing row. `cardrails_key`: the row was created by the
/// Card Rails Seller API connector (a `cardrails:` key in
/// `seller_api_listing_keys`), whose rows keep the default `source`.
/// A `ct:` source listing id alone says nothing: Pokoin rows pushed to
/// CardTrader carry one too.
pub fn listing_origin(source: &str, source_listing_id: &str, cardrails_key: bool) -> &'static str {
    if cardrails_key {
        return "cardrails";
    }
    let source = source.trim().to_ascii_lowercase();
    let id = source_listing_id.trim().to_ascii_lowercase();
    match source.as_str() {
        "cardtrader_seller_import" | "cardtrader_csv_import" | "cardtrader_live" | "cardtrader" => "cardtrader",
        "powertools_csv_import" | "cardmarket_csv_import" => "cardmarket",
        "tcgplayer_csv_import" => "tcgplayer",
        "stock_csv_import" => "csv",
        _ if id.starts_with("pt:") || id.starts_with("cm:") => "cardmarket",
        _ if id.starts_with("tp:") => "tcgplayer",
        _ => "pokoin",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_card_rails_key_wins_over_the_default_source() {
        assert_eq!(listing_origin("pokoin_user_listing", "", true), "cardrails");
        assert_eq!(listing_origin("pokoin_user_listing", "ct:991", true), "cardrails");
        assert_eq!(listing_origin("", "", true), "cardrails");
    }

    #[test]
    fn cardtrader_sources_map_to_cardtrader() {
        for source in ["cardtrader_seller_import", "cardtrader_csv_import", "cardtrader_live", "cardtrader", " CardTrader_Live "] {
            assert_eq!(listing_origin(source, "ct:1", false), "cardtrader", "{source}");
        }
        assert_eq!(listing_origin("cardtrader_csv_import", "", false), "cardtrader");
    }

    #[test]
    fn cardmarket_comes_from_power_tools_or_cardmarket_csv() {
        assert_eq!(listing_origin("powertools_csv_import", "", false), "cardmarket");
        assert_eq!(listing_origin("cardmarket_csv_import", "", false), "cardmarket");
        assert_eq!(listing_origin("", "pt:123", false), "cardmarket");
        assert_eq!(listing_origin("pokoin_user_listing", "CM:9", false), "cardmarket");
    }

    #[test]
    fn tcgplayer_and_plain_csv() {
        assert_eq!(listing_origin("tcgplayer_csv_import", "", false), "tcgplayer");
        assert_eq!(listing_origin("", "tp:5", false), "tcgplayer");
        assert_eq!(listing_origin("stock_csv_import", "", false), "csv");
    }

    #[test]
    fn everything_else_is_pokoin_and_ct_alone_changes_nothing() {
        assert_eq!(listing_origin("pokoin_scan_batch", "scan:1", false), "pokoin");
        assert_eq!(listing_origin("pokoin_user_listing", "", false), "pokoin");
        assert_eq!(listing_origin("", "", false), "pokoin");
        assert_eq!(listing_origin("something_new", "", false), "pokoin");
        assert_eq!(listing_origin("pokoin_user_listing", "ct:4242", false), "pokoin");
        assert_eq!(listing_origin("pokoin_scan_batch", "ct:4242", false), "pokoin");
    }

    #[test]
    fn every_answer_is_a_known_origin() {
        for (source, id, key) in [("cardtrader", "", false), ("", "pt:1", false), ("", "", true), ("x", "y", false)] {
            assert!(ORIGINS.contains(&listing_origin(source, id, key)));
        }
    }
}
