//! The Pokémon sold model, replayed over nightly books.
//!
//! Each step is the writer's `refresh_cardtrader_market_listing_snapshots`
//! for one expansion book (complete book, `archiveMissing`), and each night
//! ends with `finalize_cardtrader_daily_market_refresh`. The functions live in
//! cardvault `oracle-postgres/schema/` (070, 075, 086, 088, 093, 101, 103);
//! MARKET.md "Sold comps" explains them. What is kept, per game:
//!
//! - the live book (`cardtrader_market_listing_snapshots`): listing → state,
//!   first seen, last seen;
//! - episodes (`cardtrader_market_listing_removed_history`): one row per
//!   listing and removed day with status, reason and the 093 confirmation
//!   count; `observed` stands for its `marketplace_price_observations` row;
//! - seller vacation (`cardtrader_seller_vacation`) and the previous night's
//!   per-blueprint population (`cardtrader_blueprint_population_daily`).
//!
//! Days are the run folder's UTC date: a run started on day D removes listings
//! on D and imports them on D + 1, as the Oracle job does after midnight.

use std::collections::{BTreeMap, BTreeSet};

use crate::fx::{set_with, FxMap, FxSet};

use crate::listing::{Listing, EMPTY};

/// Days since 0001-01-01 (chrono's `num_days_from_ce`).
pub type Day = i32;

/// 093: a vanished stack counts after this many complete absences.
pub const CONFIRMATION_REQUIRED: u32 = 3;
/// `p_correction_window_days`.
pub const CORRECTION_WINDOW: Day = 10;
/// 101: younger listings never become sales.
pub const MIN_AGE_DAYS: Day = 3;
/// Observations are projected for removed days in (D - 60, D].
pub const OBSERVATION_DAYS: Day = 60;
/// 103: store withdrawal (`p_min_book`, `p_min_share`, `p_window_days`).
pub const STORE_MIN_BOOK: usize = 500;
pub const STORE_MIN_SHARE: f64 = 0.8;
pub const STORE_WINDOW_DAYS: Day = 7;

/// seller + blueprint + condition + language + reverse/foil + 1st ed. + graded.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct StackKey {
    pub blueprint: i64,
    pub seller: u32,
    pub condition: u32,
    pub language: u32,
    pub foil: u32,
    pub first_edition: bool,
    pub graded: bool,
}

