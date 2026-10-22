//! Several Pokoin listings, one CardTrader product (2026-10-21).
//!
//! A seller's identical copies (same game, card, condition, language,
//! finishes and price) are one CardTrader product whose quantity is the sum
//! of theirs. Where a copy sits in a box or stack is a Pokoin detail, not a
//! CardTrader characteristic: before this, Card Rails' 1× postings became one
//! CardTrader product each (PeppeV: 1,964 products in 297 groups).
//!
//! The model:
//! - every member listing holds the product's source `ct:<id>`;
//! - the product's `user_data_field` names one member (`pokoin:<id>`, the
//!   primary: the listing it was created for);
//! - the product-link row is the product's, with `listing_id` the primary;
//! - CardTrader's quantity is the sum of the members' quantities. A CardTrader
//!   sale takes copies from the members in [`member_order`]; a CardTrader
//!   quantity copied back to Pokoin is spread the same way ([`distribute`]);
//! - a member that changes price or goes off sale leaves the group: its
//!   copies come off the product (an increment, never an absolute write,
//!   D00008U) and it is pushed again into the group of its new price.

use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};

use crate::cardtrader::sync_core::{facet_key_of_row, NormalizedProduct};
use crate::error::clean_text_value;

fn number(row: &Value, keys: &[&str]) -> Option<f64> {
    keys.iter().find_map(|key| match row.get(*key) {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(s)) => s.trim().parse::<f64>().ok(),
        _ => None,
    })
}

/// The price to the hundredth of a PKN (a Pokoin price is whole PKN, so
/// this only keeps two odd values apart).
fn price_key(price_pkn: Option<f64>) -> String {
    match price_pkn.filter(|p| p.is_finite() && *p > 0.0) {
        Some(price) => format!("{}", (price * 100.0).round() as i64),
        None => "0".to_string(),
    }
}

/// The group of a Pokoin listing row (snake or camel case): game, card,
/// condition, language, the finish its product gets (`push::push_foil`),
/// first edition, signed, altered and the price. Not the location. A graded
/// slab is never grouped: its key is its own listing.
pub fn listing_group_key(row: &Value) -> String {
    let game = crate::cardtrader::push::listing_game(row);
    if crate::cardtrader::push::is_graded(row) {
        return format!("{game}|graded|{}", clean_text_value(row.get("id").unwrap_or(&Value::Null), 80));
    }
    let price = number(row, &["price_pkn", "pricePkn"]);
    format!("{game}|{}|{}", facet_key_of_row(row), price_key(price))
}

/// The group of a CardTrader product for the consolidation: its blueprint,
/// CardTrader's own properties as sent (`properties_key`: Mint and Near Mint
/// stay apart, though Pokoin calls both NM), graded, its description and its
/// ask. A graded product is never folded into another.
pub fn product_group_key(product: &NormalizedProduct) -> String {
    if product.graded {
        return format!("graded|{}", product.id);
    }
    format!(
        "{}|{}|{}|{}",
        product.blueprint_id,
        product.properties_key,
        product.description.trim(),
        price_key(product.price_pkn)
    )
}

/// One member listing of a product: id, copies, and the primary flag.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Member {
    pub id: String,
    pub quantity: i64,
    pub primary: bool,
    /// created_at as unix ms; ties broken by id.
    pub created_ms: i64,
}

/// The order copies are taken from a group: the primary first, then the
/// oldest. Deterministic, so a replay takes the same copies.
pub fn member_order(members: &mut [Member]) {
    members.sort_by(|a, b| b.primary.cmp(&a.primary).then(a.created_ms.cmp(&b.created_ms)).then(a.id.cmp(&b.id)));
}

