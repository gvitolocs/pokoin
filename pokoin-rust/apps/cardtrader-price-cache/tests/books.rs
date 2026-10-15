use std::collections::HashSet;
use std::io::Write;
use std::sync::RwLock;

use cardtrader_price_cache::{checkout_rate, format_rat, ingest_books, Provider};
use flate2::write::GzEncoder;
use flate2::Compression;
use serde_json::json;

#[test]
fn reads_ctb1_ctb2_and_gzip_books_one_expansion_at_a_time() {
    let dir = std::env::temp_dir().join(format!("price-cache-books-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();

    let ctb1 = json!({"10": [{
        "id": 1, "quantity": 1, "price_cents": 500, "price_currency": "EUR",
        "user": {"can_sell_via_hub": true, "country_code": "DE"}
    }]});
    std::fs::write(dir.join("5-1.ctb"), ctbook::write(&ctb1, 1).unwrap()).unwrap();

    let ctb2 = json!({"20": [{
        "id": 2, "quantity": 3, "price": 2, "currency": "EUR",
        "user": {"username": "Shop 1-Day Ready", "country_code": "IT"}
    }]});
    let sellers_path = dir.join("sellers.jsonl");
    let sellers = RwLock::new(ctbook::Sellers::open(&sellers_path).unwrap());
    let encoded = ctbook::write_with_sellers(&ctb2, 1, &sellers).unwrap();
    assert!(ctbook::read_header(&encoded).unwrap().needs_sellers);
    std::fs::write(dir.join("5-2.ctb"), encoded).unwrap();
    drop(sellers);

    let gzip = json!({"30": [{
        "id": 3, "qty": 4, "price_amount": "1.5",
        "can_sell_sealed_with_ct_zero": "yes"
    }]});
    let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
    encoder
        .write_all(&serde_json::to_vec(&gzip).unwrap())
        .unwrap();
    std::fs::write(dir.join("5-3.json.gz"), encoder.finish().unwrap()).unwrap();

    let preferred = json!({"40": [{
        "id": 8, "quantity": 1, "price_cents": 100, "price_currency": "EUR", "can_sell_via_hub": true
    }]});
    let ignored = json!({"40": [{
        "id": 9, "quantity": 1, "price_cents": 900, "price_currency": "EUR", "can_sell_via_hub": true
    }]});
    std::fs::write(dir.join("5-4.ctb"), ctbook::write(&preferred, 1).unwrap()).unwrap();
    let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
    encoder
        .write_all(&serde_json::to_vec(&ignored).unwrap())
        .unwrap();
    std::fs::write(dir.join("5-4.json.gz"), encoder.finish().unwrap()).unwrap();

    std::fs::write(dir.join("5-9.ctb"), b"not a book").unwrap();
    std::fs::write(dir.join("5-7.ctb"), ctbook::write(&ctb1, 1).unwrap()).unwrap();
    std::fs::write(dir.join("9-1.ctb"), ctbook::write(&ctb1, 1).unwrap()).unwrap();

    let mut skip = HashSet::new();
    skip.insert(7);
    let ingest = ingest_books(&dir, 5, &skip, checkout_rate(None), false);
    assert_eq!(ingest.books_read, 4);
    assert_eq!(ingest.books_failed, 1);
    assert_eq!(
        ingest.expansions.iter().copied().collect::<Vec<_>>(),
        vec![1, 2, 3, 4]
    );

    let winners = ingest.winners();
    assert_eq!(winners.len(), 4);
    assert_eq!(winners[0].blueprint_id, 10);
    assert_eq!(winners[0].listing_id, "1");
    assert_eq!(format_rat(winners[0].price_pkn), "1000");
    assert_eq!(winners[0].country, "DE");

    assert_eq!(winners[1].blueprint_id, 20);
    assert_eq!(winners[1].provider, Provider::CardTrader);
    assert_eq!(winners[1].shipping_mode, "one_day_ready");
    assert_eq!(winners[1].quantity_sum, 3);
    assert_eq!(format_rat(winners[1].price_pkn), "400");
    assert_eq!(winners[1].country, "IT");

    assert_eq!(winners[2].blueprint_id, 30);
    assert_eq!(winners[2].listing_count, 1);
    assert_eq!(winners[2].quantity_sum, 4);
    assert_eq!(format_rat(winners[2].price_pkn), "300");

    assert_eq!(winners[3].listing_id, "8");
    assert_eq!(format_rat(winners[3].price_pkn), "200");

    let _ = std::fs::remove_dir_all(&dir);
}
