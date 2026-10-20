//! Polite, resumable archive of one artofpkm catalog (default: 668, "TCG Gallery",
//! clean card artworks without card text).
//!
//! Storage follows the full-site archive (`full-20261016`): `html/xx/HASH.html.gz`,
//! `metadata/xx/HASH.json`, `assets/xx/HASH.EXT` + `.json`, where HASH is the
//! SHA-256 of the URL. Requests are sequential and spaced (`--spacing-ms`), 429/5xx
//! honour Retry-After with bounded backoff, and every finished file is cached, so a
//! re-run resumes. `--reuse DIR` copies pages/images an older archive already holds
//! (verified by SHA-256) instead of asking the site again. Catalog listing pages are
//! always fetched fresh because they define the catalog's current membership.

use anyhow::{anyhow, bail, Context, Result};
use clap::Parser;
use flate2::{read::GzDecoder, write::GzEncoder, Compression};
use fs2::FileExt;
use scraper::{ElementRef, Html, Selector};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::thread::sleep;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const SITE: &str = "https://www.artofpkm.com";
const USER_AGENT: &str = "PokoinCatalogArchive/0.1 (+https://pokoin.com; public archival download)";

#[derive(Parser, Debug)]
#[command(
    about = "Archive one artofpkm catalog: listing, artwork pages, full images, linked card pages"
)]
struct Args {
    /// Output directory (created; never an existing archive of another run).
    #[arg(long)]
    output: PathBuf,
    /// Catalog id on artofpkm.com.
    #[arg(long, default_value_t = 668)]
    catalog: u32,
    /// Older archive whose html/assets may be copied instead of re-fetched.
    #[arg(long)]
    reuse: Option<PathBuf>,
    /// Minimum milliseconds between two requests (all hosts together).
    #[arg(long, default_value_t = 2000)]
    spacing_ms: u64,
    /// Also archive the card pages each artwork links to (/sets/S/card/N).
    #[arg(long, default_value_t = true, action = clap::ArgAction::Set)]
    card_pages: bool,
    /// Stop after this many artworks (scoped check).
    #[arg(long)]
    limit: Option<usize>,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn sha_hex(b: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(b);
    h.finalize().iter().map(|x| format!("{x:02x}")).collect()
}

fn rel(kind: &str, url: &str, ext: &str) -> String {
    let h = sha_hex(url.as_bytes());
    format!("{kind}/{}/{h}.{ext}", &h[..2])
}

fn atomic(path: &Path, data: &[u8]) -> Result<()> {
    if let Some(p) = path.parent() {
        fs::create_dir_all(p)?;
    }
    let tmp = path.with_extension(format!("tmp{}", std::process::id()));
    fs::write(&tmp, data)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

fn write_json(path: &Path, v: &Value) -> Result<()> {
    atomic(path, &serde_json::to_vec_pretty(v)?)
}

fn gunzip(bytes: &[u8]) -> Result<String> {
    let mut s = String::new();
    GzDecoder::new(bytes).read_to_string(&mut s)?;
    Ok(s)
}

fn gzip(s: &str) -> Result<Vec<u8>> {
    let mut e = GzEncoder::new(Vec::new(), Compression::best());
    e.write_all(s.as_bytes())?;
    Ok(e.finish()?)
}

fn ext_for(content_type: &str, bytes: &[u8]) -> &'static str {
    if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        return "webp";
    }
    if bytes.starts_with(&[0xff, 0xd8]) {
        return "jpg";
    }
    if bytes.starts_with(b"\x89PNG") {
        return "png";
    }
    if bytes.get(4..12) == Some(b"ftypavif") {
        return "avif";
    }
    match content_type.split(';').next().unwrap_or("").trim() {
        "image/webp" => "webp",
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/gif" => "gif",
        "image/avif" => "avif",
        _ => "bin",
    }
}

