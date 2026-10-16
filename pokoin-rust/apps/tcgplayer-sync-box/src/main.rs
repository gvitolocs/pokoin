//! Seller-owned TCGplayer sync box. The seller signs in by hand in Chrome.

#[tokio::main]
async fn main() {
    if let Err(error) = tcgplayer_sync_box::cli(std::env::args().skip(1)).await {
        eprintln!("tcgplayer-sync-box: {error:#}");
        std::process::exit(1);
    }
}