/// Copies taken from each member to cover `quantity` (a CardTrader sale), in
/// [`member_order`]. `None` when the group holds fewer copies: the sale is
/// not applied (the webhook retries after the next export).
pub fn allocate(members: &[Member], quantity: i64) -> Option<Vec<(String, i64)>> {
    if quantity <= 0 {
        return Some(Vec::new());
    }
    let mut ordered = members.to_vec();
    member_order(&mut ordered);
    let mut left = quantity;
    let mut taken = Vec::new();
    for member in ordered.iter().filter(|m| m.quantity > 0) {
        if left == 0 {
            break;
        }
        let take = member.quantity.min(left);
        taken.push((member.id.clone(), take));
        left -= take;
    }
    (left == 0).then_some(taken)
}

/// New quantities of the members whose count changes when CardTrader's
/// quantity `target` is copied onto the group: a shortfall comes off the
/// members taken last (the newest first), a surplus goes to the primary.
/// The sum of the result plus the unchanged members is `target` (≥ 0).
pub fn distribute(members: &[Member], target: i64) -> Vec<(String, i64)> {
    let target = target.max(0);
    let mut ordered = members.to_vec();
    member_order(&mut ordered);
    let current: i64 = ordered.iter().map(|m| m.quantity.max(0)).sum();
    let mut changed = Vec::new();
    if ordered.is_empty() || target == current {
        return changed;
    }
    if target > current {
        let first = &ordered[0];
        changed.push((first.id.clone(), first.quantity.max(0) + (target - current)));
        return changed;
    }
    let mut excess = current - target;
    for member in ordered.iter().rev() {
        if excess == 0 {
            break;
        }
        let have = member.quantity.max(0);
        if have == 0 {
            continue;
        }
        let cut = have.min(excess);
        changed.push((member.id.clone(), have - cut));
        excess -= cut;
    }
    changed
}

/// Take `$2` copies from the group `$4` of seller `$3` for one CardTrader
/// order item, primary (`$1`) first then the oldest: one statement, every
/// member row locked, nothing written unless the group holds `$2` copies.
pub const GROUP_DECREMENT_SQL: &str = r#"
      with locked as (
        select id, quantity_available, created_at
        from public.marketplace_user_listings
        where seller_uid = $3 and source_listing_id = $4
          and status in ('active', 'paused') and quantity_available > 0
        for update
      ), ordered as (
        select id, quantity_available,
               sum(quantity_available) over (
                 order by (id::text = $1) desc, created_at, id::text
                 rows between unbounded preceding and current row
               ) as running
        from locked
      ), take as (
        select id, least(quantity_available, $2 - (running - quantity_available)) as taken
        from ordered
        where running - quantity_available < $2
          and (select coalesce(sum(quantity_available), 0) from locked) >= $2
      )
      update public.marketplace_user_listings as listing
      set quantity_available = listing.quantity_available - take.taken,
          status = case when listing.quantity_available - take.taken <= 0 then 'sold_out' else listing.status end,
          updated_at = now()
      from take
      where listing.id = take.id
      returning listing.id::text as id, listing.card_id, listing.quantity_available, listing.status,
                listing.seller_uid, take.taken
"#;

/// A member as the push sent it to CardTrader, and as it is once linked.
#[derive(Clone, Debug, PartialEq)]
pub struct Sent {
    pub id: String,
    pub quantity: i64,
    pub price_pkn: f64,
}

/// After a group's create or join links its members: the copies the product
/// must still gain or lose (`delta`, an increment), and the members that left
/// the group while CardTrader was answering (`detach`: off sale, repriced, or
/// gone). An edit of a pending listing sends nothing to CardTrader, so this is
/// where it is caught up (specs/tla/listing-ct-sync FeeOnce).
pub fn settle_after_link(sent: &[Sent], linked: &[Value]) -> (i64, Vec<String>) {
    let now: HashMap<String, &Value> = linked
        .iter()
        .map(|row| (clean_text_value(row.get("id").unwrap_or(&Value::Null), 80), row))
        .collect();
    let mut delta = 0;
    let mut detach = Vec::new();
    for member in sent {
        let Some(row) = now.get(&member.id) else {
            // Deleted or relinked meanwhile: its copies come off the product.
            delta -= member.quantity;
            continue;
        };
        let status = clean_text_value(row.get("status").unwrap_or(&Value::Null), 20);
        let quantity = number(row, &["quantity_available"]).unwrap_or(0.0) as i64;
        let price = number(row, &["price_pkn"]).unwrap_or(0.0);
        if crate::cardtrader::push::off_sale(&status) || quantity <= 0 || (price - member.price_pkn).abs() >= 0.005 {
            delta -= member.quantity;
            detach.push(member.id.clone());
        } else {
            delta += quantity - member.quantity;
        }
    }
    (delta, detach)
}

