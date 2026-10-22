//! CardTrader's seller commission: out of a CardTrader ask (what a seller
//! nets), and back onto a Pokoin price (the ask to list at on CardTrader).
//!
//! A CardTrader ask (`price_cents` of `/marketplace/products`, the listing
//! books, the PKP3 price file) is the price the seller set. The buyer pays it
//! plus CardTrader Safeguard (a fixed fee per item, €0.09–€0.64 by price,
//! [`safeguard_cents`]); the seller receives it minus CardTrader's commission
//! plus VAT on that commission. Pokoin prices are what a seller **nets**:
//!
//! ```text
//! fee  = max(1 cent, ask × rate)       rate: 5 % direct, 7 % CardTrader Zero
//! net  = ask − fee × (1 + VAT)         VAT: 22 % (Italy)
//! ```
//!
//! and a Pokoin price goes to CardTrader as the smallest whole-cent ask that
//! nets it ([`FeeRule::gross_cents`]), so CardTrader's fee is counted once:
//! Spiderling NM EN at 26 PKN (€0.13) is listed at €0.14, which nets €0.1278 =
//! 25.56 → 26 PKN. Listing it at €0.13 netted €0.1178 (23.6 PKN).
//!
//! The arithmetic is exact: prices in whole PKN (2 PKN = 1 cent), rates in
//! basis points, results in 10⁻⁸ PKN (`i128`). The same functions are proved
//! in `pokoin-rust/verus/ct_fees.rs` (net ≤ ask, the 1-cent minimum, net
//! monotonic in the ask, the gross-up nets at least the price and no smaller
//! ask does, the pricer floor).
//!
//! Source: CardTrader "Payments, fees and refunds"
//! (static.cardtrader.com/en/pages/payments-fees-and-refunds, read
//! 2026-10-21): EU sellers pay 5.0 % per item sold directly and 7.0 % per item
//! sold through CardTrader Zero, minimum 1 cent, VAT added (subscriptions
//! before March 2026, guaranteed to active sellers until 2026-12-31; 5.3 % and
//! 7.3 % for newer ones). The rates are settings because they change:
//! `CARDTRADER_FEE_DIRECT_PCT`, `CARDTRADER_FEE_ZERO_PCT`,
//! `CARDTRADER_FEE_VAT_PCT` (rates up to 30 %, VAT up to 50 %).

use std::sync::LazyLock;

/// Basis points per unit.
pub const BPS: i128 = 10_000;
/// Results are in 1 / `SCALE` PKN: exact for any basis-point rate and VAT.
pub const SCALE: i128 = BPS * BPS;
/// PKN per euro cent (200 PKN = €1).
pub const PKN_PER_CENT: i128 = 2;
/// Highest commission rate accepted from the environment, in basis points.
pub const MAX_RATE_BPS: i128 = 3_000;
/// Highest VAT accepted from the environment, in basis points.
pub const MAX_VAT_BPS: i128 = 5_000;
/// Largest ask the proofs cover (`verus/ct_fees.rs`): €5 billion.
pub const MAX_ASK_PKN: i128 = 1_000_000_000_000;
/// Largest Pokoin price the gross-up proof covers: €5 million.
pub const MAX_PRICE_PKN: i128 = 1_000_000_000;

/// The commission rule in force.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FeeRule {
    pub direct_bps: i128,
    pub zero_bps: i128,
    pub vat_bps: i128,
    /// Minimum commission per item before VAT, in PKN (1 cent = 2 PKN).
    pub min_fee_pkn: i128,
}

/// How the offers are sold on CardTrader. `Direct` and `Zero` are the
/// market-wide rates (`FeeRule`, env-configurable: the professional floor and
/// the Zero price file); `Plan` is one connected seller's own rate from
/// CardTrader's full table ([`Tier`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Channel {
    Direct,
    Zero,
    Plan(Plan),
}

/// A connected seller's CardTrader commission: Zero (hub) or direct, at their tier.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Plan {
    pub zero: bool,
    pub tier: Tier,
}

