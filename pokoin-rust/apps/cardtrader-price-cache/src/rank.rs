//! Cheapest eligible offer per blueprint.
//!
//! Order matches the Oracle cache SQL: lowest PKN, then a Pokoin native
//! listing before CardTrader, then `external_listing_id` ascending.
//! Counts and quantity are only the winning provider's rows.

use std::cmp::Ordering;
use std::collections::BTreeMap;

use crate::money::Rat;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Provider {
    CardTrader,
    Native,
}

impl Provider {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::CardTrader => "cardtrader",
            Self::Native => "pokoin_native",
        }
    }

    fn tie_rank(self) -> u8 {
        match self {
            Self::Native => 0,
            Self::CardTrader => 1,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Offer {
    pub blueprint_id: i64,
    pub provider: Provider,
    pub price_pkn: Rat,
    pub price_eur: Option<Rat>,
    pub listing_id: String,
    pub product_id: String,
    pub quantity: i64,
    pub country: String,
    pub shipping_mode: &'static str,
    pub source_snapshot_at: Option<String>,
}

#[derive(Clone, Debug)]
pub struct Winner {
    pub blueprint_id: i64,
    pub provider: Provider,
    pub price_pkn: Rat,
    pub price_eur: Option<Rat>,
    pub listing_id: String,
    pub product_id: String,
    pub listing_count: i64,
    pub quantity_sum: i64,
    pub country: String,
    pub shipping_mode: &'static str,
    pub source_snapshot_at: Option<String>,
}

#[derive(Clone, Debug)]
pub struct Tally {
    ct_count: i64,
    ct_qty: i64,
    native_count: i64,
    native_qty: i64,
    winner: Offer,
}

impl Tally {
    pub fn from_first(offer: Offer) -> Self {
        let (ct_count, ct_qty, native_count, native_qty) = match offer.provider {
            Provider::CardTrader => (1, offer.quantity.max(0), 0, 0),
            Provider::Native => (0, 0, 1, offer.quantity.max(0)),
        };
        Self {
            ct_count,
            ct_qty,
            native_count,
            native_qty,
            winner: offer,
        }
    }

    pub fn push(&mut self, offer: Offer) {
        let quantity = offer.quantity.max(0);
        match offer.provider {
            Provider::CardTrader => {
                self.ct_count += 1;
                self.ct_qty = self.ct_qty.saturating_add(quantity);
            }
            Provider::Native => {
                self.native_count += 1;
                self.native_qty = self.native_qty.saturating_add(quantity);
            }
        }
        if better(&offer, &self.winner) {
            self.winner = offer;
        }
    }

    pub fn winner(&self) -> Winner {
        let (listing_count, quantity_sum) = match self.winner.provider {
            Provider::CardTrader => (self.ct_count, self.ct_qty),
            Provider::Native => (self.native_count, self.native_qty),
        };
        Winner {
            blueprint_id: self.winner.blueprint_id,
            provider: self.winner.provider,
            price_pkn: self.winner.price_pkn,
            price_eur: self.winner.price_eur,
            listing_id: self.winner.listing_id.clone(),
            product_id: self.winner.product_id.clone(),
            listing_count,
            quantity_sum,
            country: self.winner.country.clone(),
            shipping_mode: self.winner.shipping_mode,
            source_snapshot_at: self.winner.source_snapshot_at.clone(),
        }
    }

    pub fn provider(&self) -> Provider {
        self.winner.provider
    }

    pub fn ct_count(&self) -> i64 {
        self.ct_count
    }

    pub fn native_count(&self) -> i64 {
        self.native_count
    }
}

fn better(offer: &Offer, winner: &Offer) -> bool {
    match offer.price_pkn.cmp(&winner.price_pkn) {
        Ordering::Less => true,
        Ordering::Greater => false,
        Ordering::Equal => match offer.provider.tie_rank().cmp(&winner.provider.tie_rank()) {
            Ordering::Less => true,
            Ordering::Greater => false,
            Ordering::Equal => offer.listing_id < winner.listing_id,
        },
    }
}

/// Group offers by blueprint and keep each group's winner.
pub fn rank(offers: impl IntoIterator<Item = Offer>) -> Vec<Winner> {
    let mut groups: BTreeMap<i64, Tally> = BTreeMap::new();
    for offer in offers {
        match groups.entry(offer.blueprint_id) {
            std::collections::btree_map::Entry::Vacant(slot) => {
                slot.insert(Tally::from_first(offer));
            }
            std::collections::btree_map::Entry::Occupied(mut slot) => slot.get_mut().push(offer),
        }
    }
    groups.into_values().map(|tally| tally.winner()).collect()
}