/// Drop `lang=` from a site URL: robots.txt disallows `?lang=` copies of pages.
fn canonical(href: &str) -> String {
    let abs = if href.starts_with("http") {
        href.to_string()
    } else {
        format!("{SITE}{href}")
    };
    let (base, query) = match abs.split_once('?') {
        Some((b, q)) => (b.to_string(), q.to_string()),
        None => return abs,
    };
    let kept: Vec<&str> = query
        .split('&')
        .filter(|p| !p.is_empty() && !p.starts_with("lang=") && !p.starts_with("amp;lang="))
        .collect();
    if kept.is_empty() {
        base
    } else {
        format!("{base}?{}", kept.join("&"))
    }
}

struct Fetcher {
    client: reqwest::blocking::Client,
    spacing: Duration,
    last: Option<Instant>,
    requests: u64,
    retries: u64,
}

enum Got {
    Ok(Vec<u8>, String),
    NotFound,
}

impl Fetcher {
    fn get(&mut self, url: &str) -> Result<Got> {
        let mut backoff = Duration::from_secs(15);
        for attempt in 0..8 {
            if let Some(last) = self.last {
                let since = last.elapsed();
                if since < self.spacing {
                    sleep(self.spacing - since);
                }
            }
            self.last = Some(Instant::now());
            self.requests += 1;
            let resp = match self.client.get(url).send() {
                Ok(r) => r,
                Err(e) => {
                    eprintln!("network error {url} (attempt {attempt}): {e}");
                    self.retries += 1;
                    sleep(backoff);
                    backoff = (backoff * 2).min(Duration::from_secs(600));
                    continue;
                }
            };
            let status = resp.status();
            if status.is_success() {
                let ct = resp
                    .headers()
                    .get(reqwest::header::CONTENT_TYPE)
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("")
                    .to_string();
                let body = resp.bytes()?.to_vec();
                return Ok(Got::Ok(body, ct));
            }
            if status.as_u16() == 404 || status.as_u16() == 410 {
                return Ok(Got::NotFound);
            }
            if status.as_u16() == 429 || status.is_server_error() {
                let wait = resp
                    .headers()
                    .get(reqwest::header::RETRY_AFTER)
                    .and_then(|v| v.to_str().ok())
                    .and_then(|s| s.trim().parse::<u64>().ok())
                    .map(Duration::from_secs)
                    .unwrap_or(backoff)
                    .min(Duration::from_secs(900));
                eprintln!("HTTP {status} {url}: waiting {}s", wait.as_secs());
                self.retries += 1;
                sleep(wait);
                backoff = (backoff * 2).min(Duration::from_secs(600));
                continue;
            }
            bail!("HTTP {status} for {url}");
        }
        bail!("gave up on {url} after retries")
    }
}

struct Archive {
    out: PathBuf,
    reuse: Option<PathBuf>,
    fetch: Fetcher,
    reused_pages: u64,
    reused_assets: u64,
    fetched_pages: u64,
    fetched_assets: u64,
    failures: Vec<Value>,
}

struct PageBody {
    html: String,
    html_path: String,
    source: &'static str,
}

impl Archive {
    /// Cached → reused from the older archive → fetched.
    fn page(&mut self, url: &str, allow_reuse: bool) -> Result<Option<PageBody>> {
        let html_rel = rel("html", url, "html.gz");
        let dest = self.out.join(&html_rel);
        if dest.exists() {
            return Ok(Some(PageBody {
                html: gunzip(&fs::read(&dest)?)?,
                html_path: html_rel,
                source: "cached",
            }));
        }
        if allow_reuse {
            if let Some(old) = self
                .reuse
                .as_ref()
                .map(|r| r.join(&html_rel))
                .filter(|p| p.exists())
            {
                let bytes = fs::read(&old)?;
                let html = gunzip(&bytes)?;
                atomic(&dest, &bytes)?;
                self.reused_pages += 1;
                return Ok(Some(PageBody {
                    html,
                    html_path: html_rel,
                    source: "reused",
                }));
            }
        }
        match self.fetch.get(url)? {
            Got::NotFound => Ok(None),
            Got::Ok(body, _) => {
                let html = String::from_utf8_lossy(&body).into_owned();
                atomic(&dest, &gzip(&html)?)?;
                self.fetched_pages += 1;
                Ok(Some(PageBody {
                    html,
                    html_path: html_rel,
                    source: "fetched",
                }))
            }
        }
    }

