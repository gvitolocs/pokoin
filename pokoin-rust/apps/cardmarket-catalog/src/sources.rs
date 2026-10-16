//! Cardmarket's public catalog files and TCGplayer (tcgcsv.com) products,
//! cached under `<cache>/raw/` so a rerun is offline.
//!
//! - `https://downloads.s3.cardmarket.com/productCatalog/productList/products_singles_<game>.json`
//!   (idProduct, name, idExpansion, idMetacard; no expansion names or numbers)
//! - `…/products_nonsingles_<game>.json` (sealed products; names the promo packs)
//! - `…/priceGuide/price_guide_<game>.json` (low, trend, 1/7/30-day averages, foil)
//! - `https://tcgcsv.com/tcgplayer/<category>/groups`, `/<group>/products`, `/<group>/prices`

use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::Value;

const CARDMARKET: &str = "https://downloads.s3.cardmarket.com/productCatalog";
const TCGCSV: &str = "https://tcgcsv.com/tcgplayer";
const USER_AGENT: &str = "PokoinCatalog/1.0 (+https://pokoin.com)";

#[derive(Debug, Clone, Deserialize)]
pub struct CmProduct {
    #[serde(rename = "idProduct")]
    pub id: i64,
    pub name: String,
    #[serde(rename = "idExpansion")]
    pub expansion: i64,
    #[serde(rename = "idMetacard", default)]
    pub metacard: i64,
    #[serde(rename = "categoryName", default)]
    pub category: String,
}

#[derive(Debug, Deserialize)]
struct ProductList {
    products: Vec<CmProduct>,
}

/// One price-guide row, EUR. `None` where Cardmarket has no value.
#[derive(Debug, Clone, Deserialize)]
pub struct PriceGuide {
    #[serde(rename = "idProduct")]
    pub id: i64,
    #[serde(rename = "idCategory", default)]
    pub category: Option<i64>,
    pub avg: Option<f64>,
    pub low: Option<f64>,
    pub trend: Option<f64>,
    pub avg1: Option<f64>,
    pub avg7: Option<f64>,
    pub avg30: Option<f64>,
    #[serde(rename = "avg-foil")]
    pub avg_foil: Option<f64>,
    #[serde(rename = "low-foil")]
    pub low_foil: Option<f64>,
    #[serde(rename = "trend-foil")]
    pub trend_foil: Option<f64>,
    #[serde(rename = "avg1-foil")]
    pub avg1_foil: Option<f64>,
    #[serde(rename = "avg7-foil")]
    pub avg7_foil: Option<f64>,
    #[serde(rename = "avg30-foil")]
    pub avg30_foil: Option<f64>,
}

#[derive(Debug, Deserialize)]
pub struct PriceGuideFile {
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "priceGuides")]
    pub rows: Vec<PriceGuide>,
}

#[derive(Debug, Clone)]
pub struct TcgProduct {
    pub id: i64,
    pub group: i64,
    pub name: String,
    pub number: String,
    pub rarity: String,
    pub image: String,
    /// Highest TCGplayer market (else mid) price over its subtypes, USD.
    pub market: Option<f64>,
}

pub struct Sources {
    pub singles: Vec<CmProduct>,
    pub nonsingles: Vec<CmProduct>,
    pub tcg: Vec<TcgProduct>,
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(std::time::Duration::from_secs(90))
        .build()
        .map_err(|e| e.to_string())
}

async fn download(client: &reqwest::Client, url: &str) -> Result<Vec<u8>, String> {
    let mut last = String::new();
    for attempt in 0..4u64 {
        match client.get(url).send().await {
            Ok(resp) if resp.status().is_success() => {
                return resp
                    .bytes()
                    .await
                    .map(|b| b.to_vec())
                    .map_err(|e| e.to_string())
            }
            Ok(resp) => {
                last = format!("HTTP {}", resp.status());
                if matches!(resp.status().as_u16(), 403 | 404) {
                    break;
                }
            }
            Err(error) => last = error.to_string(),
        }
        tokio::time::sleep(std::time::Duration::from_secs(2 * (attempt + 1))).await;
    }
    Err(format!("GET {url}: {last}"))
}

