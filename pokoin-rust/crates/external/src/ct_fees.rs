//! CardTrader's seller commission, taken out of a CardTrader ask.
//!
//! A CardTrader ask (`price_cents` of `/marketplace/products`, the listing
//! books, the PKP3 price file) is the price the seller set. The buyer pays it
//! plus CardTrader Safeguard (a fixed fee per item, €0.09–€0.64 by price);
//! the seller receives it minus CardTrader's commission plus VAT on that
//! commission. Pokoin compares a Pokoin price with what a seller **nets** on
//! CardTrader, so every CardTrader comp is the ask net of that commission:
//!
//! ```text
//! fee_cents = max(1, ask_cents × rate)          (rate: 5 % direct, 7 % CardTrader Zero)
//! net_cents = ask_cents − fee_cents × (1 + VAT) (VAT: 22 %, Italy)
//! ```
//!
//! Source: CardTrader "Payments, fees and refunds"
//! (static.cardtrader.com/en/pages/payments-fees-and-refunds, read
//! 2026-10-21): EU sellers pay 5.0 % per item sold directly and 7.0 % per item
//! sold through CardTrader Zero, minimum 1 cent, VAT added (subscriptions
//! before March 2026, guaranteed to active sellers until 2026-12-31; 5.3 % and
//! 7.3 % for newer ones). The rates are environment settings because they
//! change: `CARDTRADER_FEE_DIRECT_PCT`, `CARDTRADER_FEE_ZERO_PCT`,
//! `CARDTRADER_FEE_VAT_PCT`.
//!
//! Which rate: the Pokémon comp is the professional-seller floor, which sells
//! direct and through Zero alike, so it takes the direct rate; the other games
//! price from CardTrader Zero asks and take the Zero rate.

use std::sync::LazyLock;

/// The commission rule in force.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FeeRule {
    pub direct_pct: f64,
    pub zero_pct: f64,
    pub vat_pct: f64,
    /// Minimum commission per item, in euro cents (before VAT).
    pub min_fee_cents: f64,
}

/// How the comp's offers are sold on CardTrader.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Channel {
    Direct,
    Zero,
}

impl FeeRule {
    /// EU seller, subscription before March 2026, Italian VAT.
    pub const DEFAULT: FeeRule = FeeRule { direct_pct: 5.0, zero_pct: 7.0, vat_pct: 22.0, min_fee_cents: 1.0 };

    pub fn from_env() -> Self {
        let read = |name: &str, default: f64, max: f64| {
            std::env::var(name)
                .ok()
                .and_then(|value| value.trim().parse::<f64>().ok())
                .filter(|value| value.is_finite() && (0.0..=max).contains(value))
                .unwrap_or(default)
        };
        let base = Self::DEFAULT;
        Self {
            direct_pct: read("CARDTRADER_FEE_DIRECT_PCT", base.direct_pct, 50.0),
            zero_pct: read("CARDTRADER_FEE_ZERO_PCT", base.zero_pct, 50.0),
            vat_pct: read("CARDTRADER_FEE_VAT_PCT", base.vat_pct, 50.0),
            min_fee_cents: base.min_fee_cents,
        }
    }

    pub fn pct(&self, channel: Channel) -> f64 {
        match channel {
            Channel::Direct => self.direct_pct,
            Channel::Zero => self.zero_pct,
        }
    }

    /// What the seller nets on an ask, in euro cents (not rounded).
    pub fn net_cents(&self, ask_cents: f64, channel: Channel) -> Option<f64> {
        if !(ask_cents.is_finite() && ask_cents > 0.0) {
            return None;
        }
        let fee = (ask_cents * self.pct(channel) / 100.0).max(self.min_fee_cents);
        let net = ask_cents - fee * (1.0 + self.vat_pct / 100.0);
        (net > 0.0).then_some(net)
    }

    /// [`net_cents`] for a PKN ask (200 PKN = €1, so 2 PKN a cent), to a
    /// hundredth of a PKN; prices are shown as whole PKN.
    pub fn net_pkn(&self, ask_pkn: f64, channel: Channel) -> Option<f64> {
        self.net_cents(ask_pkn / 2.0, channel).map(|cents| (cents * 2.0 * 100.0).round() / 100.0)
    }

    /// The rule as the price check reports it (`ctFee`).
    pub fn describe(&self, channel: Channel) -> serde_json::Value {
        serde_json::json!({
            "pct": self.pct(channel),
            "vatPct": self.vat_pct,
            "minCents": self.min_fee_cents,
            "channel": match channel { Channel::Direct => "direct", Channel::Zero => "zero" },
        })
    }
}

/// The channel a connected seller's own CardTrader sales pay: CardTrader
/// Zero for an account that can sell through the hub (`can_sell_via_hub`),
/// direct otherwise. `stored` is the flag in the `/info` user Pokoin keeps as
/// `metadata.user` on the integration (absent on every account connected so
/// far: CardTrader's `/info` user carries only id, email and username);
/// `book` is the flag CardTrader prints on the seller's own offers in the
/// daily market book. Unknown is Zero, the higher rate, so a seller is never
/// priced above what they net.
pub fn channel_from(stored: Option<bool>, book: Option<bool>) -> Channel {
    match stored.or(book) {
        Some(false) => Channel::Direct,
        _ => Channel::Zero,
    }
}