/// One CardTrader product the consolidation keeps, and the ones it folds in.
#[derive(Clone, Debug, PartialEq)]
pub struct Merge {
    pub key: String,
    pub keep: String,
    pub keep_quantity: i64,
    /// (product id, its quantity) taken off CardTrader.
    pub delete: Vec<(String, i64)>,
    /// CardTrader copies before and after: equal by construction.
    pub total: i64,
    /// Pokoin copies of every member listing of these products.
    pub pokoin_total: i64,
    /// Member listings to relink to `keep` (they hold a deleted product's source).
    pub relink: Vec<String>,
}

impl Merge {
    /// What the kept product gains: the deleted products' copies.
    pub fn increment(&self) -> i64 {
        self.delete.iter().map(|(_, quantity)| quantity).sum()
    }
}

/// A linked Pokoin listing as the consolidation reads it.
#[derive(Clone, Debug, PartialEq)]
pub struct LinkedListing {
    pub id: String,
    pub product_id: String,
    pub quantity: i64,
    pub status: String,
}

/// Groups of identical CardTrader products Pokoin made or linked (`ours`:
/// product ids with a Pokoin push or match link, or a `pokoin:` user data
/// field), each folded into the product with the most copies (ties: the
/// lowest id). Hand-made products are never touched, and a group whose
/// CardTrader copies differ from its Pokoin copies is skipped and reported
/// (`mismatched`): the next reconcile settles those first.
pub fn plan_consolidation(
    products: &[NormalizedProduct],
    ours: &HashSet<String>,
    listings: &[LinkedListing],
) -> (Vec<Merge>, Vec<Value>) {
    let mut members: HashMap<&str, Vec<&LinkedListing>> = HashMap::new();
    for listing in listings.iter().filter(|l| l.status == "active" || l.status == "paused") {
        members.entry(listing.product_id.as_str()).or_default().push(listing);
    }
    let mut groups: BTreeMap<String, Vec<&NormalizedProduct>> = BTreeMap::new();
    for product in products {
        let pokoin_made = !crate::cardtrader::sync_core::parse_pokoin_listing_id(&product.user_data_field).is_empty();
        if product.id.is_empty() || !(ours.contains(&product.id) || pokoin_made) {
            continue;
        }
        if !members.contains_key(product.id.as_str()) {
            continue;
        }
        groups.entry(product_group_key(product)).or_default().push(product);
    }
    let numeric = |id: &str| id.parse::<u64>().unwrap_or(u64::MAX);
    let mut merges = Vec::new();
    let mut mismatched = Vec::new();
    for (key, mut group) in groups {
        if group.len() < 2 {
            continue;
        }
        group.sort_by(|a, b| b.quantity.cmp(&a.quantity).then(numeric(&a.id).cmp(&numeric(&b.id))));
        let total: i64 = group.iter().map(|p| p.quantity.max(0)).sum();
        let pokoin_total: i64 = group
            .iter()
            .flat_map(|p| members.get(p.id.as_str()).into_iter().flatten())
            .map(|l| l.quantity.max(0))
            .sum();
        if total != pokoin_total {
            mismatched.push(serde_json::json!({
                "key": key, "products": group.iter().map(|p| p.id.clone()).collect::<Vec<_>>(),
                "cardtraderCopies": total, "pokoinCopies": pokoin_total,
            }));
            continue;
        }
        let keep = group[0];
        let delete: Vec<(String, i64)> = group[1..].iter().map(|p| (p.id.clone(), p.quantity.max(0))).collect();
        let relink = delete
            .iter()
            .flat_map(|(id, _)| members.get(id.as_str()).into_iter().flatten())
            .map(|l| l.id.clone())
            .collect();
        merges.push(Merge { key, keep: keep.id.clone(), keep_quantity: keep.quantity.max(0), delete, total, pokoin_total, relink });
    }
    (merges, mismatched)
}

