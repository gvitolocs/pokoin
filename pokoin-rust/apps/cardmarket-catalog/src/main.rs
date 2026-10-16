//! Cardmarket catalog matching and daily prices. See `cardmarket_catalog`.

#[tokio::main]
async fn main() {
    let code = match cardmarket_catalog::run().await {
        Ok(code) => code,
        Err(error) => {
            eprintln!("pokoin-cardmarket-catalog: {error}");
            1
        }
    };
    std::process::exit(code);
}