/// CardTrader's seller commission table ("Payments, fees and refunds",
/// static.cardtrader.com/en/pages/payments-fees-and-refunds, read
/// 2026-10-21), before VAT, minimum 1 cent:
///
/// | Tier | direct | Zero |
/// | --- | --- | --- |
/// | EU, subscribed before March 2026 (kept by active sellers until 2026-12-31) | 5.0 % | 7.0 % |
/// | EU, from March 2026 | 5.3 % | 7.3 % |
/// | outside the EU, before March 2026 | 6.0 % | 8.0 % |
/// | outside the EU, from March 2026 | 7.0 % | 10.0 % |
/// | 1-Day Ready | 16.5 % | 16.5 % |
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tier {
    EuBeforeMarch2026,
    Eu,
    ExtraEuBeforeMarch2026,
    ExtraEu,
    OneDayReady,
}

impl Tier {
    pub fn rate_bps(self, zero: bool) -> i128 {
        match (self, zero) {
            (Tier::EuBeforeMarch2026, false) => 500,
            (Tier::EuBeforeMarch2026, true) => 700,
            (Tier::Eu, false) => 530,
            (Tier::Eu, true) => 730,
            (Tier::ExtraEuBeforeMarch2026, false) => 600,
            (Tier::ExtraEuBeforeMarch2026, true) => 800,
            (Tier::ExtraEu, false) => 700,
            (Tier::ExtraEu, true) => 1000,
            (Tier::OneDayReady, _) => 1650,
        }
    }
}

/// The last day CardTrader keeps the pre-March-2026 rates for active sellers.
pub const LEGACY_RATE_UNTIL: &str = "2026-12-31";

/// EU member states (ISO 3166-1 alpha-2), for the EU / non-EU tiers.
pub const EU_COUNTRIES: [&str; 27] = [
    "AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "GR", "HR", "HU", "IE", "IT", "LT", "LU",
    "LV", "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK",
];

/// The tier of a seller: 1-Day Ready, else by country (unknown is EU, where
/// Pokoin sells) and by when the subscription started (`before_march_2026`,
/// honoured until [`LEGACY_RATE_UNTIL`]; `today` is `YYYY-MM-DD`).
pub fn tier_of(one_day_ready: bool, country: Option<&str>, before_march_2026: bool, today: &str) -> Tier {
    if one_day_ready {
        return Tier::OneDayReady;
    }
    let eu = country.map(|code| code.trim().to_uppercase()).filter(|code| !code.is_empty()).is_none_or(|code| EU_COUNTRIES.contains(&code.as_str()));
    let legacy = before_march_2026 && today <= LEGACY_RATE_UNTIL;
    match (eu, legacy) {
        (true, true) => Tier::EuBeforeMarch2026,
        (true, false) => Tier::Eu,
        (false, true) => Tier::ExtraEuBeforeMarch2026,
        (false, false) => Tier::ExtraEu,
    }
}

impl Channel {
    pub fn as_str(self) -> &'static str {
        match self {
            Channel::Direct => "direct",
            Channel::Zero => "zero",
            Channel::Plan(Plan { tier: Tier::OneDayReady, .. }) => "1dr",
            Channel::Plan(Plan { zero, tier }) => match (tier, zero) {
                (Tier::EuBeforeMarch2026, false) => "eu-pre2026-direct",
                (Tier::EuBeforeMarch2026, true) => "eu-pre2026-zero",
                (Tier::Eu, false) => "eu-direct",
                (Tier::Eu, true) => "eu-zero",
                (Tier::ExtraEuBeforeMarch2026, false) => "extra-eu-pre2026-direct",
                (Tier::ExtraEuBeforeMarch2026, true) => "extra-eu-pre2026-zero",
                (Tier::ExtraEu, false) => "extra-eu-direct",
                (Tier::ExtraEu, true) => "extra-eu-zero",
                (Tier::OneDayReady, _) => "1dr",
            },
        }
    }

    /// [`as_str`] back (a listing's stored `ctChannel`); unknown is Zero.
    pub fn parse(code: &str) -> Channel {
        let plan = |zero, tier| Channel::Plan(Plan { zero, tier });
        match code.trim() {
            "direct" => Channel::Direct,
            "1dr" => plan(false, Tier::OneDayReady),
            "eu-pre2026-direct" => plan(false, Tier::EuBeforeMarch2026),
            "eu-pre2026-zero" => plan(true, Tier::EuBeforeMarch2026),
            "eu-direct" => plan(false, Tier::Eu),
            "eu-zero" => plan(true, Tier::Eu),
            "extra-eu-pre2026-direct" => plan(false, Tier::ExtraEuBeforeMarch2026),
            "extra-eu-pre2026-zero" => plan(true, Tier::ExtraEuBeforeMarch2026),
            "extra-eu-direct" => plan(false, Tier::ExtraEu),
            "extra-eu-zero" => plan(true, Tier::ExtraEu),
            _ => Channel::Zero,
        }
    }

    /// Zero (hub) sales, at any tier.
    pub fn is_zero(self) -> bool {
        match self {
            Channel::Direct => false,
            Channel::Zero => true,
            Channel::Plan(plan) => plan.zero,
        }
    }
}