    fn asset(&mut self, url: &str) -> Result<Option<Value>> {
        let json_rel = rel("assets", url, "json");
        let json_dest = self.out.join(&json_rel);
        if json_dest.exists() {
            let v: Value = serde_json::from_slice(&fs::read(&json_dest)?)?;
            let path = v["path"].as_str().unwrap_or_default();
            if sha_hex(&fs::read(self.out.join(path))?) == v["sha256"].as_str().unwrap_or_default()
            {
                return Ok(Some(v));
            }
            eprintln!("cached asset hash mismatch, refetching {url}");
        }
        if let Some(old_json) = self
            .reuse
            .as_ref()
            .map(|r| r.join(&json_rel))
            .filter(|p| p.exists())
        {
            let mut v: Value = serde_json::from_slice(&fs::read(&old_json)?)?;
            let path = v["path"].as_str().unwrap_or_default().to_string();
            let old_root = self.reuse.clone().unwrap();
            if let Ok(bytes) = fs::read(old_root.join(&path)) {
                if sha_hex(&bytes) == v["sha256"].as_str().unwrap_or_default() {
                    atomic(&self.out.join(&path), &bytes)?;
                    v["reused_from"] = json!(old_root.display().to_string());
                    write_json(&json_dest, &v)?;
                    self.reused_assets += 1;
                    return Ok(Some(v));
                }
            }
        }
        let (bytes, ct) = match self.fetch.get(url)? {
            Got::NotFound => return Ok(None),
            Got::Ok(b, ct) => (b, ct),
        };
        let ext = ext_for(&ct, &bytes);
        if ext == "bin" {
            bail!("{url}: not an image ({ct})");
        }
        let size =
            imagesize::blob_size(&bytes).map_err(|e| anyhow!("{url}: undecodable image: {e}"))?;
        let path = rel("assets", url, ext);
        atomic(&self.out.join(&path), &bytes)?;
        let v = json!({
            "url": url,
            "path": path,
            "sha256": sha_hex(&bytes),
            "bytes": bytes.len(),
            "content_type": ct,
            "width": size.width,
            "height": size.height,
            "fetched_at": now(),
        });
        write_json(&json_dest, &v)?;
        self.fetched_assets += 1;
        Ok(Some(v))
    }
}

fn sel(s: &str) -> Selector {
    Selector::parse(s).expect("static selector")
}