/// The cached copy, or a fresh download when missing or `refresh`.
async fn cached(
    client: &reqwest::Client,
    path: &Path,
    url: &str,
    refresh: bool,
) -> Result<Vec<u8>, String> {
    if !refresh {
        if let Ok(bytes) = std::fs::read(path) {
            if !bytes.is_empty() {
                return Ok(bytes);
            }
        }
    }
    let bytes = download(client, url).await?;
    serde_json::from_slice::<Value>(&bytes).map_err(|e| format!("{url}: not JSON ({e})"))?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, &bytes).map_err(|e| format!("{}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(bytes)
}

pub fn raw_dir(cache: &Path) -> PathBuf {
    cache.join("raw")
}

pub async fn load(
    cache: &Path,
    cardmarket_game: i64,
    tcg_category: i64,
    refresh: bool,
) -> Result<Sources, String> {
    let client = client()?;
    let cm = raw_dir(cache).join("cardmarket");
    let mut lists = Vec::new();
    for kind in ["singles", "nonsingles"] {
        let file = format!("products_{kind}_{cardmarket_game}.json");
        let bytes = cached(
            &client,
            &cm.join(&file),
            &format!("{CARDMARKET}/productList/{file}"),
            refresh,
        )
        .await?;
        let list: ProductList =
            serde_json::from_slice(&bytes).map_err(|e| format!("{file}: {e}"))?;
        lists.push(list.products);
    }
    let nonsingles = lists.pop().unwrap_or_default();
    let singles = lists.pop().unwrap_or_default();

    let tcg_dir = raw_dir(cache).join("tcgcsv");
    let groups = cached(
        &client,
        &tcg_dir.join("groups.json"),
        &format!("{TCGCSV}/{tcg_category}/groups"),
        refresh,
    )
    .await?;
    let groups: Value = serde_json::from_slice(&groups).map_err(|e| e.to_string())?;
    let mut tcg = Vec::new();
    for group in groups["results"].as_array().into_iter().flatten() {
        let Some(id) = group["groupId"].as_i64() else {
            continue;
        };
        let products = cached(
            &client,
            &tcg_dir.join(format!("products_{id}.json")),
            &format!("{TCGCSV}/{tcg_category}/{id}/products"),
            refresh,
        )
        .await?;
        let prices = cached(
            &client,
            &tcg_dir.join(format!("prices_{id}.json")),
            &format!("{TCGCSV}/{tcg_category}/{id}/prices"),
            refresh,
        )
        .await?;
        tcg.extend(tcg_products(
            id,
            &serde_json::from_slice(&products).map_err(|e| e.to_string())?,
            &serde_json::from_slice(&prices).map_err(|e| e.to_string())?,
        ));
    }
    Ok(Sources {
        singles,
        nonsingles,
        tcg,
    })
}

fn tcg_products(group: i64, products: &Value, prices: &Value) -> Vec<TcgProduct> {
    let mut market = std::collections::HashMap::<i64, f64>::new();
    for row in prices["results"].as_array().into_iter().flatten() {
        let Some(id) = row["productId"].as_i64() else {
            continue;
        };
        if let Some(p) = row["marketPrice"]
            .as_f64()
            .or_else(|| row["midPrice"].as_f64())
        {
            let slot = market.entry(id).or_insert(p);
            *slot = slot.max(p);
        }
    }
    let mut out = Vec::new();
    for row in products["results"].as_array().into_iter().flatten() {
        let Some(id) = row["productId"].as_i64() else {
            continue;
        };
        let field = |key: &str| {
            row["extendedData"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|d| d["name"].as_str() == Some(key))
                .and_then(|d| d["value"].as_str())
                .unwrap_or("")
                .trim()
                .to_string()
        };
        let number = field("Number");
        if number.is_empty() {
            continue; // sealed product
        }
        // The CDN's 200w thumbnail; `_in_1000x1000` is the largest it serves.
        // `imageCount: 0` rows have no picture (the CDN answers 403).
        let image = if row["imageCount"].as_i64() == Some(0) {
            String::new()
        } else {
            row["imageUrl"]
                .as_str()
                .unwrap_or("")
                .replace("_200w.jpg", "_in_1000x1000.jpg")
        };
        out.push(TcgProduct {
            id,
            group,
            name: row["name"].as_str().unwrap_or("").trim().to_string(),
            number,
            rarity: field("Rarity"),
            image,
            market: market.get(&id).copied(),
        });
    }
    out
}

/// Today's price guide, stored as `price_guide_<game>-<createdAt day>.json`
/// (one file per Cardmarket build, so history is kept lossless on disk).
pub async fn price_guide(
    cache: &Path,
    cardmarket_game: i64,
    file: Option<&Path>,
) -> Result<(PathBuf, PriceGuideFile), String> {
    let bytes = match file {
        Some(path) => std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?,
        None => {
            download(
                &client()?,
                &format!("{CARDMARKET}/priceGuide/price_guide_{cardmarket_game}.json"),
            )
            .await?
        }
    };
    let guide: PriceGuideFile =
        serde_json::from_slice(&bytes).map_err(|e| format!("price guide: {e}"))?;
    let day = guide.created_at.get(..10).unwrap_or("unknown").to_string();
    let path = match file {
        Some(path) => path.to_path_buf(),
        None => {
            let dir = raw_dir(cache).join("cardmarket").join("price-guide");
            std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
            let path = dir.join(format!("price_guide_{cardmarket_game}-{day}.json"));
            std::fs::write(&path, &bytes).map_err(|e| format!("{}: {e}", path.display()))?;
            path
        }
    };
    Ok((path, guide))
}