/// The commission before VAT on an ask, scaled: `max(min, ask × rate)`, in
/// 1 / `BPS` PKN. (Verified in `verus/ct_fees.rs` as `fee_bps`.)
pub fn fee_bps(ask_pkn: i128, rate_bps: i128, min_fee_pkn: i128) -> i128 {
    let pct = ask_pkn * rate_bps;
    let min = min_fee_pkn * BPS;
    if pct > min {
        pct
    } else {
        min
    }
}

/// What the seller nets on an ask, in 1 / `SCALE` PKN (may be negative for a
/// 1-cent ask). (Verified as `net_scaled`.)
pub fn net_scaled(ask_pkn: i128, rate_bps: i128, vat_bps: i128, min_fee_pkn: i128) -> i128 {
    ask_pkn * SCALE - fee_bps(ask_pkn, rate_bps, min_fee_pkn) * (BPS + vat_bps)
}

/// A scaled amount to whole PKN, half up (prices are digits only, D000014).
/// (Verified as `round_pkn`.)
pub fn round_pkn(scaled: i128) -> i128 {
    (scaled + SCALE / 2).div_euclid(SCALE)
}

/// Does an ask of `cents` net at least `price_pkn` once rounded? (Verified as `nets`.)
pub fn nets(cents: i128, price_pkn: i128, rate_bps: i128, vat_bps: i128, min_fee_pkn: i128) -> bool {
    round_pkn(net_scaled(cents * PKN_PER_CENT, rate_bps, vat_bps, min_fee_pkn)) >= price_pkn
}

/// The smallest whole-cent CardTrader ask that nets `price_pkn` (rounded),
/// for `price_pkn ≥ 1`. Starts at half the price (no smaller ask can net it:
/// net ≤ ask) and stops by `price/2 + 4` cents with rates ≤ 30 % and VAT
/// ≤ 50 %. (Verified as `gross_cents`: the result nets the price and the cent
/// below it does not.)
pub fn gross_cents(price_pkn: i128, rate_bps: i128, vat_bps: i128, min_fee_pkn: i128) -> i128 {
    let mut cents = if price_pkn / 2 > 1 { price_pkn / 2 } else { 1 };
    let bound = price_pkn + 4;
    while cents < bound && !nets(cents, price_pkn, rate_bps, vat_bps, min_fee_pkn) {
        cents += 1;
    }
    cents
}

/// The pricer's last step: a target in 1 / `SCALE` PKN to whole PKN (when
/// `whole`), never under the floor. (Verified as `floor_price`.)
pub fn floor_price(target_scaled: i128, whole: bool, floor_pkn_scaled: i128) -> i128 {
    let rounded = if whole { round_pkn(target_scaled) * SCALE } else { target_scaled };
    if rounded < floor_pkn_scaled {
        floor_pkn_scaled
    } else {
        rounded
    }
}

