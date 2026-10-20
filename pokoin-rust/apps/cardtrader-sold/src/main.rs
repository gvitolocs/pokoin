//! Nightly CardTrader sold graph. See `cardtrader_sold::run`.

#[tokio::main]
async fn main() {
    let code = match cardtrader_sold::run().await {
        Ok(code) => code,
        Err(error) => {
            eprintln!("pokoin-cardtrader-sold: {error}");
            1
        }
    };
    std::process::exit(code);
}
