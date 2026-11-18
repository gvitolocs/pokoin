//! Nightly CardTrader price cache. See `cardtrader_price_cache::run`.

#[tokio::main]
async fn main() {
    let code = match cardtrader_price_cache::run().await {
        Ok(code) => code,
        Err(error) => {
            eprintln!("pokoin-cardtrader-price-cache: {error}");
            1
        }
    };
    std::process::exit(code);
}