/// CardTrader Safeguard, the buyer's fee per item on top of the ask, in euro
/// cents (VAT included), by the item price in cents.
pub fn safeguard_cents(ask_cents: i128) -> i128 {
    match ask_cents {
        i128::MIN..=25 => 9,
        26..=300 => 10,
        301..=500 => 11,
        501..=700 => 14,
        701..=1000 => 15,
        1001..=1500 => 21,
        1501..=2000 => 27,
        2001..=3000 => 40,
        3001..=4000 => 52,
        _ => 64,
    }
}

impl FeeRule {
    /// EU seller, subscription before March 2026, Italian VAT.
    pub const DEFAULT: FeeRule = FeeRule { direct_bps: 500, zero_bps: 700, vat_bps: 2_200, min_fee_pkn: 2 };

    pub fn from_env() -> Self {
        let read = |name: &str, default: i128, max: i128| {
            std::env::var(name)
                .ok()
                .and_then(|value| value.trim().parse::<f64>().ok())
                .filter(|pct| pct.is_finite() && *pct >= 0.0)
                .map(|pct| ((pct * 100.0).round() as i128).min(max))
                .unwrap_or(default)
        };
        let base = Self::DEFAULT;
        Self {
            direct_bps: read("CARDTRADER_FEE_DIRECT_PCT", base.direct_bps, MAX_RATE_BPS),
            zero_bps: read("CARDTRADER_FEE_ZERO_PCT", base.zero_bps, MAX_RATE_BPS),
            vat_bps: read("CARDTRADER_FEE_VAT_PCT", base.vat_bps, MAX_VAT_BPS),
            min_fee_pkn: base.min_fee_pkn,
        }
    }

    pub fn rate_bps(&self, channel: Channel) -> i128 {
        match channel {
            Channel::Direct => self.direct_bps,
            Channel::Zero => self.zero_bps,
            Channel::Plan(plan) => plan.tier.rate_bps(plan.zero),
        }
    }

    pub fn pct(&self, channel: Channel) -> f64 {
        self.rate_bps(channel) as f64 / 100.0
    }

    /// What a seller nets on an ask in PKN, to a hundredth of a PKN; `None`
    /// when it nets nothing (a 1-cent ask). Asks are whole PKN; a fractional
    /// one is rounded to the PKN first.
    pub fn net_pkn(&self, ask_pkn: f64, channel: Channel) -> Option<f64> {
        if !(ask_pkn.is_finite() && ask_pkn > 0.0 && ask_pkn <= MAX_ASK_PKN as f64) {
            return None;
        }
        let ask = ask_pkn.round() as i128;
        let net = net_scaled(ask, self.rate_bps(channel), self.vat_bps, self.min_fee_pkn);
        (net > 0).then(|| (net as f64 / SCALE as f64 * 100.0).round() / 100.0)
    }

    /// [`net_pkn`] in euro cents (not rounded).
    pub fn net_cents(&self, ask_cents: f64, channel: Channel) -> Option<f64> {
        if !(ask_cents.is_finite() && ask_cents > 0.0 && ask_cents * 2.0 <= MAX_ASK_PKN as f64) {
            return None;
        }
        let ask = (ask_cents * PKN_PER_CENT as f64).round() as i128;
        let net = net_scaled(ask, self.rate_bps(channel), self.vat_bps, self.min_fee_pkn);
        (net > 0).then(|| net as f64 / SCALE as f64 / PKN_PER_CENT as f64)
    }

    /// The CardTrader ask, in whole euro cents, that nets a Pokoin price.
    pub fn gross_cents(&self, price_pkn: f64, channel: Channel) -> Option<i128> {
        // Prices are whole PKN; under 1 PKN there is no price to list.
        if !(price_pkn.is_finite() && price_pkn >= 1.0 && price_pkn <= MAX_PRICE_PKN as f64) {
            return None;
        }
        Some(gross_cents(price_pkn.round() as i128, self.rate_bps(channel), self.vat_bps, self.min_fee_pkn))
    }

    /// [`gross_cents`] in euro, for a CardTrader write.
    pub fn gross_eur(&self, price_pkn: f64, channel: Channel) -> Option<f64> {
        self.gross_cents(price_pkn, channel).map(|cents| cents as f64 / 100.0)
    }