impl StackKey {
    pub fn of(listing: &Listing) -> Self {
        Self {
            blueprint: listing.blueprint,
            seller: listing.seller,
            condition: listing.condition_key,
            language: listing.language_key,
            foil: listing.foil,
            first_edition: listing.first_edition,
            graded: listing.graded,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Snap {
    pub listing: Listing,
    pub first_seen: Day,
    pub last_seen: Day,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Pending,
    Provisional,
    Retracted,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Reason {
    QuantityDecreased,
    InferredSale,
    ListingIdRotated,
    YoungListingRemoved,
    SellerOnVacation,
    SellerStoreWithdrawn,
    /// The book was missing for one or more nights before this one: what left
    /// meanwhile is lumped onto one day, like the 11–12 Sep cutovers
    /// (D00000G, D00000R). Not a sale; same-id drips still count.
    CompleteBookCutover,
}

impl Reason {
    /// `cardtrader_market_is_sale_reason`.
    pub fn is_sale(self) -> bool {
        matches!(self, Reason::InferredSale | Reason::QuantityDecreased)
    }

    pub fn name(self) -> &'static str {
        match self {
            Reason::QuantityDecreased => "quantity_decreased",
            Reason::InferredSale => "inferred_sale",
            Reason::ListingIdRotated => "listing_id_rotated",
            Reason::YoungListingRemoved => "young_listing_removed",
            Reason::SellerOnVacation => "seller_on_vacation",
            Reason::SellerStoreWithdrawn => "seller_store_withdrawn",
            Reason::CompleteBookCutover => "complete_book_cutover",
        }
    }
}

#[derive(Clone, Debug)]
pub struct Episode {
    pub seq: u64,
    /// The snapshot row at removal; `quantity` is the episode quantity.
    pub listing: Listing,
    pub first_seen: Day,
    pub last_seen: Day,
    pub removed_day: Day,
    pub status: Status,
    pub reason: Reason,
    pub confirmation_required: bool,
    pub complete_absences: u32,
    pub last_absent_run_day: Option<Day>,
    /// `continuityQuantity` (088).
    pub continuity: Option<i32>,
    /// Its `cardtrader_removed_sale` observation exists.
    pub observed: bool,
}

impl Episode {
    fn open(&self, window_from: Day) -> bool {
        matches!(self.status, Status::Pending | Status::Provisional)
            && self.removed_day >= window_from
    }
}

/// One night: removed on `removed`, imported on `removed + 1`.
#[derive(Clone, Copy, Debug)]
pub struct Night {
    pub removed: Day,
    pub imported: Day,
    pub window_from: Day,
}

impl Night {
    pub fn new(removed: Day) -> Self {
        let imported = removed + 1;
        Self {
            removed,
            imported,
            window_from: imported - CORRECTION_WINDOW,
        }
    }
}

#[derive(Default, Clone, Debug)]
pub struct Counts {
    pub expansions: u64,
    pub listings: u64,
    pub suspicious_blueprints: u64,
    pub retracted: u64,
    pub confirmed: u64,
    pub drips: u64,
    pub vanished: u64,
    pub inferred: u64,
    pub rotated: u64,
    pub young: u64,
    pub continuity_retracted: u64,
    pub continuity_reduced: u64,
    pub observed: u64,
    pub vacation_sellers: u64,
    pub vacation_rows: u64,
    pub withdrawn_sellers: u64,
    pub withdrawn_rows: u64,
    pub cutover: u64,
}

#[derive(Default)]
pub struct Engine {
    /// The live book by blueprint.
    pub books: FxMap<i64, FxMap<u64, Snap>>,
    expansion_blueprints: FxMap<i64, FxSet<i64>>,
    /// The last night each expansion's book was read.
    expansion_last_night: FxMap<i64, Day>,
    pub episodes: Vec<Episode>,
    episode_key: FxMap<(u64, Day), usize>,
    by_listing: FxMap<u64, Vec<usize>>,
    by_blueprint: FxMap<i64, Vec<usize>>,
    by_day: BTreeMap<Day, Vec<usize>>,
    pub vacation: FxMap<u32, bool>,
    /// blueprint → (imported day, listing count, listed quantity).
    population: FxMap<i64, (Day, i64, i64)>,
    pub counts: Counts,
    seq: u64,
}

impl Engine {
    fn seller_on_vacation(&self, seller: u32) -> bool {
        seller != EMPTY && self.vacation.get(&seller).copied().unwrap_or(false)
    }

    fn insert_episode(&mut self, episode: Episode) -> bool {
        let key = (episode.listing.id, episode.removed_day);
        if self.episode_key.contains_key(&key) {
            return false;
        }
        let index = self.episodes.len();
        self.episode_key.insert(key, index);
        self.by_listing
            .entry(episode.listing.id)
            .or_default()
            .push(index);
        self.by_blueprint
            .entry(episode.listing.blueprint)
            .or_default()
            .push(index);
        self.by_day
            .entry(episode.removed_day)
            .or_default()
            .push(index);
        self.episodes.push(episode);
        true
    }

    fn next_seq(&mut self) -> u64 {
        self.seq += 1;
        self.seq
    }

    /// One expansion book of one night (`refresh_cardtrader_market_listing_snapshots`
    /// with a complete book, `archiveMissing` and no per-step finalize).
    pub fn expansion(&mut self, night: Night, expansion: i64, rows: Vec<Listing>) {
        self.counts.expansions += 1;
        // A book that was missing on earlier nights cannot date what left.
        let cutover = self
            .expansion_last_night
            .insert(expansion, night.removed)
            .is_some_and(|last| last != night.removed - 1);
        // distinct on (provider, external_listing_id)
        let mut seen = set_with(rows.len());
        let incoming: Vec<Listing> = rows.into_iter().filter(|row| seen.insert(row.id)).collect();
        self.counts.listings += incoming.len() as u64;
        let incoming_by_id: FxMap<u64, &Listing> =
            incoming.iter().map(|row| (row.id, row)).collect();

        // Scope: this book's blueprints and the expansion's known blueprints.
        let mut scope: BTreeSet<i64> = incoming.iter().map(|row| row.blueprint).collect();
        if let Some(known) = self.expansion_blueprints.get(&expansion) {
            scope.extend(known.iter().copied());
        }

        // Incoming stats per blueprint.
        let mut stats: FxMap<i64, (i64, i64)> = FxMap::default();
        for row in &incoming {
            let entry = stats.entry(row.blueprint).or_default();
            entry.0 += 1;
            entry.1 += i64::from(row.quantity);
        }

        // Observation sanity (086 stripped quantity, 093 empty/halved book).
        let mut suspicious: FxSet<i64> = FxSet::default();
        for &blueprint in &scope {
            let (count, quantity) = stats.get(&blueprint).copied().unwrap_or((0, 0));
            let prev = self
                .population
                .get(&blueprint)
                .filter(|(day, _, _)| *day == night.removed)
                .map(|(_, count, quantity)| (*count, *quantity));
            let (prev_count, prev_quantity) = prev.unwrap_or((0, 0));
            let stripped = prev.is_some()
                && prev_count >= 10
                && count as f64 >= (prev_count as f64 * 0.85).floor()
                && (quantity as f64 / count.max(1) as f64)
                    < (prev_quantity as f64 / prev_count.max(1) as f64) * 0.5;
            let emptied = count == 0
                && self
                    .books
                    .get(&blueprint)
                    .is_some_and(|book| !book.is_empty());
            let halved =
                prev.is_some() && prev_count >= 10 && (count as f64) < prev_count as f64 * 0.5;
            if stripped || emptied || halved {
                suspicious.insert(blueprint);
            }
        }
        self.counts.suspicious_blueprints += suspicious.len() as u64;

        // cardtrader_upsert_seller_vacation_from_refresh
        let mut sellers: FxMap<u32, bool> = FxMap::default();
        for row in incoming.iter().filter(|row| row.seller != EMPTY) {
            *sellers.entry(row.seller).or_default() |= row.on_vacation;
        }
        self.vacation.extend(sellers);

        let keys: FxSet<StackKey> = incoming.iter().map(StackKey::of).collect();

        // Corrections: open episodes whose listing id or seller stack is back.
        let mut retract: BTreeSet<usize> = BTreeSet::new();
        for row in &incoming {
            for &index in self.by_listing.get(&row.id).into_iter().flatten() {
                let episode = &self.episodes[index];
                if episode.open(night.window_from) && episode.listing.seller != EMPTY {
                    retract.insert(index);
                }
            }
        }
        let incoming_blueprints: BTreeSet<i64> = stats.keys().copied().collect();
        for blueprint in &incoming_blueprints {
            for &index in self.by_blueprint.get(blueprint).into_iter().flatten() {
                let episode = &self.episodes[index];
                if episode.open(night.window_from)
                    && episode.listing.seller != EMPTY
                    && episode.continuity.is_none()
                    && keys.contains(&StackKey::of(&episode.listing))
                {
                    retract.insert(index);
                }
            }
        }
        for index in retract {
            let episode = &mut self.episodes[index];
            episode.status = Status::Retracted;
            episode.observed = false;
            self.counts.retracted += 1;
        }

        // 093: one more complete absence for still-missing pending episodes.
        for blueprint in &scope {
            if suspicious.contains(blueprint) {
                continue;
            }
            for &index in self.by_blueprint.get(blueprint).into_iter().flatten() {
                let episode = &mut self.episodes[index];
                if episode.status == Status::Pending
                    && episode.confirmation_required
                    && episode.removed_day >= night.window_from
                    && episode
                        .last_absent_run_day
                        .is_none_or(|day| day < night.removed)
                    && !incoming_by_id.contains_key(&episode.listing.id)
                    && !keys.contains(&StackKey::of(&episode.listing))
                {
                    episode.complete_absences += 1;
                    episode.last_absent_run_day = Some(night.removed);
                    if episode.complete_absences >= CONFIRMATION_REQUIRED {
                        episode.status = Status::Provisional;
                        self.counts.confirmed += 1;
                    }
                }
            }
        }

        // Same-id quantity drips.
        let mut drips = Vec::new();
        for row in &incoming {
            if suspicious.contains(&row.blueprint) || row.on_vacation {
                continue;
            }
            let Some(snap) = self
                .books
                .get(&row.blueprint)
                .and_then(|book| book.get(&row.id))
            else {
                continue;
            };
            if snap.listing.quantity <= row.quantity || self.seller_on_vacation(snap.listing.seller)
            {
                continue;
            }
            let mut listing = snap.listing.clone();
            listing.quantity = (snap.listing.quantity - row.quantity).max(0);
            let young = snap.first_seen > night.removed - MIN_AGE_DAYS;
            drips.push((listing, snap.first_seen, snap.last_seen, young));
        }
        for (listing, first_seen, last_seen, young) in drips {
            let seq = self.next_seq();
            let inserted = self.insert_episode(Episode {
                seq,
                listing,
                first_seen,
                last_seen,
                removed_day: night.removed,
                status: Status::Provisional,
                reason: if young {
                    Reason::YoungListingRemoved
                } else {
                    Reason::QuantityDecreased
                },
                confirmation_required: false,
                complete_absences: 0,
                last_absent_run_day: None,
                continuity: None,
                observed: false,
            });
            if inserted {
                self.counts.drips += 1;
            }
        }

        // Vanished listings, attributed by seller-stack quantity delta.
        let mut vanished_rows = Vec::new();
        for &blueprint in &scope {
            let Some(book) = self.books.get(&blueprint) else {
                continue;
            };
            let is_suspicious = suspicious.contains(&blueprint);
            let mut prev_stack: FxMap<StackKey, i64> = FxMap::default();
            let mut drip_stack: FxMap<StackKey, i64> = FxMap::default();
            let mut vanished: Vec<&Snap> = Vec::new();
            for snap in book.values() {
                let key = StackKey::of(&snap.listing);
                if snap.listing.seller != EMPTY {
                    *prev_stack.entry(key).or_default() += i64::from(snap.listing.quantity);
                }
                match incoming_by_id.get(&snap.listing.id) {
                    Some(row) => {
                        *drip_stack.entry(key).or_default() +=
                            i64::from((snap.listing.quantity - row.quantity).max(0));
                    }
                    None => {
                        if snap.listing.seller != EMPTY
                            && !self.seller_on_vacation(snap.listing.seller)
                        {
                            vanished.push(snap);
                        }
                    }
                }
            }
            if vanished.is_empty() {
                continue;
            }
            let mut in_stack: FxMap<StackKey, i64> = FxMap::default();
            for row in incoming.iter().filter(|row| row.blueprint == blueprint) {
                *in_stack.entry(StackKey::of(row)).or_default() += i64::from(row.quantity);
            }
            // order by external_listing_id (text) inside each stack
            vanished.sort_by_cached_key(|snap| {
                (StackKey::of(&snap.listing), snap.listing.id.to_string())
            });
            let mut consumed: FxMap<StackKey, i64> = FxMap::default();
            for snap in vanished {
                let key = StackKey::of(&snap.listing);
                let delta = if is_suspicious {
                    0
                } else {
                    (prev_stack.get(&key).copied().unwrap_or(0)
                        - in_stack.get(&key).copied().unwrap_or(0)
                        - drip_stack.get(&key).copied().unwrap_or(0))
                    .max(0)
                };
                let before = consumed.entry(key).or_default();
                let quantity = i64::from(snap.listing.quantity);
                let attributed = quantity.min(delta - *before).max(0);
                *before += quantity;
                vanished_rows.push((snap.clone(), is_suspicious, attributed));
            }
        }
        for (snap, is_suspicious, attributed) in vanished_rows {
            let has_open = self
                .by_listing
                .get(&snap.listing.id)
                .into_iter()
                .flatten()
                .any(|&index| self.episodes[index].open(night.window_from));
            if has_open {
                continue;
            }
            let removed_day = night.removed.min(snap.last_seen + 1);
            let young = snap.first_seen > removed_day - MIN_AGE_DAYS;
            let reason = if cutover {
                Reason::CompleteBookCutover
            } else if young {
                Reason::YoungListingRemoved
            } else if is_suspicious || attributed > 0 {
                Reason::InferredSale
            } else {
                Reason::ListingIdRotated
            };
            let mut listing = snap.listing.clone();
            if !is_suspicious {
                listing.quantity = attributed as i32;
            }
            let seq = self.next_seq();
            let inserted = self.insert_episode(Episode {
                seq,
                listing,
                first_seen: snap.first_seen,
                last_seen: snap.last_seen,
                removed_day,
                status: Status::Pending,
                reason,
                confirmation_required: true,
                complete_absences: if is_suspicious { 0 } else { 1 },
                last_absent_run_day: (!is_suspicious).then_some(night.removed),
                continuity: None,
                observed: false,
            });
            if inserted {
                self.counts.vanished += 1;
                match reason {
                    Reason::InferredSale => self.counts.inferred += 1,
                    Reason::ListingIdRotated => self.counts.rotated += 1,
                    Reason::CompleteBookCutover => self.counts.cutover += 1,
                    _ => self.counts.young += 1,
                }
            }
        }

        // Ghost cleanup: valid disappearances leave the live book.
        for &blueprint in &scope {
            if suspicious.contains(&blueprint) {
                continue;
            }
            let vacation = &self.vacation;
            if let Some(book) = self.books.get_mut(&blueprint) {
                book.retain(|id, snap| {
                    incoming_by_id.contains_key(id)
                        || (snap.listing.seller != EMPTY
                            && vacation.get(&snap.listing.seller).copied().unwrap_or(false))
                });
            }
        }

        // Upsert the live book, sanity-frozen blueprints excluded.
        let known = self.expansion_blueprints.entry(expansion).or_default();
        for row in &incoming {
            if suspicious.contains(&row.blueprint) {
                continue;
            }
            known.insert(row.blueprint);
            let book = self.books.entry(row.blueprint).or_default();
            match book.get_mut(&row.id) {
                Some(snap) => {
                    snap.listing = row.clone();
                    snap.last_seen = night.imported;
                }
                None => {
                    book.insert(
                        row.id,
                        Snap {
                            listing: row.clone(),
                            first_seen: night.imported,
                            last_seen: night.imported,
                        },
                    );
                }
            }
        }

        // 088: continuity of seller stacks across listing-id rotation.
        if suspicious.is_empty() {
            self.reconcile(night, &scope);
        }

        // Removed-sale observations for countable episodes in scope.
        for blueprint in &scope {
            for &index in self.by_blueprint.get(blueprint).into_iter().flatten() {
                let episode = &mut self.episodes[index];
                if !episode.observed
                    && episode.status == Status::Provisional
                    && episode.reason.is_sale()
                    && episode.removed_day <= night.removed
                    && episode.removed_day > night.removed - OBSERVATION_DAYS
                    && episode.listing.quantity > 0
                    && episode.listing.price_pkn.is_some()
                {
                    episode.observed = true;
                    self.counts.observed += 1;
                }
            }
        }

        // cardtrader_blueprint_population_daily for this night.
        for (blueprint, (count, quantity)) in stats {
            self.population
                .insert(blueprint, (night.imported, count, quantity));
        }
    }

    /// `reconcile_cardtrader_seller_stack_continuity(window_from, removed, scope)`.
    fn reconcile(&mut self, night: Night, scope: &BTreeSet<i64>) {
        for blueprint in scope {
            let Some(indexes) = self.by_blueprint.get(blueprint) else {
                continue;
            };
            let mut open: FxMap<StackKey, Vec<usize>> = FxMap::default();
            let mut credited: FxMap<StackKey, i64> = FxMap::default();
            for &index in indexes {
                let episode = &self.episodes[index];
                let key = StackKey::of(&episode.listing);
                if let Some(quantity) = episode.continuity {
                    *credited.entry(key).or_default() += i64::from(quantity);
                }
                if episode.reason == Reason::InferredSale
                    && matches!(episode.status, Status::Pending | Status::Provisional)
                    && episode.removed_day >= night.window_from
                    && episode.removed_day <= night.removed
                    && episode.listing.seller != EMPTY
                    && episode.listing.quantity > 0
                {
                    open.entry(key).or_default().push(index);
                }
            }
            if open.is_empty() {
                continue;
            }
            let mut successor: FxMap<StackKey, i64> = FxMap::default();
            if let Some(book) = self.books.get(blueprint) {
                for snap in book.values() {
                    let key = StackKey::of(&snap.listing);
                    if open.contains_key(&key) {
                        *successor.entry(key).or_default() += i64::from(snap.listing.quantity);
                    }
                }
            }
            for (key, mut rows) in open {
                let available = (successor.get(&key).copied().unwrap_or(0)
                    - credited.get(&key).copied().unwrap_or(0))
                .max(0);
                if available == 0 {
                    continue;
                }
                rows.sort_by_key(|&index| {
                    let episode = &self.episodes[index];
                    (std::cmp::Reverse(episode.listing.quantity), episode.seq)
                });
                let mut consumed = 0i64;
                for index in rows {
                    let episode = &mut self.episodes[index];
                    let quantity = i64::from(episode.listing.quantity);
                    let continuity = quantity.min(available - consumed).max(0);
                    consumed += quantity;
                    if continuity == 0 {
                        continue;
                    }
                    let residual = quantity - continuity;
                    episode.continuity = Some(continuity as i32);
                    if residual == 0 {
                        episode.status = Status::Retracted;
                        episode.reason = Reason::ListingIdRotated;
                        episode.observed = false;
                        self.counts.continuity_retracted += 1;
                    } else {
                        episode.listing.quantity = residual as i32;
                        self.counts.continuity_reduced += 1;
                    }
                }
            }
        }
    }

    /// `finalize_cardtrader_daily_market_refresh`: vacation and store
    /// withdrawal reclassification for the night's removed day.
    pub fn finalize(&mut self, night: Night) {
        self.reclassify_vacation(night);
        self.reclassify_store_withdrawals(night);
    }

    fn live_sellers(&self) -> FxSet<u32> {
        self.books
            .values()
            .flat_map(|book| book.values().map(|snap| snap.listing.seller))
            .collect()
    }

    /// `cardtrader_reclassify_vacation_vanished_sellers`: a whole shop gone in
    /// one day (≥5 inferred rows over ≥3 printings, nothing left) is vacation.
    fn reclassify_vacation(&mut self, night: Night) {
        let Some(indexes) = self.by_day.get(&night.removed) else {
            return;
        };
        let mut per_seller: FxMap<u32, (usize, FxSet<i64>)> = FxMap::default();
        for &index in indexes {
            let episode = &self.episodes[index];
            if episode.reason == Reason::InferredSale && episode.listing.seller != EMPTY {
                let entry = per_seller.entry(episode.listing.seller).or_default();
                entry.0 += 1;
                entry.1.insert(episode.listing.blueprint);
            }
        }
        per_seller.retain(|_, (rows, blueprints)| *rows >= 5 && blueprints.len() >= 3);
        if per_seller.is_empty() {
            return;
        }
        let live = self.live_sellers();
        let sellers: FxSet<u32> = per_seller
            .into_keys()
            .filter(|seller| !live.contains(seller))
            .collect();
        if sellers.is_empty() {
            return;
        }
        let indexes = indexes.clone();
        for &seller in &sellers {
            self.vacation.insert(seller, true);
        }
        self.counts.vacation_sellers += sellers.len() as u64;
        for index in indexes {
            let episode = &mut self.episodes[index];
            if episode.reason != Reason::InferredSale || !sellers.contains(&episode.listing.seller)
            {
                continue;
            }
            episode.observed = false;
            episode.reason = Reason::SellerOnVacation;
            self.counts.vacation_rows += 1;
            let mut listing = episode.listing.clone();
            listing.on_vacation = true;
            let snap = Snap {
                listing,
                first_seen: episode.first_seen,
                last_seen: episode.last_seen,
            };
            self.books
                .entry(snap.listing.blueprint)
                .or_default()
                .entry(snap.listing.id)
                .or_insert(snap);
        }
    }

    /// `cardtrader_reclassify_store_withdrawals`: ≥80% of a ≥500-listing shop
    /// gone within 7 days is a store taken down, not buyers.
    fn reclassify_store_withdrawals(&mut self, night: Night) {
        let from = night.removed - (STORE_WINDOW_DAYS - 1);
        let indexes: Vec<usize> = self
            .by_day
            .range(from..=night.removed)
            .flat_map(|(_, rows)| rows.iter().copied())
            .collect();
        let mut gone: FxMap<u32, FxSet<u64>> = FxMap::default();
        let mut vanished: FxMap<u32, FxSet<u64>> = FxMap::default();
        for &index in &indexes {
            let episode = &self.episodes[index];
            if episode.listing.seller == EMPTY || episode.reason == Reason::QuantityDecreased {
                continue;
            }
            gone.entry(episode.listing.seller)
                .or_default()
                .insert(episode.listing.id);
            if matches!(
                episode.reason,
                Reason::InferredSale | Reason::YoungListingRemoved | Reason::SellerStoreWithdrawn
            ) {
                vanished
                    .entry(episode.listing.seller)
                    .or_default()
                    .insert(episode.listing.id);
            }
        }
        let floor = (STORE_MIN_BOOK as f64 * STORE_MIN_SHARE).ceil() as usize;
        let candidates: FxSet<u32> = vanished
            .iter()
            .filter(|(_, ids)| ids.len() >= floor)
            .map(|(seller, _)| *seller)
            .collect();
        if candidates.is_empty() {
            return;
        }
        let mut survivors: FxMap<u32, usize> = FxMap::default();
        for book in self.books.values() {
            for snap in book.values() {
                let seller = snap.listing.seller;
                if candidates.contains(&seller)
                    && snap.first_seen <= night.removed
                    && !gone
                        .get(&seller)
                        .is_some_and(|ids| ids.contains(&snap.listing.id))
                {
                    *survivors.entry(seller).or_default() += 1;
                }
            }
        }
        let withdrawn: FxSet<u32> = candidates
            .into_iter()
            .filter(|seller| {
                let book_before = gone.get(seller).map_or(0, |ids| ids.len())
                    + survivors.get(seller).copied().unwrap_or(0);
                let count = vanished.get(seller).map_or(0, |ids| ids.len());
                book_before >= STORE_MIN_BOOK
                    && count as f64 >= STORE_MIN_SHARE * book_before as f64
            })
            .collect();
        if withdrawn.is_empty() {
            return;
        }
        self.counts.withdrawn_sellers += withdrawn.len() as u64;
        for index in indexes {
            let episode = &mut self.episodes[index];
            if withdrawn.contains(&episode.listing.seller)
                && matches!(
                    episode.reason,
                    Reason::InferredSale | Reason::YoungListingRemoved
                )
            {
                episode.reason = Reason::SellerStoreWithdrawn;
                episode.observed = false;
                self.counts.withdrawn_rows += 1;
            }
        }
    }

    pub fn live_listing_ids(&self) -> FxSet<u64> {
        self.books
            .values()
            .flat_map(|book| book.keys().copied())
            .collect()
    }
}