fn text(e: ElementRef) -> String {
    e.text()
        .collect::<Vec<_>>()
        .join(" ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn first_text(root: ElementRef, s: &str) -> Option<String> {
    root.select(&sel(s))
        .next()
        .map(text)
        .filter(|t| !t.is_empty())
}

/// "Mewtwo V 074/071 Card Artwork" → ("Mewtwo V", Some("074/071")).
fn split_title(title: &str) -> (String, Option<String>) {
    let t = title
        .trim()
        .trim_end_matches("Card Artwork")
        .trim_end_matches("Card Art")
        .trim();
    let words: Vec<&str> = t.split_whitespace().collect();
    for (i, w) in words.iter().enumerate().rev() {
        if w.contains('/') && w.chars().any(|c| c.is_ascii_digit()) {
            let rest: Vec<&str> = words[i + 1..].to_vec();
            let mut name = words[..i].join(" ");
            if !rest.is_empty() {
                name = format!("{name} {}", rest.join(" ")).trim().to_string();
            }
            return (name, Some(w.to_string()));
        }
    }
    (t.to_string(), None)
}

struct Listing {
    artworks: Vec<Value>,
    next: Option<String>,
    total: Option<u64>,
}

fn parse_listing(html: &str, page_url: &str) -> Listing {
    let doc = Html::parse_document(html);
    let root = doc.root_element();
    let total = root
        .select(&sel("#catalog-artwork span"))
        .filter_map(|s| text(s).parse::<u64>().ok())
        .next();
    let next = root
        .select(&sel("[data-infinite-scroll-url-value]"))
        .next()
        .and_then(|e| e.value().attr("data-infinite-scroll-url-value"))
        .map(canonical);
    let mut artworks = Vec::new();
    let articles: Vec<ElementRef> = {
        let scoped: Vec<_> = root.select(&sel("#artwork-container article")).collect();
        if scoped.is_empty() {
            root.select(&sel("article")).collect()
        } else {
            scoped
        }
    };
    for art in articles {
        let Some(a) = art.select(&sel("a[data-lightbox-src]")).next() else {
            continue;
        };
        let at = |k: &str| a.value().attr(k).map(str::to_string);
        let Some(href) = at("data-lightbox-url").or_else(|| at("href")) else {
            continue;
        };
        let url = canonical(&href);
        let id = url.rsplit('/').next().and_then(|s| s.parse::<u64>().ok());
        let title = first_text(art, "h3")
            .or_else(|| at("data-lightbox-title"))
            .unwrap_or_default();
        let (name, number) = split_title(&title);
        let srcset: Vec<Value> = a
            .select(&sel("img"))
            .next()
            .and_then(|i| i.value().attr("srcset"))
            .map(|s| {
                s.split(',')
                    .filter_map(|p| {
                        let mut it = p.split_whitespace();
                        Some(json!({"url": it.next()?, "descriptor": it.next().unwrap_or("")}))
                    })
                    .collect()
            })
            .unwrap_or_default();
        let illustrator = art.select(&sel("p[title] a[href^='/illustrators/']")).next().map(|i| {
            json!({
                "name": text(i).trim_start_matches("by ").to_string(),
                "slug": canonical(i.value().attr("href").unwrap_or("")).rsplit('/').next().unwrap_or("").to_string(),
            })
        });
        let subjects: Vec<Value> = art
            .select(&sel("div[title] a[href]"))
            .map(|s| {
                let h = canonical(s.value().attr("href").unwrap_or(""));
                let kind = h
                    .trim_start_matches(SITE)
                    .split('/')
                    .nth(1)
                    .unwrap_or("")
                    .to_string();
                json!({"name": s.value().attr("title").unwrap_or(""), "kind": kind, "url": h})
            })
            .collect();
        artworks.push(json!({
            "artwork_id": id,
            "url": url,
            "title": title,
            "title_ja": first_text(art, "p[lang='ja']"),
            "name": name,
            "collector_number": number,
            "illustrator": illustrator,
            "date": art.select(&sel("time[datetime]")).next().and_then(|t| t.value().attr("datetime")),
            "subjects": subjects,
            "image": {
                "url": at("data-lightbox-src"),
                "width": at("data-lightbox-width").and_then(|s| s.parse::<u64>().ok()),
                "height": at("data-lightbox-height").and_then(|s| s.parse::<u64>().ok()),
            },
            "srcset": srcset,
            "listing_page": page_url,
        }));
    }
    Listing {
        artworks,
        next,
        total,
    }
}

fn parse_artwork_page(html: &str) -> Value {
    let doc = Html::parse_document(html);
    let root = doc.root_element();
    let mut cards = Vec::new();
    let mut seen = BTreeSet::new();
    for a in root.select(&sel("a[href^='/sets/']")) {
        let h = canonical(a.value().attr("href").unwrap_or(""));
        if !h.contains("/card/") || !seen.insert(h.clone()) {
            continue;
        }
        let mut parts = h.trim_start_matches(SITE).split('/').skip(2);
        let set_id = parts.next().and_then(|s| s.parse::<u64>().ok());
        let position = parts.nth(1).and_then(|s| s.parse::<u64>().ok());
        cards.push(json!({"url": h, "label": a.value().attr("aria-label"), "set_id": set_id, "position": position}));
    }
    let illustrators: BTreeSet<String> = root
        .select(&sel("a[href^='/illustrators/']"))
        .map(text)
        .filter(|t| !t.is_empty())
        .collect();
    let mut images = Vec::new();
    let mut seen_img = BTreeSet::new();
    for img in root.select(&sel("img[data-image-url]")) {
        let u = img.value().attr("data-image-url").unwrap_or("").to_string();
        if seen_img.insert(u.clone()) {
            images.push(json!({"url": u, "source": img.value().attr("data-source-text"), "role": "gallery"}));
        }
    }
    for img in root.select(&sel("[data-gallery-overlay-target='galleryImage'] img")) {
        let u = img.value().attr("src").unwrap_or("").to_string();
        if seen_img.insert(u.clone()) {
            images.push(json!({"url": u, "source": Value::Null, "role": "gallery_overlay"}));
        }
    }
    let sources: BTreeSet<String> = root
        .select(&sel("a[target='_blank'][rel='noopener']"))
        .filter_map(|a| a.value().attr("href").map(str::to_string))
        .collect();
    let catalogs: Vec<Value> = root
        .select(&sel("section h2 a[href^='/catalogs/']"))
        .map(|a| json!({"url": canonical(a.value().attr("href").unwrap_or("")), "name": text(a)}))
        .collect();
    json!({
        "h1": first_text(root, "h1"),
        "h2_ja": first_text(root, "h2[lang='ja']"),
        "illustrators": illustrators,
        "cards": cards,
        "images": images,
        "sources": sources,
        "catalogs": catalogs,
    })
}

fn parse_card_page(html: &str) -> Value {
    let doc = Html::parse_document(html);
    let root = doc.root_element();
    let set = root
        .select(&sel("a[href^='/sets/']"))
        .find(|a| {
            let h = a.value().attr("href").unwrap_or("");
            !h.contains("/card/") && !text(*a).is_empty()
        })
        .map(|a| json!({"url": canonical(a.value().attr("href").unwrap_or("")), "name": text(a)}));
    json!({
        "title": first_text(root, "title"),
        "h1": first_text(root, "h1"),
        "set": set,
        "illustrators": root.select(&sel("a[href^='/illustrators/']")).map(text).filter(|t| !t.is_empty()).collect::<BTreeSet<_>>(),
    })
}

/// Card identity from the older archive's metadata record, when it has one.
fn reused_card_meta(reuse: Option<&PathBuf>, url: &str) -> Option<Value> {
    let read = |u: &str| -> Option<Value> {
        serde_json::from_slice(&fs::read(reuse?.join(rel("metadata", u, "json"))).ok()?).ok()
    };
    let v = read(url)?;
    let set_name = v["identity"]["set_id"]
        .as_str()
        .and_then(|id| read(&format!("{SITE}/sets/{id}")))
        .map(|s| s["identity"]["name"].clone())
        .unwrap_or(Value::Null);
    Some(json!({
        "set_name": set_name,
        "title": v["title"],
        "identity": v["identity"],
        "set": v["fields"]["Set"]["text"],
        "illustrator": v["fields"]["Illustrator"]["text"],
        "pokemon": v["fields"]["Pokémon"]["text"],
        "rarity": v["fields"]["Rarity"]["text"],
    }))
}

fn main() -> Result<()> {
    let args = Args::parse();
    fs::create_dir_all(&args.output)?;
    let lock = fs::File::create(args.output.join("run.lock"))?;
    lock.try_lock_exclusive()
        .context("another writer holds run.lock")?;
    let client = reqwest::blocking::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(90))
        .build()?;
    let mut ar = Archive {
        out: args.output.clone(),
        reuse: args.reuse.clone(),
        fetch: Fetcher {
            client,
            spacing: Duration::from_millis(args.spacing_ms),
            last: None,
            requests: 0,
            retries: 0,
        },
        reused_pages: 0,
        reused_assets: 0,
        fetched_pages: 0,
        fetched_assets: 0,
        failures: Vec::new(),
    };
    let started = now();
    write_json(
        &args.output.join("provenance.json"),
        &json!({
            "source_url": format!("{SITE}/catalogs/{}", args.catalog),
            "tool": "tools/artofpkm-catalog",
            "user_agent": USER_AGENT,
            "spacing_ms": args.spacing_ms,
            "reuse": args.reuse.as_ref().map(|p| p.display().to_string()),
            "scope": "one catalog: listing pages, artwork pages, every artwork image, linked card pages; no ?lang= copies (robots.txt)",
            "started_at": started,
        }),
    )?;

    // 1. Listing pages (always fresh: they define catalog membership).
    let mut catalog_rows = Vec::new();
    let mut artworks: Vec<Value> = Vec::new();
    let mut next = Some(format!("{SITE}/catalogs/{}", args.catalog));
    let mut total = None;
    let mut seen_pages = BTreeSet::new();
    while let Some(url) = next.take() {
        if !seen_pages.insert(url.clone()) {
            break;
        }
        let dest = args.output.join(rel("html", &url, "html.gz"));
        let _ = fs::remove_file(&dest); // fresh listing every run
        let Some(page) = ar.page(&url, false)? else {
            bail!("listing page 404: {url}")
        };
        let l = parse_listing(&page.html, &url);
        total = total.or(l.total);
        eprintln!(
            "listing {url}: {} artworks (total {:?})",
            l.artworks.len(),
            total
        );
        catalog_rows.push(json!({"schema_version": 1, "kind": "catalog_listing", "url": url, "fetched_at": now(),
            "html_path": page.html_path, "artworks": l.artworks.iter().map(|a| a["url"].clone()).collect::<Vec<_>>(), "next": l.next}));
        let empty = l.artworks.is_empty();
        artworks.extend(l.artworks);
        if empty || args.limit.is_some_and(|n| artworks.len() >= n) {
            break;
        }
        next = l.next;
    }
    let mut seen_art = BTreeSet::new();
    artworks.retain(|a| seen_art.insert(a["url"].as_str().unwrap_or("").to_string()));
    if let Some(n) = args.limit {
        artworks.truncate(n);
    }

    // 2. Artwork pages, images, linked card pages.
    let count = artworks.len();
    for (i, art) in artworks.iter_mut().enumerate() {
        let url = art["url"].as_str().unwrap_or("").to_string();
        let detail = match ar.page(&url, true) {
            Ok(Some(p)) => {
                let d = parse_artwork_page(&p.html);
                catalog_rows.push(
                    json!({"schema_version": 1, "kind": "artwork", "url": url, "fetched_at": now(),
                    "html_path": p.html_path, "source": p.source, "parsed": d}),
                );
                d
            }
            Ok(None) => {
                ar.failures.push(json!({"url": url, "error": "404"}));
                json!({})
            }
            Err(e) => {
                ar.failures
                    .push(json!({"url": url, "error": e.to_string()}));
                json!({})
            }
        };
        let mut wanted: Vec<(String, String, Value)> = Vec::new();
        if let Some(u) = art["image"]["url"].as_str() {
            wanted.push((u.to_string(), "lightbox".into(), Value::Null));
        }
        for img in detail["images"].as_array().cloned().unwrap_or_default() {
            let u = img["url"].as_str().unwrap_or("").to_string();
            if !u.is_empty() && !wanted.iter().any(|(w, _, _)| *w == u) {
                wanted.push((
                    u,
                    img["role"].as_str().unwrap_or("gallery").into(),
                    img["source"].clone(),
                ));
            }
        }
        let mut assets = Vec::new();
        for (u, role, source) in wanted {
            match ar.asset(&u) {
                Ok(Some(mut v)) => {
                    v["role"] = json!(role);
                    v["source"] = source;
                    assets.push(v);
                }
                Ok(None) => ar
                    .failures
                    .push(json!({"url": u, "artwork": url, "error": "404"})),
                Err(e) => ar
                    .failures
                    .push(json!({"url": u, "artwork": url, "error": e.to_string()})),
            }
        }
        let mut cards = detail["cards"].as_array().cloned().unwrap_or_default();
        if args.card_pages {
            for c in cards.iter_mut() {
                let cu = c["url"].as_str().unwrap_or("").to_string();
                if let Some(m) = reused_card_meta(args.reuse.as_ref(), &cu) {
                    c["meta"] = m;
                }
                match ar.page(&cu, true) {
                    Ok(Some(p)) => {
                        if c.get("meta").is_none() {
                            c["meta"] = parse_card_page(&p.html);
                        }
                        c["html_path"] = json!(p.html_path);
                    }
                    Ok(None) => ar
                        .failures
                        .push(json!({"url": cu, "artwork": url, "error": "404"})),
                    Err(e) => ar
                        .failures
                        .push(json!({"url": cu, "artwork": url, "error": e.to_string()})),
                }
            }
        }
        art["page"] = json!({
            "h1": detail["h1"], "h2_ja": detail["h2_ja"], "illustrators": detail["illustrators"],
            "sources": detail["sources"], "catalogs": detail["catalogs"],
        });
        art["cards"] = json!(cards);
        art["assets"] = json!(assets);
        art["complete"] = json!(!art["assets"]
            .as_array()
            .map(|a| a.is_empty())
            .unwrap_or(true));
        let meta_path = args.output.join(rel("metadata", &url, "json"));
        write_json(&meta_path, art)?;
        if (i + 1) % 10 == 0 || i + 1 == count {
            eprintln!(
                "{}/{count} artworks; requests {} (retries {}), fetched pages {} assets {}, reused pages {} assets {}",
                i + 1, ar.fetch.requests, ar.fetch.retries, ar.fetched_pages, ar.fetched_assets, ar.reused_pages, ar.reused_assets
            );
            write_json(
                &args.output.join("progress.json"),
                &json!({
                    "done": i + 1, "artworks": count, "listed_total": total, "requests": ar.fetch.requests,
                    "retries": ar.fetch.retries, "failures": ar.failures.len(), "updated_at": now(),
                }),
            )?;
        }
    }

    // 3. Manifests.
    let mut lines = String::new();
    for a in &artworks {
        lines.push_str(&serde_json::to_string(a)?);
        lines.push('\n');
    }
    atomic(&args.output.join("artworks.jsonl"), lines.as_bytes())?;
    let mut lines = String::new();
    for r in &catalog_rows {
        lines.push_str(&serde_json::to_string(r)?);
        lines.push('\n');
    }
    atomic(&args.output.join("catalog.jsonl"), lines.as_bytes())?;
    write_json(&args.output.join("failures.json"), &json!(ar.failures))?;
    let complete = artworks
        .iter()
        .filter(|a| a["complete"] == json!(true))
        .count();
    let summary = json!({
        "catalog": args.catalog, "listed_total": total, "artworks": artworks.len(), "with_image": complete,
        "images": artworks.iter().map(|a| a["assets"].as_array().map_or(0, |x| x.len())).sum::<usize>(),
        "requests": ar.fetch.requests, "retries": ar.fetch.retries,
        "fetched_pages": ar.fetched_pages, "fetched_assets": ar.fetched_assets,
        "reused_pages": ar.reused_pages, "reused_assets": ar.reused_assets,
        "failures": ar.failures.len(), "limited": args.limit.is_some(),
        "started_at": started, "finished_at": now(),
    });
    write_json(&args.output.join("progress.json"), &summary)?;
    println!("{summary}");
    if total.is_some_and(|t| t as usize != artworks.len()) && args.limit.is_none() {
        eprintln!(
            "warning: listing says {total:?} artworks, archived {}",
            artworks.len()
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_split_name_and_number() {
        assert_eq!(
            split_title("Mewtwo V 074/071 Card Artwork"),
            ("Mewtwo V".into(), Some("074/071".into()))
        );
        assert_eq!(split_title("Ponyta Card Art"), ("Ponyta".into(), None));
        assert_eq!(
            split_title("Paldean Wooper 193/SV-P Promo Card Artwork"),
            ("Paldean Wooper Promo".into(), Some("193/SV-P".into()))
        );
    }

    #[test]
    fn canonical_drops_lang_only() {
        assert_eq!(
            canonical("/catalogs/668?artwork_page=2&lang=en"),
            "https://www.artofpkm.com/catalogs/668?artwork_page=2"
        );
        assert_eq!(
            canonical("/artwork/6119?lang=en"),
            "https://www.artofpkm.com/artwork/6119"
        );
        assert_eq!(
            canonical("/artwork/6119"),
            "https://www.artofpkm.com/artwork/6119"
        );
    }

    #[test]
    fn hash_layout_matches_full_archive() {
        assert_eq!(
            rel("html", "https://www.artofpkm.com/artwork/5344", "html.gz"),
            "html/b5/b504d60817b39237c212b51a2af9bbd9582f0575534d457bbed314a820fcfcdd.html.gz"
        );
    }

    #[test]
    fn listing_parses_articles() {
        let html = r#"<h2 id="catalog-artwork"><span>Artwork</span><span>521</span></h2>
        <div id="artwork-container" data-infinite-scroll-url-value="/catalogs/668?artwork_page=2&amp;lang=en"><article>
        <a data-lightbox-src="https://cdn.artofpkm.com/x" data-lightbox-width="918" data-lightbox-height="1280"
           data-lightbox-title="Mewtwo V 074/071 Card Artwork" data-lightbox-url="/artwork/6016?lang=en" href="/artwork/6016?lang=en">
           <img srcset="https://cdn.artofpkm.com/a 143w, https://cdn.artofpkm.com/x 918w"></a>
        <div><h3>Mewtwo V 074/071 Card Artwork</h3><p lang="ja">「ミュウツーV」</p></div>
        <p title="N-DESIGN Inc."><a href="/illustrators/n-design-inc?lang=en"><span>by</span> <span>N-DESIGN Inc.</span></a></p>
        <time datetime="2022-06-17">Jun. 17, 2022</time>
        <div title="Mewtwo, Snorlax"><a title="Mewtwo" href="/pokemon/mewtwo?lang=en"></a><a title="Snorlax" href="/pokemon/snorlax?lang=en"></a></div>
        </article></div>"#;
        let l = parse_listing(html, "p1");
        assert_eq!(l.total, Some(521));
        assert_eq!(
            l.next.as_deref(),
            Some("https://www.artofpkm.com/catalogs/668?artwork_page=2")
        );
        let a = &l.artworks[0];
        assert_eq!(a["artwork_id"], 6016);
        assert_eq!(a["collector_number"], "074/071");
        assert_eq!(a["illustrator"]["name"], "N-DESIGN Inc.");
        assert_eq!(a["illustrator"]["slug"], "n-design-inc");
        assert_eq!(a["subjects"][1]["kind"], "pokemon");
        assert_eq!(a["image"]["width"], 918);
        assert_eq!(a["srcset"].as_array().unwrap().len(), 2);
    }
}