    /// One price worked through, for reports and tooltips: the CardTrader ask
    /// that nets `price_pkn`, the commission with VAT, what the seller nets and
    /// what the buyer pays with Safeguard (cents).
    pub fn breakdown(&self, price_pkn: f64, channel: Channel) -> Option<serde_json::Value> {
        let cents = self.gross_cents(price_pkn, channel)?;
        let ask = cents * PKN_PER_CENT;
        let rate = self.rate_bps(channel);
        let fee = fee_bps(ask, rate, self.min_fee_pkn) * (BPS + self.vat_bps);
        let net = net_scaled(ask, rate, self.vat_bps, self.min_fee_pkn);
        let to_cents = |scaled: i128| (scaled as f64 / SCALE as f64 / PKN_PER_CENT as f64 * 10_000.0).round() / 10_000.0;
        Some(serde_json::json!({
            "pricePkn": price_pkn.round(),
            "askCents": cents,
            "feeCents": to_cents(fee),
            "netCents": to_cents(net),
            "netPkn": (net as f64 / SCALE as f64 * 100.0).round() / 100.0,
            "buyerPaysCents": cents + safeguard_cents(cents),
            "channel": channel.as_str(),
        }))
    }

    /// The rule as the price check reports it (`ctFee`).
    pub fn describe(&self, channel: Channel) -> serde_json::Value {
        serde_json::json!({
            "pct": self.pct(channel),
            "vatPct": self.vat_bps as f64 / 100.0,
            "minCents": self.min_fee_pkn as f64 / PKN_PER_CENT as f64,
            "channel": channel.as_str(),
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
    let zero = channel_from(flag(integration_data.pointer("/metadata/user/can_sell_via_hub")), None) == Channel::Zero;
    plan_for(integration_data, zero, None)
}

/// The seller's own offers in the market book of the last week, by their
/// CardTrader user id: whether CardTrader lets them sell through Zero.
pub const SELLER_HUB_SQL: &str = "
    select bool_or(raw_metadata->'user'->>'can_sell_via_hub' = 'true') as hub, count(*)::int as offers,
           max(coalesce(nullif(raw_metadata->'user'->>'country_code', ''), seller_country)) as country
    from public.cardtrader_market_listing_snapshots
    where seller_account_id = $1 and last_seen_at >= now() - interval '7 days'";

/// Whether the seller's CardTrader subscription predates March 2026: the
/// integration's `metadata.feeEra` (`before-2026-03` or `current`), set when
/// the seller confirms it, else `CARDTRADER_FEE_ERA`, else `current`, the
/// higher rate, so a seller is never priced above what they net. Nothing
/// CardTrader returns (`/info`, the market book) says when an account opened.
/// CardTrader user ids whose sellers confirmed a subscription from before
/// March 2026 (2026-10-21: PeppeV / Flareon99 595699, redshakkio 180405).
/// `CARDTRADER_FEE_PRE2026_USERS` (comma-separated ids) adds more.
pub const PRE_MARCH_2026_USERS: [&str; 2] = ["595699", "180405"];

pub fn before_march_2026(integration_data: &serde_json::Value) -> bool {
    let user = ct_user_id(integration_data);
    let listed = std::env::var("CARDTRADER_FEE_PRE2026_USERS").unwrap_or_default();
    if !user.is_empty() && (PRE_MARCH_2026_USERS.contains(&user.as_str()) || listed.split(',').any(|id| id.trim() == user)) {
        return true;
    }
    let stored = integration_data.pointer("/metadata/feeEra").and_then(serde_json::Value::as_str).map(str::trim).unwrap_or("");
    let era = if stored.is_empty() { std::env::var("CARDTRADER_FEE_ERA").unwrap_or_default() } else { stored.to_string() };
    era.trim() == "before-2026-03"
}

fn today() -> String {
    crate::time_util::utc_day_key_from_ms(crate::time_util::now_ms())
}

fn plan_for(integration_data: &serde_json::Value, zero: bool, country: Option<&str>) -> Channel {
    let one_day_ready = integration_data.pointer("/metadata/oneDayReady") == Some(&serde_json::Value::Bool(true));
    Channel::Plan(Plan { zero, tier: tier_of(one_day_ready, country, before_march_2026(integration_data), &today()) })
}

fn ct_user_id(integration_data: &serde_json::Value) -> String {
    match integration_data.pointer("/metadata/user/id") {
        Some(serde_json::Value::String(id)) => id.trim().to_string(),
        Some(serde_json::Value::Number(id)) => id.to_string(),
        _ => String::new(),
    }
}

/// The channel of a connected seller: the stored flag, else the market book
/// (redshakkio, CardTrader user 180405, is a Zero seller there; PeppeV,
/// 595699, is not), else Zero.
pub async fn resolve_seller_channel(db: &crate::db::DbPools, integration_data: &serde_json::Value) -> Channel {
    match db.read("pokemon").await {
        Ok(pool) => resolve_seller_channel_pool(&pool, integration_data).await,
        Err(_) => plan_for(integration_data, channel_from(flag(integration_data.pointer("/metadata/user/can_sell_via_hub")), None) == Channel::Zero, None),
    }
}

/// [`resolve_seller_channel`] on a pool of the shared database (the outbox,
/// Scan Connect).
pub async fn resolve_seller_channel_pool(pool: &sqlx::PgPool, integration_data: &serde_json::Value) -> Channel {
    let stored = flag(integration_data.pointer("/metadata/user/can_sell_via_hub"));
    let id = ct_user_id(integration_data);
    let (book, country) = if id.is_empty() {
        (None, None)
    } else {
        match sqlx::query_as::<_, (Option<bool>, i32, Option<String>)>(SELLER_HUB_SQL).bind(&id).fetch_one(pool).await {
            Ok((hub, offers, country)) => ((offers > 0).then_some(hub == Some(true)), country),
            Err(error) => {
                tracing::warn!(%error, "seller channel: market book unavailable");
                (None, None)
            }
        }
    };
    let zero = channel_from(stored, book) == Channel::Zero;
    plan_for(integration_data, zero, country.as_deref())
}

/// A connected seller's channel by uid, cached for an hour per process (the
/// price check asks on every page).
pub async fn seller_channel_cached(
    firestore: &dyn crate::firebase::FirestoreStore,
    db: &crate::db::DbPools,
    uid: &str,
) -> Option<Channel> {
    use std::collections::HashMap;
    use std::sync::Mutex;
    use std::time::{Duration, Instant};
    static CACHE: LazyLock<Mutex<HashMap<String, (Option<Channel>, Instant)>>> = LazyLock::new(Default::default);
    if uid.is_empty() {
        return None;
    }
    if let Some((channel, at)) = CACHE.lock().ok().and_then(|cache| cache.get(uid).copied()) {
        if at.elapsed() < Duration::from_secs(3_600) {
            return channel;
        }
    }
    let channel = match crate::cardtrader::integration::read_integration_doc(firestore, uid).await {
        Ok(doc) if crate::cardtrader::integration::safe_status_from_doc(&doc)["connected"] == true => Some(resolve_seller_channel(db, &doc.data).await),
        _ => None,
    };
    if let Ok(mut cache) = CACHE.lock() {
        cache.insert(uid.to_string(), (channel, Instant::now()));
    }
    channel
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
    fn a_pokoin_price_goes_to_cardtrader_with_the_fee_once() {
        // The 2026-10-21 Spiderling row: Pokoin 26 PKN (net of a €0.14 ask).
        assert_eq!(R.gross_cents(26.0, Channel::Direct), Some(14));
        let row = R.breakdown(26.0, Channel::Direct).unwrap();
        assert_eq!(row["askCents"], 14);
        assert_eq!(row["feeCents"], 1.22);
        assert_eq!(row["netCents"], 12.78);
        assert_eq!(row["netPkn"], 25.56);
        assert_eq!(row["buyerPaysCents"], 23, "€0.14 + €0.09 Safeguard (items up to €0.25)");
        // €10 net at Zero: the ask is the smallest cent that nets 2000 PKN.
        let cents = R.gross_cents(2000.0, Channel::Zero).unwrap();
        assert_eq!(cents, 1094);
        assert!(nets(cents, 2000, 700, 2200, 2) && !nets(cents - 1, 2000, 700, 2200, 2));
        assert_eq!(R.gross_eur(2000.0, Channel::Zero), Some(10.94));
        assert_eq!(R.gross_cents(0.0, Channel::Zero), None);
        assert_eq!(R.gross_cents(0.5, Channel::Zero), None, "under 1 PKN is no price");
        // Outside the proved range: no number rather than an unproved one.
        assert_eq!(R.gross_cents(2e9, Channel::Zero), None);
        assert_eq!(R.net_pkn(2e12, Channel::Zero), None);
        assert!(FeeRule::from_env().min_fee_pkn == 2, "the proofs assume a 1-cent minimum");
    }

    #[test]
    fn the_round_trip_never_counts_the_fee_twice_or_skips_a_cent() {
        for rule in [R, FeeRule { direct_bps: 530, zero_bps: 730, ..R }, FeeRule { direct_bps: 3_000, vat_bps: 5_000, ..R }] {
            for channel in [Channel::Direct, Channel::Zero] {
                let rate = rule.rate_bps(channel);
                for price in 1..4_000i128 {
                    let cents = gross_cents(price, rate, rule.vat_bps, 2);
                    assert!(nets(cents, price, rate, rule.vat_bps, 2), "{price} at {cents} c");
                    assert!(cents == 1 || !nets(cents - 1, price, rate, rule.vat_bps, 2), "{price}: {cents} c is not the smallest");
                    // Netting it again (listing at the net) would lose money: fee once.
                    assert!(round_pkn(net_scaled(cents * 2, rate, rule.vat_bps, 2)) <= price + 2);
                }
            }
        }
    }

    #[test]
    fn net_is_monotonic_and_never_above_the_ask() {
        let mut last = i128::MIN;
        for ask in 1..20_000i128 {
            let net = net_scaled(ask, 700, 2200, 2);
            assert!(net <= ask * SCALE);
            assert!(net >= last);
            last = net;
        }
        assert!(fee_bps(1, 700, 2) >= 2 * BPS, "at least 1 cent");
    }

    #[test]
    fn the_pricer_floor_holds_after_rounding() {
        assert_eq!(floor_price(25 * SCALE + SCALE / 2, true, 0), 26 * SCALE);
        assert_eq!(floor_price(3 * SCALE, true, 5 * SCALE), 5 * SCALE);
        assert_eq!(floor_price(5 * SCALE + 1, false, 5 * SCALE), 5 * SCALE + 1);
        assert_eq!(safeguard_cents(14), 9);
        assert_eq!(safeguard_cents(26), 10);
        assert_eq!(safeguard_cents(4001), 64);
    }

    #[test]
    fn the_full_cardtrader_table_by_country_subscription_and_one_day_ready() {
        let at = |tier, zero| R.rate_bps(Channel::Plan(Plan { zero, tier }));
        assert_eq!((at(Tier::EuBeforeMarch2026, false), at(Tier::EuBeforeMarch2026, true)), (500, 700));
        assert_eq!((at(Tier::Eu, false), at(Tier::Eu, true)), (530, 730));
        assert_eq!((at(Tier::ExtraEuBeforeMarch2026, false), at(Tier::ExtraEuBeforeMarch2026, true)), (600, 800));
        assert_eq!((at(Tier::ExtraEu, false), at(Tier::ExtraEu, true)), (700, 1000));
        assert_eq!((at(Tier::OneDayReady, false), at(Tier::OneDayReady, true)), (1650, 1650));
        // PeppeV / Flareon99 is in Denmark, redshakkio in Italy: EU.
        assert_eq!(tier_of(false, Some("dk"), true, "2026-10-21"), Tier::EuBeforeMarch2026);
        assert_eq!(tier_of(false, Some("IT"), false, "2026-10-21"), Tier::Eu);
        assert_eq!(tier_of(false, Some("US"), true, "2026-10-21"), Tier::ExtraEuBeforeMarch2026);
        assert_eq!(tier_of(false, Some("GB"), false, "2026-10-21"), Tier::ExtraEu);
        assert_eq!(tier_of(false, None, false, "2026-10-21"), Tier::Eu, "unknown country: EU");
        assert_eq!(tier_of(false, Some("IT"), true, "2027-01-01"), Tier::Eu, "the old rate ends 2026-12-31");
        assert_eq!(tier_of(true, Some("IT"), true, "2026-10-21"), Tier::OneDayReady);
        // Unknown subscription date: the current (higher) rate.
        assert!(!before_march_2026(&serde_json::json!({})) || std::env::var("CARDTRADER_FEE_ERA").is_ok());
        assert!(before_march_2026(&serde_json::json!({"metadata": {"feeEra": "before-2026-03"}})));
        assert!(before_march_2026(&serde_json::json!({"metadata": {"user": {"id": 595699}}})), "PeppeV confirmed");
        assert!(before_march_2026(&serde_json::json!({"metadata": {"user": {"id": "180405"}}})), "redshakkio confirmed");
        for code in ["direct", "zero", "1dr", "eu-pre2026-direct", "eu-zero", "extra-eu-pre2026-zero", "extra-eu-direct"] {
            assert_eq!(Channel::parse(code).as_str(), code);
        }
        assert_eq!(Channel::parse("?"), Channel::Zero);
        assert!(SELLER_HUB_SQL.contains("country_code"));
    }

    #[test]
    fn spiderling_worked_through_at_each_eu_rate() {
        // A €0.13 ask: below €0.19 (direct) or €0.14 (Zero) the 1-cent minimum
        // is the commission at every EU rate, so the tier changes nothing.
        for tier in [Tier::EuBeforeMarch2026, Tier::Eu] {
            for zero in [false, true] {
                let channel = Channel::Plan(Plan { zero, tier });
                assert_eq!(R.net_cents(13.0, channel), Some(11.78));
                let row = R.breakdown(24.0, channel).unwrap();
                assert_eq!((row["askCents"].as_i64(), row["buyerPaysCents"].as_i64()), (Some(13), Some(22)));
                assert_eq!(R.breakdown(26.0, channel).unwrap()["askCents"], 14);
            }
        }
        // Dearer cards do feel the tier: a €10 ask nets €9.3534 at 5.3 % direct, €9.39 at 5 %.
        let current = R.net_cents(1000.0, Channel::Plan(Plan { zero: false, tier: Tier::Eu })).unwrap();
        let before = R.net_cents(1000.0, Channel::Plan(Plan { zero: false, tier: Tier::EuBeforeMarch2026 })).unwrap();
        assert!((current - 935.34).abs() < 1e-6 && (before - 939.0).abs() < 1e-6);
    }

    #[test]
    fn a_zero_enabled_seller_pays_the_zero_rate() {
        let zero = serde_json::json!({"metadata": {"user": {"id": 1, "can_sell_via_hub": true}}});
        assert!(seller_channel(&zero).is_zero());
        assert!(!seller_channel(&serde_json::json!({"metadata": {"user": {"can_sell_via_hub": false}}})).is_zero());
        assert_eq!(channel_from(None, Some(true)), Channel::Zero);
        assert_eq!(channel_from(None, Some(false)), Channel::Direct);
        assert_eq!(channel_from(Some(false), Some(true)), Channel::Direct, "the stored flag wins");
        assert!(seller_channel(&serde_json::json!({})).is_zero());
        assert_eq!(channel_from(None, None), Channel::Zero);
        assert!(SELLER_HUB_SQL.contains("seller_account_id = $1"));
    }

    #[test]
    fn newer_subscriptions_and_other_vat_rates_are_settings() {
        let newer = FeeRule { direct_bps: 530, zero_bps: 730, ..R };
        assert!((newer.net_cents(1000.0, Channel::Zero).unwrap() - (1000.0 - 73.0 * 1.22)).abs() < 1e-9);
        assert_eq!(newer.describe(Channel::Zero)["pct"], 7.3);
        assert_eq!(R.describe(Channel::Direct)["channel"], "direct");
        assert_eq!(R.describe(Channel::Direct)["minCents"], 1.0);
    }
}