fn flag(value: Option<&serde_json::Value>) -> Option<bool> {
    match value? {
        serde_json::Value::Bool(flag) => Some(*flag),
        serde_json::Value::String(text) if text == "true" || text == "false" => Some(text == "true"),
        _ => None,
    }
}

/// [`channel_from`] with only the stored flag (no database at hand).
pub fn seller_channel(integration_data: &serde_json::Value) -> Channel {
    channel_from(flag(integration_data.pointer("/metadata/user/can_sell_via_hub")), None)
}

/// The seller's own offers in the market book of the last week, by their
/// CardTrader user id: whether CardTrader lets them sell through Zero.
pub const SELLER_HUB_SQL: &str = "
    select bool_or(raw_metadata->'user'->>'can_sell_via_hub' = 'true') as hub, count(*)::int as offers
    from public.cardtrader_market_listing_snapshots
    where seller_account_id = $1 and last_seen_at >= now() - interval '7 days'";

/// The channel of a connected seller: the stored flag, else the market book
/// (redshakkio, CardTrader user 180405, is a Zero seller there; PeppeV,
/// 595699, is not), else Zero.
pub async fn resolve_seller_channel(db: &crate::db::DbPools, integration_data: &serde_json::Value) -> Channel {
    let stored = flag(integration_data.pointer("/metadata/user/can_sell_via_hub"));
    if stored.is_some() {
        return channel_from(stored, None);
    }
    let id = match integration_data.pointer("/metadata/user/id") {
        Some(serde_json::Value::String(id)) => id.trim().to_string(),
        Some(serde_json::Value::Number(id)) => id.to_string(),
        _ => String::new(),
    };
    if id.is_empty() {
        return channel_from(None, None);
    }
    let book = match db.query("pokemon", SELLER_HUB_SQL, &[serde_json::json!(id)]).await {
        Ok(rows) => rows.first().and_then(|row| {
            let offers = row.get("offers").and_then(serde_json::Value::as_i64).unwrap_or(0);
            (offers > 0).then(|| row.get("hub") == Some(&serde_json::Value::Bool(true)))
        }),
        Err(error) => {
            tracing::warn!(error = %error.message, "seller channel: market book unavailable");
            None
        }
    };
    channel_from(None, book)
}

/// The rule of this process (read once from the environment).
pub fn rule() -> FeeRule {
    static RULE: LazyLock<FeeRule> = LazyLock::new(FeeRule::from_env);
    *RULE
}

#[cfg(test)]
mod tests {
    use super::*;

    const R: FeeRule = FeeRule::DEFAULT;

    #[test]
    fn a_zero_ask_loses_seven_percent_plus_vat() {
        // €10.00 Zero ask: 70 c commission + 22 % VAT = 85.4 c; nets €9.146.
        assert!((R.net_cents(1000.0, Channel::Zero).unwrap() - 914.6).abs() < 1e-9);
        // €10.00 direct ask: 50 c + VAT = 61 c; nets €9.39.
        assert!((R.net_cents(1000.0, Channel::Direct).unwrap() - 939.0).abs() < 1e-9);
        // In PKN: 2000 PKN Zero → 1829.2 PKN.
        assert_eq!(R.net_pkn(2000.0, Channel::Zero), Some(1829.2));
    }

    #[test]
    fn the_minimum_commission_is_one_cent_plus_vat() {
        // Blade Twirler EN NM, €0.11 (22 PKN): 7 % is 0.77 c, so 1 c + VAT.
        assert_eq!(R.net_cents(11.0, Channel::Zero).map(|c| (c * 100.0).round() / 100.0), Some(9.78));
        assert_eq!(R.net_pkn(22.0, Channel::Zero), Some(19.56));
        // 1 cent asks net nothing: no comp rather than a negative one.
        assert_eq!(R.net_cents(1.0, Channel::Zero), None);
        assert_eq!(R.net_cents(0.0, Channel::Direct), None);
        assert_eq!(R.net_cents(f64::NAN, Channel::Direct), None);
    }

    #[test]
    fn a_zero_enabled_seller_pays_the_zero_rate() {
        let zero = serde_json::json!({"metadata": {"user": {"id": 1, "can_sell_via_hub": true}}});
        assert_eq!(seller_channel(&zero), Channel::Zero);
        assert_eq!(seller_channel(&serde_json::json!({"metadata": {"user": {"can_sell_via_hub": false}}})), Channel::Direct);
        // The book decides when the stored info has no flag (every account so far).
        assert_eq!(channel_from(None, Some(true)), Channel::Zero);
        assert_eq!(channel_from(None, Some(false)), Channel::Direct);
        assert_eq!(channel_from(Some(false), Some(true)), Channel::Direct, "the stored flag wins");
        // Unknown is the higher rate: never priced above what the seller nets.
        assert_eq!(seller_channel(&serde_json::json!({})), Channel::Zero);
        assert_eq!(channel_from(None, None), Channel::Zero);
        assert!(SELLER_HUB_SQL.contains("seller_account_id = $1"));
    }

    #[test]
    fn newer_subscriptions_and_other_vat_rates_are_settings() {
        let newer = FeeRule { direct_pct: 5.3, zero_pct: 7.3, ..R };
        assert!((newer.net_cents(1000.0, Channel::Zero).unwrap() - (1000.0 - 73.0 * 1.22)).abs() < 1e-9);
        assert_eq!(newer.describe(Channel::Zero)["pct"], 7.3);
        assert_eq!(R.describe(Channel::Direct)["channel"], "direct");
    }
}