/// Member of a JSON listing row (`id`, `quantity_available`, `created_ms`).
pub fn member_of(row: &Value, primary: &str) -> Member {
    let id = clean_text_value(row.get("id").unwrap_or(&Value::Null), 80);
    Member {
        primary: !primary.is_empty() && id == primary,
        quantity: number(row, &["quantity_available", "quantityAvailable"]).unwrap_or(0.0) as i64,
        created_ms: number(row, &["created_ms"]).unwrap_or(0.0) as i64,
        id,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn m(id: &str, quantity: i64, primary: bool, created_ms: i64) -> Member {
        Member { id: id.into(), quantity, primary, created_ms }
    }

    #[test]
    fn the_location_is_not_a_characteristic_the_price_is() {
        let a = json!({"card_id": "801312", "marketplace_game": "riftbound", "condition": "NM", "language": "EN",
                       "price_pkn": 26, "location": "megaevoluzionietb-01-03"});
        let mut b = a.clone();
        b["location"] = json!("megaevoluzionietb-02-11");
        assert_eq!(listing_group_key(&a), listing_group_key(&b));
        let mut dearer = a.clone();
        dearer["price_pkn"] = json!(28);
        assert_ne!(listing_group_key(&a), listing_group_key(&dearer));
        let mut foil = a.clone();
        foil["reverse"] = json!(true);
        assert_ne!(listing_group_key(&a), listing_group_key(&foil));
        let mut played = a.clone();
        played["condition"] = json!("LP");
        assert_ne!(listing_group_key(&a), listing_group_key(&played));
        let camel = json!({"cardId": "801312", "marketplaceGame": "riftbound", "condition": "NM", "language": "EN", "pricePkn": 26.0});
        assert_eq!(listing_group_key(&a), listing_group_key(&camel));
    }

    #[test]
    fn foil_by_foil_state_and_graded_slabs_never_merge() {
        // Card Rails stores a Riftbound holo as foil_state='holo', reverse=false
        // (seller_api listing_body; stock_csv likewise): it must not join the
        // standard copies, or the product would carry the primary's finish.
        let standard = json!({"card_id": "801312", "marketplace_game": "riftbound", "condition": "NM", "language": "EN",
                              "price_pkn": 26, "foil_state": "standard", "reverse": false});
        for finish in ["holo", "foil", "reverse"] {
            let mut foil = standard.clone();
            foil["foil_state"] = json!(finish);
            assert_ne!(listing_group_key(&standard), listing_group_key(&foil), "{finish}");
            let mut twin = foil.clone();
            twin["location"] = json!("box-2");
            assert_eq!(listing_group_key(&foil), listing_group_key(&twin));
        }
        // Pokémon: a holo is its own blueprint; only reverse is a product finish.
        let pokemon = json!({"card_id": "1001", "condition": "NM", "language": "EN", "price_pkn": 40, "foil_state": "standard"});
        let mut reverse = pokemon.clone();
        reverse["foil_state"] = json!("reverse");
        assert_ne!(listing_group_key(&pokemon), listing_group_key(&reverse));
        // Two slabs of the same card and grade are two products.
        let mut slab = pokemon.clone();
        slab["id"] = json!("a");
        slab["grading_company"] = json!("PSA");
        slab["grade"] = json!("10");
        let mut other = slab.clone();
        other["id"] = json!("b");
        assert_ne!(listing_group_key(&slab), listing_group_key(&other));
        let mut flagged = pokemon.clone();
        flagged["graded"] = json!(true);
        flagged["id"] = json!("c");
        assert!(listing_group_key(&flagged).contains("|graded|c"));
    }

    #[test]
    fn a_sale_takes_the_primary_then_the_oldest_and_never_more_than_the_group_holds() {
        let group = [m("c", 1, false, 30), m("a", 1, true, 50), m("b", 1, false, 10)];
        assert_eq!(allocate(&group, 2), Some(vec![("a".into(), 1), ("b".into(), 1)]));
        assert_eq!(allocate(&group, 3).unwrap().len(), 3);
        assert_eq!(allocate(&group, 4), None);
        let stacked = [m("a", 0, true, 1), m("b", 3, false, 2)];
        assert_eq!(allocate(&stacked, 2), Some(vec![("b".into(), 2)]));
        assert_eq!(allocate(&stacked, 0), Some(vec![]));
    }

    #[test]
    fn a_cardtrader_quantity_is_spread_over_the_group_and_sums_to_it() {
        let group = [m("p", 1, true, 1), m("x", 1, false, 2), m("y", 2, false, 3)];
        assert_eq!(distribute(&group, 4), vec![]);
        // Two copies sold on CardTrader before the webhook: the newest go first.
        assert_eq!(distribute(&group, 2), vec![("y".into(), 0)]);
        assert_eq!(distribute(&group, 1), vec![("y".into(), 0), ("x".into(), 0)]);
        assert_eq!(distribute(&group, 0), vec![("y".into(), 0), ("x".into(), 0), ("p".into(), 0)]);
        // A restock on CardTrader lands on the primary.
        assert_eq!(distribute(&group, 6), vec![("p".into(), 3)]);
        for target in 0..8 {
            let changed: HashMap<String, i64> = distribute(&group, target).into_iter().collect();
            let sum: i64 = group.iter().map(|m| *changed.get(&m.id).unwrap_or(&m.quantity)).sum();
            assert_eq!(sum, target);
        }
    }

    #[test]
    fn every_small_group_keeps_its_copies_exact() {
        // All groups of up to four members with 0..=3 copies each, the
        // primary anywhere: a sale takes exactly what it asks or nothing, a
        // copied quantity always sums to the target, and nobody goes negative.
        for size in 1..=4usize {
            for mask in 0..4usize.pow(size as u32) {
                for primary in 0..size {
                    let group: Vec<Member> = (0..size)
                        .map(|i| m(&format!("m{i}"), ((mask / 4usize.pow(i as u32)) % 4) as i64, i == primary, (size - i) as i64))
                        .collect();
                    let held: i64 = group.iter().map(|m| m.quantity).sum();
                    for want in 0..=held + 1 {
                        match allocate(&group, want) {
                            Some(taken) => {
                                assert!(want <= held);
                                assert_eq!(taken.iter().map(|(_, n)| n).sum::<i64>(), want);
                                for (id, n) in &taken {
                                    let member = group.iter().find(|m| &m.id == id).unwrap();
                                    assert!(*n >= 1 && *n <= member.quantity);
                                }
                                if want > 0 && group[primary].quantity > 0 {
                                    assert_eq!(taken[0].0, group[primary].id, "the named listing gives first");
                                }
                            }
                            None => assert!(want > held),
                        }
                    }
                    for target in 0..=held + 3 {
                        let changed: HashMap<String, i64> = distribute(&group, target).into_iter().collect();
                        assert!(changed.values().all(|n| *n >= 0));
                        assert_eq!(group.iter().map(|m| *changed.get(&m.id).unwrap_or(&m.quantity)).sum::<i64>(), target);
                    }
                }
            }
        }
    }

    fn product(id: &str, blueprint: &str, quantity: i64, price_pkn: f64, udf: &str) -> NormalizedProduct {
        let mut product = crate::cardtrader::sync_core::normalize_product(&json!({
            "id": id.parse::<i64>().unwrap(), "blueprint_id": blueprint.parse::<i64>().unwrap(), "quantity": quantity,
            "price_cents": (price_pkn / 2.0) as i64, "user_data_field": udf,
            "properties_hash": {"condition": "Near Mint", "riftbound_language": "en"},
        }));
        product.price_pkn = Some(price_pkn);
        product
    }

    fn linked(id: &str, product_id: &str, quantity: i64) -> LinkedListing {
        LinkedListing { id: id.into(), product_id: product_id.into(), quantity, status: "active".into() }
    }

    #[test]
    fn identical_pokoin_products_fold_into_one_and_the_copies_add_up() {
        let products = [
            product("11", "400648", 1, 26.0, "pokoin:00000000-0000-0000-0000-000000000001"),
            product("12", "400648", 1, 26.0, "pokoin:00000000-0000-0000-0000-000000000002"),
            product("13", "400648", 2, 26.0, "pokoin:00000000-0000-0000-0000-000000000003"),
            product("14", "400648", 1, 28.0, "pokoin:00000000-0000-0000-0000-000000000004"),
            // The seller's own product, same card and price: never touched.
            product("15", "400648", 1, 26.0, ""),
        ];
        let listings = [
            linked("l1", "11", 1), linked("l2", "12", 1), linked("l3", "13", 1), linked("l3b", "13", 1),
            linked("l4", "14", 1), linked("l5", "15", 1),
        ];
        let (merges, mismatched) = plan_consolidation(&products, &HashSet::new(), &listings);
        assert!(mismatched.is_empty());
        assert_eq!(merges.len(), 1);
        let merge = &merges[0];
        assert_eq!(merge.keep, "13", "the product with the most copies is kept");
        assert_eq!(merge.delete, vec![("11".into(), 1), ("12".into(), 1)]);
        assert_eq!(merge.keep_quantity + merge.increment(), merge.total);
        assert_eq!(merge.total, 4);
        assert_eq!(merge.pokoin_total, 4);
        assert_eq!(merge.relink, vec!["l1".to_string(), "l2".to_string()]);
    }

    #[test]
    fn cardtraders_own_properties_and_description_keep_products_apart() {
        let raw = |id: i64, condition: &str, description: &str, graded: bool| {
            crate::cardtrader::sync_core::normalize_product(&json!({
                "id": id, "blueprint_id": 400648, "quantity": 1, "price_cents": 13, "user_data_field": format!("pokoin:{id}"),
                "description": description, "graded": graded,
                "properties_hash": {"condition": condition, "riftbound_language": "en"},
            }))
        };
        // Pokoin calls Mint and Near Mint both NM; on CardTrader they differ.
        let mint = raw(1, "Mint", "", false);
        let near_mint = raw(2, "Near Mint", "", false);
        assert_eq!(mint.condition, near_mint.condition);
        assert_ne!(product_group_key(&mint), product_group_key(&near_mint));
        assert_eq!(product_group_key(&near_mint), product_group_key(&raw(3, "Near Mint", "", false)));
        // A description is something the seller wrote: kept apart.
        assert_ne!(product_group_key(&near_mint), product_group_key(&raw(4, "Near Mint", "corner ding", false)));
        // Graded slabs are never folded.
        assert_ne!(product_group_key(&raw(5, "Near Mint", "", true)), product_group_key(&raw(6, "Near Mint", "", true)));
        // Property order does not matter.
        let a = crate::cardtrader::sync_core::normalize_product(&json!({"id": 7, "properties_hash": {"a": 1, "b": 2}}));
        let b = crate::cardtrader::sync_core::normalize_product(&json!({"id": 8, "properties_hash": {"b": 2, "a": 1}}));
        assert_eq!(a.properties_key, b.properties_key);
    }

    #[test]
    fn a_group_whose_copies_disagree_is_left_for_the_reconcile() {
        let products = [product("11", "400648", 1, 26.0, "pokoin:a"), product("12", "400648", 2, 26.0, "pokoin:b")];
        let ours: HashSet<String> = ["11".to_string(), "12".to_string()].into();
        let listings = [linked("l1", "11", 1), linked("l2", "12", 1)];
        let (merges, mismatched) = plan_consolidation(&products, &ours, &listings);
        assert!(merges.is_empty());
        assert_eq!(mismatched[0]["cardtraderCopies"], 3);
        assert_eq!(mismatched[0]["pokoinCopies"], 2);
    }
}
