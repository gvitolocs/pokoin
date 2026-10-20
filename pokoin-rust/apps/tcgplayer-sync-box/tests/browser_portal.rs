//! Browser portal against a local HTML mock. Chrome is headless. Nothing here
//! names a live shop host.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::{Path as UrlPath, Query, State};
use axum::http::StatusCode;
use axum::response::Html;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};
use tcgplayer_sync_box::{
    run_once, BrowserPortal, Client, ListingTarget, Portal, PortalConfig, PortalError,
};
use tcgplayer_sync_box::BrowserLaunch as LaunchOptions;

#[derive(Clone)]
struct Shop(Arc<Mutex<ShopState>>);

struct ShopState {
    signed_out: bool,
    captcha: Captcha,
    save_fails: bool,
    revert: bool,
    slow: bool,
    ambiguous: bool,
    skus: Vec<Sku>,
    posts: Vec<(String, String, String)>,
    hits: Vec<String>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Captcha {
    Off,
    HomeFrame,
    HomeTitle,
    SkuFrame,
}

#[derive(Clone)]
struct Sku {
    id: String,
    condition: String,
    printing: String,
    language: String,
    quantity: String,
    price: String,
    listed: bool,
}

fn chrome_path() -> Option<PathBuf> {
    if std::env::var("POKOIN_TEST_NO_BROWSER").ok().as_deref() == Some("1") {
        eprintln!("skipped: POKOIN_TEST_NO_BROWSER=1");
        return None;
    }
    match tcgplayer_sync_box::find_chrome(None) {
        Some(path) => Some(path),
        None => {
            eprintln!("skipped: Chrome not found");
            None
        }
    }
}

struct Profile(PathBuf);

impl Profile {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "pokoin-tcg-box-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).expect("clock").as_nanos()
        ));
        std::fs::create_dir_all(&dir).expect("profile");
        Self(dir)
    }
}

impl Drop for Profile {
    fn drop(&mut self) {
        for _ in 0..20 {
            if std::fs::remove_dir_all(&self.0).is_ok() || !self.0.exists() {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

fn catalog() -> Vec<Sku> {
    vec![
        sku("NM-EN", "Near Mint", "Normal", "English", "1", "1.00", true),
        sku("LP-EN", "Lightly Played", "Normal", "English", "1", "1.00", true),
        sku("REV-EN", "Near Mint", "Reverse Holofoil", "English", "1", "1.00", true),
        sku("NM-JP", "Near Mint", "Normal", "Japanese", "1", "1.00", true),
        sku("PRICE-1", "Near Mint", "Normal", "English", "2", "10.00", false),
    ]
}

fn sku(id: &str, condition: &str, printing: &str, language: &str, quantity: &str, price: &str, listed: bool) -> Sku {
    Sku {
        id: id.to_string(),
        condition: condition.to_string(),
        printing: printing.to_string(),
        language: language.to_string(),
        quantity: quantity.to_string(),
        price: price.to_string(),
        listed,
    }
}

fn shop() -> Shop {
    Shop(Arc::new(Mutex::new(ShopState {
        signed_out: false,
        captcha: Captcha::Off,
        save_fails: false,
        revert: false,
        slow: false,
        ambiguous: false,
        skus: catalog(),
        posts: Vec::new(),
        hits: Vec::new(),
    })))
}

impl Shop {
    fn hit(&self, path: &str) {
        self.0.lock().expect("shop").hits.push(path.to_string());
    }
}

async fn serve(shop: Shop) -> String {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
    listener.set_nonblocking(true).expect("nonblocking");
    let address = listener.local_addr().expect("addr");
    let port = address.port();
    let alt = std::net::TcpListener::bind(("127.0.0.2", port)).expect("alt bind");
    alt.set_nonblocking(true).expect("nonblocking");
    let bounce_to = format!("http://127.0.0.2:{port}/landed");
    let bounce_shop = shop.clone();
    let app = Router::new()
        .route("/", get(home))
        .route("/login", get(login))
        .route("/search", get(search))
        .route("/sku/{id}", get(sku_page))
        .route("/sku/{id}/save", post(save))
        .route("/orders", get(orders))
        .route("/order/{id}", get(order_page))
        .route("/trap", get(trap))
        .route(
            "/bounce",
            get(move || {
                let shop = bounce_shop.clone();
                let location = bounce_to.clone();
                async move {
                    shop.hit("/bounce");
                    (StatusCode::FOUND, [("location", location)])
                }
            }),
        )
        .route("/landed", get(landed))
        .with_state(shop);
    let alt_app = app.clone();
    let listener = tokio::net::TcpListener::from_std(listener).expect("tokio");
    let alt = tokio::net::TcpListener::from_std(alt).expect("tokio");
    tokio::spawn(async move {
        axum::serve(listener, app).await.expect("serve");
    });
    tokio::spawn(async move {
        axum::serve(alt, alt_app).await.expect("serve alt");
    });
    tokio::time::sleep(Duration::from_millis(30)).await;
    format!("http://{address}")
}

fn mock_config(base: &str) -> PortalConfig {
    let mut config = PortalConfig::tcgplayer_defaults();
    config.base_url = base.to_string();
    config.allowed_origins = vec![base.to_string()];
    config.paths.login_markers = vec!["/login".to_string()];
    config.note.clear();
    config
}

async fn launch(base: &str, chrome: &Path, profile: &Path) -> BrowserPortal {
    BrowserPortal::launch(LaunchOptions {
        profile_dir: profile.to_path_buf(),
        chrome: Some(chrome.to_path_buf()),
        headless: true,
        config: mock_config(base),
        action_gap_ms: (0, 0),
    })
    .await
    .expect("chrome")
}

fn page(title: &str, body: &str) -> Html<String> {
    Html(format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>{title}</title>\
         <style>body{{margin:16px;font:16px sans-serif}}input,button{{display:block;margin:8px 0;padding:8px;font-size:16px}}</style>\
         </head><body>{body}</body></html>"
    ))
}

fn signed_in_mark() -> &'static str {
    "<div data-signed-in>seller</div>"
}

async fn maybe_slow(shop: &Shop) {
    let slow = shop.0.lock().expect("shop").slow;
    if slow {
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
}

async fn home(State(shop): State<Shop>) -> Html<String> {
    shop.hit("/");
    maybe_slow(&shop).await;
    let guard = shop.0.lock().expect("shop");
    if guard.signed_out {
        return login_html();
    }
    match guard.captcha {
        Captcha::HomeTitle => page("Just a moment...", signed_in_mark()),
        Captcha::HomeFrame => page("Home", &format!("{signed}<iframe src=\"/vendor/recaptcha/api.js\"></iframe>", signed = signed_in_mark())),
        _ => page("Home", signed_in_mark()),
    }
}

fn login_html() -> Html<String> {
    page(
        "Sign in",
        "<form data-login action=\"/login\" method=\"post\">\
           <input name=\"username\" id=\"username\" autocomplete=\"username\">\
           <input type=\"password\" name=\"password\" id=\"password\" autocomplete=\"current-password\">\
         </form>",
    )
}

async fn login(State(shop): State<Shop>) -> Html<String> {
    shop.hit("/login");
    login_html()
}

async fn trap(State(shop): State<Shop>) -> Html<String> {
    shop.hit("/trap");
    page(
        "Trap",
        "<input name=\"quantity\" id=\"qty\" value=\"\" onfocus=\"document.getElementById('overlay-pass').focus()\">\
         <input type=\"password\" id=\"overlay-pass\" name=\"password\" value=\"\">",
    )
}

async fn landed(State(shop): State<Shop>) -> Html<String> {
    shop.hit("/landed");
    page("Landed", "<p>landed</p>")
}

async fn search(State(shop): State<Shop>) -> Html<String> {
    shop.hit("/search");
    maybe_slow(&shop).await;
    let guard = shop.0.lock().expect("shop");
    if guard.signed_out {
        return login_html();
    }
    let mut rows = String::new();
    for item in guard.skus.iter().filter(|item| item.listed) {
        rows.push_str(&row_html(item));
    }
    if guard.ambiguous {
        rows.push_str(&row_html(&sku("NM-EN-2", "Near Mint", "Normal", "English", "1", "1.00", true)));
    }
    page("Search", &format!("{signed}<table>{rows}</table>", signed = signed_in_mark()))
}

fn row_html(item: &Sku) -> String {
    format!(
        "<tr class=\"product-row\" data-sku=\"{}\"><td data-condition>{}</td><td data-printing>{}</td><td data-language>{}</td></tr>",
        item.id, item.condition, item.printing, item.language
    )
}

async fn sku_page(State(shop): State<Shop>, UrlPath(id): UrlPath<String>) -> Html<String> {
    shop.hit(&format!("/sku/{id}"));
    maybe_slow(&shop).await;
    let guard = shop.0.lock().expect("shop");
    if guard.captcha == Captcha::SkuFrame {
        return page("SKU", &format!("{signed}<iframe src=\"/vendor/recaptcha/api.js\"></iframe>", signed = signed_in_mark()));
    }
    if guard.signed_out {
        return login_html();
    }
    let Some(item) = guard.skus.iter().find(|item| item.id == id) else {
        return page("Missing", "<p>missing sku</p>");
    };
    page(
        "SKU",
        &format!(
            "{signed}\
             <input name=\"quantity\" value=\"{qty}\">\
             <input name=\"price\" value=\"{price}\">\
             <button type=\"button\" data-save>Save</button>\
             <div id=\"notice\"></div>\
             <script>\
               document.querySelector(\"button[data-save]\").addEventListener(\"click\", async () => {{\
                 const qty = document.querySelector(\"input[name='quantity']\").value;\
                 const price = document.querySelector(\"input[name='price']\").value;\
                 const res = await fetch(location.pathname + \"/save\", {{\
                   method: \"POST\",\
                   headers: {{\"content-type\": \"application/x-www-form-urlencoded\"}},\
                   body: \"quantity=\" + encodeURIComponent(qty) + \"&price=\" + encodeURIComponent(price)\
                 }});\
                 document.querySelector(\"#notice\").innerHTML = res.ok ? \"<div data-saved>Saved</div>\" : \"<div data-error>Could not save</div>\";\
               }});\
             </script>",
            signed = signed_in_mark(),
            qty = item.quantity,
            price = item.price,
        ),
    )
}

async fn save(State(shop): State<Shop>, UrlPath(id): UrlPath<String>, body: String) -> StatusCode {
    shop.hit(&format!("POST /sku/{id}/save"));
    maybe_slow(&shop).await;
    let mut guard = shop.0.lock().expect("shop");
    if guard.save_fails {
        return StatusCode::INTERNAL_SERVER_ERROR;
    }
    let quantity = form_value(&body, "quantity");
    let price = form_value(&body, "price");
    guard.posts.push((id.clone(), quantity.clone(), price.clone()));
    if !guard.revert {
        if let Some(item) = guard.skus.iter_mut().find(|item| item.id == id) {
            item.quantity = quantity;
            item.price = price;
        }
    }
    StatusCode::OK
}

fn form_value(body: &str, key: &str) -> String {
    for pair in body.split('&') {
        let Some((name, value)) = pair.split_once('=') else { continue };
        if name == key {
            return value.replace('+', " ");
        }
    }
    String::new()
}

async fn orders(State(shop): State<Shop>, Query(query): Query<HashMap<String, String>>) -> Html<String> {
    shop.hit("/orders");
    maybe_slow(&shop).await;
    let guard = shop.0.lock().expect("shop");
    if guard.signed_out {
        return login_html();
    }
    let page_no = query.get("page").and_then(|value| value.parse::<u32>().ok()).unwrap_or(1);
    let mut body = String::from(signed_in_mark());
    for order in sample_orders().into_iter().filter(|order| order.page == page_no) {
        body.push_str(&format!(
            "<div data-order><span data-order-id>{}</span><span data-order-date>{}</span><span data-order-status>{}</span><span data-order-buyer>{}</span></div>",
            order.id, order.date, order.status, order.buyer
        ));
    }
    if page_no == 1 {
        body.push_str("<a data-next href=\"/orders?page=2\">Next</a>");
    }
    page("Orders", &body)
}

struct SampleOrder {
    page: u32,
    id: &'static str,
    date: &'static str,
    status: &'static str,
    buyer: &'static str,
    total: &'static str,
    line_sku: &'static str,
    line_name: &'static str,
    line_qty: &'static str,
    line_price: &'static str,
}

fn sample_orders() -> Vec<SampleOrder> {
    vec![
        SampleOrder {
            page: 1,
            id: "ORD-1",
            date: "2026-10-15T12:00:00Z",
            status: "Ready to Ship",
            buyer: "Ada",
            total: "$1,234.56",
            line_sku: "NM-EN",
            line_name: "Eevee",
            line_qty: "2",
            line_price: "$1.50",
        },
        SampleOrder {
            page: 2,
            id: "ORD-2",
            date: "2026-10-13T08:00:00Z",
            status: "Shipped",
            buyer: "Grace",
            total: "$4.00",
            line_sku: "LP-EN",
            line_name: "Pikachu",
            line_qty: "1",
            line_price: "$4.00",
        },
        SampleOrder {
            page: 2,
            id: "ORD-3",
            date: "2026-10-01T00:00:00Z",
            status: "Delivered",
            buyer: "Old",
            total: "$2.00",
            line_sku: "NM-JP",
            line_name: "Mew",
            line_qty: "1",
            line_price: "$2.00",
        },
    ]
}

async fn order_page(State(shop): State<Shop>, UrlPath(id): UrlPath<String>) -> Html<String> {
    shop.hit(&format!("/order/{id}"));
    maybe_slow(&shop).await;
    let guard = shop.0.lock().expect("shop");
    if guard.signed_out {
        return login_html();
    }
    let Some(order) = sample_orders().into_iter().find(|order| order.id == id) else {
        return page("Missing", "<p>missing order</p>");
    };
    page(
        "Order",
        &format!(
            "{signed}\
             <span data-order-id>{id}</span>\
             <span data-order-date>{date}</span>\
             <span data-order-status>{status}</span>\
             <span data-order-buyer>{buyer}</span>\
             <span data-order-total>{total}</span>\
             <span data-shipping-method>Ground</span>\
             <span data-ship-name>{buyer} Buyer</span>\
             <span data-ship-line1>1 Market</span>\
             <span data-ship-line2>Apt 2</span>\
             <span data-ship-city>Springfield</span>\
             <span data-ship-state>IL</span>\
             <span data-ship-zip>62701</span>\
             <span data-ship-country>US</span>\
             <div data-line data-sku=\"{line_sku}\"><span data-line-name>{line_name}</span><span data-line-qty>{line_qty}</span><span data-line-price>{line_price}</span></div>",
            signed = signed_in_mark(),
            id = order.id,
            date = order.date,
            status = order.status,
            buyer = order.buyer,
            total = order.total,
            line_sku = order.line_sku,
            line_name = order.line_name,
            line_qty = order.line_qty,
            line_price = order.line_price,
        ),
    )
}

fn target(kind: &str, external_id: &str, quantity: i64, price: Option<i64>) -> ListingTarget {
    ListingTarget {
        listing_id: "listing-1".into(),
        external_id: external_id.into(),
        quantity,
        price_cents: price,
        card_name: "Eevee".into(),
        set_name: "Jungle".into(),
        collector_number: "51/64".into(),
        condition: "NM".into(),
        language: "EN".into(),
        kind: kind.into(),
        ..ListingTarget::default()
    }
}

#[tokio::test]
async fn signed_in_follows_the_mock_session() {
    let Some(chrome) = chrome_path() else { return };
    let profile = Profile::new();
    let shop = shop();
    let base = serve(shop.clone()).await;
    let portal = launch(&base, &chrome, &profile.0).await;
    shop.0.lock().expect("shop").signed_out = true;
    let err = portal.signed_in().await.expect_err("signed out");
    assert!(matches!(err, PortalError::SignedOut));
    shop.0.lock().expect("shop").signed_out = false;
    assert!(portal.signed_in().await.expect("signed in"));
}

#[tokio::test]
async fn captcha_blocks_and_the_runner_stops_the_batch() {
    let Some(chrome) = chrome_path() else { return };
    let profile = Profile::new();
    let shop = shop();
    let base = serve(shop.clone()).await;
    let portal = launch(&base, &chrome, &profile.0).await;

    shop.0.lock().expect("shop").captcha = Captcha::HomeFrame;
    let err = portal.signed_in().await.expect_err("frame");
    assert!(matches!(err, PortalError::Blocked(reason) if reason.to_lowercase().contains("recaptcha")));

    shop.0.lock().expect("shop").captcha = Captcha::HomeTitle;
    let err = portal.signed_in().await.expect_err("title");
    assert!(matches!(err, PortalError::Blocked(reason) if reason.to_lowercase().contains("just a moment")));

    shop.0.lock().expect("shop").captcha = Captcha::SkuFrame;
    let (api_base, mock) = api_server(vec![set_qty_job(1, "NM-EN", 3), set_qty_job(2, "NM-EN", 4)]).await;
    let api = Client::new(&api_base, "pkn_testtokenvalue").expect("client");
    run_once(&api, &portal).await.expect("run");
    let guard = mock.lock().expect("mock");
    assert_eq!(guard.claim_calls, 1);
    assert_eq!(guard.completes.len(), 2);
    assert!(guard.completes.iter().all(|row| row["outcome"] == "needs_sign_in"));
    let stopped = guard.heartbeats.iter().find(|row| row["running"] == false).expect("heartbeat");
    let error = stopped["error"].as_str().unwrap();
    assert!(error.contains("blocked:"));
    assert!(error.contains("recaptcha"));
    assert!(error.contains("open the box's Chrome window and clear it"));
}

#[tokio::test]
async fn set_quantity_writes_a_change_and_skips_an_equal_value() {
    let Some(chrome) = chrome_path() else { return };
    let profile = Profile::new();
    let shop = shop();
    {
        let mut guard = shop.0.lock().expect("shop");
        guard.skus.iter_mut().find(|item| item.id == "NM-EN").expect("sku").quantity = "2".into();
    }
    let base = serve(shop.clone()).await;
    let portal = launch(&base, &chrome, &profile.0).await;
    let same = portal.set_quantity(&target("set_qty", "NM-EN", 2, None)).await.expect("same");
    assert!(!same.changed);
    assert!(shop.0.lock().expect("shop").posts.is_empty());
    let changed = portal.set_quantity(&target("set_qty", "NM-EN", 5, None)).await.expect("changed");
    assert!(changed.changed);
    assert_eq!(changed.external_id, "NM-EN");
    let guard = shop.0.lock().expect("shop");
    assert_eq!(guard.posts.len(), 1);
    assert_eq!(guard.posts[0].1, "5");
    assert_eq!(guard.skus.iter().find(|item| item.id == "NM-EN").expect("sku").quantity, "5");
}

#[tokio::test]
async fn set_price_sends_dollars_from_cents() {
    let Some(chrome) = chrome_path() else { return };
    let profile = Profile::new();
    let shop = shop();
    let base = serve(shop.clone()).await;
    let portal = launch(&base, &chrome, &profile.0).await;
    let wrote = portal.set_price(&target("set_price", "PRICE-1", 2, Some(38369))).await.expect("price");
    assert!(wrote.changed);
    let guard = shop.0.lock().expect("shop");
    assert_eq!(guard.posts.len(), 1);
    assert_eq!(guard.posts[0].2, "383.69");
    assert_eq!(guard.skus.iter().find(|item| item.id == "PRICE-1").expect("sku").price, "383.69");
}

#[tokio::test]
async fn set_listing_picks_one_sku_and_rejects_zero_or_many() {
    let Some(chrome) = chrome_path() else { return };
    let profile = Profile::new();
    let shop = shop();
    let base = serve(shop.clone()).await;
    let portal = launch(&base, &chrome, &profile.0).await;
    let mut listing = target("push_listing", "", 4, Some(2500));
    let wrote = portal.set_listing(&listing).await.expect("match");
    assert_eq!(wrote.external_id, "NM-EN");
    assert!(wrote.changed);
    assert_eq!(shop.0.lock().expect("shop").skus.iter().find(|item| item.id == "NM-EN").expect("sku").quantity, "4");

    listing.language = "KO".into();
    let err = portal.set_listing(&listing).await.expect_err("none");
    assert!(matches!(err, PortalError::Permanent(message) if message.contains("no matching TCGplayer SKU")));

    listing.language = "EN".into();
    shop.0.lock().expect("shop").ambiguous = true;
    let err = portal.set_listing(&listing).await.expect_err("many");
    assert!(matches!(err, PortalError::Permanent(message) if message.contains("ambiguous SKU")));
}

#[tokio::test]
async fn a_rejected_or_unstick_save_is_transient() {
    let Some(chrome) = chrome_path() else { return };
    let profile = Profile::new();
    let shop = shop();
    let base = serve(shop.clone()).await;
    let portal = launch(&base, &chrome, &profile.0).await;
    shop.0.lock().expect("shop").save_fails = true;
    let err = portal.set_quantity(&target("set_qty", "NM-EN", 9, None)).await.expect_err("reject");
    assert!(matches!(err, PortalError::Transient(_)));
    {
        let mut guard = shop.0.lock().expect("shop");
        guard.save_fails = false;
        guard.revert = true;
        guard.posts.clear();
    }
    let err = portal.set_quantity(&target("set_qty", "NM-EN", 9, None)).await.expect_err("revert");
    assert!(matches!(err, PortalError::Transient(message) if message.contains("did not stick")));
    let guard = shop.0.lock().expect("shop");
    assert_eq!(guard.skus.iter().find(|item| item.id == "NM-EN").expect("sku").quantity, "1");
}

#[tokio::test]
async fn the_guard_refuses_credentials_and_foreign_origins() {
    let Some(chrome) = chrome_path() else { return };
    let profile = Profile::new();
    let shop = shop();
    let base = serve(shop).await;
    let portal = launch(&base, &chrome, &profile.0).await;
    portal.navigate(&format!("{base}/login")).await.expect("login page");
    let username = portal.type_into("input[name='username']", "seller").await.expect_err("username");
    assert!(matches!(username, PortalError::Permanent(message) if message == "refusing to type into a credentials field"));
    let password = portal.type_into("input[name='password']", "secret").await.expect_err("password");
    assert!(matches!(password, PortalError::Permanent(message) if message == "refusing to type into a credentials field"));
    let elsewhere = portal.navigate("http://example.com/").await.expect_err("origin");
    assert!(matches!(elsewhere, PortalError::Permanent(message) if message.contains("allowed origins")));
    portal.navigate(&format!("{base}/sku/NM-EN")).await.expect("sku");
    portal.type_into("input[name='quantity']", "3").await.expect("qty");
    portal.type_into("input[name='price']", "4.50").await.expect("price");
}

#[tokio::test]
async fn a_click_that_moves_focus_types_nothing() {
    let Some(chrome) = chrome_path() else { return };
    let profile = Profile::new();
    let shop = shop();
    let base = serve(shop).await;
    let portal = launch(&base, &chrome, &profile.0).await;
    portal.navigate(&format!("{base}/trap")).await.expect("trap");
    let stolen = portal.type_into("input[name='quantity']", "9").await.expect_err("focus");
    assert!(matches!(stolen, PortalError::Permanent(message) if message == "focus is not on the checked field"));
    assert_eq!(portal.input_value("input[name='quantity']").await.expect("qty"), "");
    assert_eq!(portal.input_value("#overlay-pass").await.expect("password"), "");
}

#[tokio::test]
async fn a_redirect_off_the_allow_list_pauses_and_a_chosen_foreign_url_fails() {
    let Some(chrome) = chrome_path() else { return };
    let profile = Profile::new();
    let shop = shop();
    let base = serve(shop).await;
    let portal = launch(&base, &chrome, &profile.0).await;
    let port = base.rsplit_once(':').expect("port").1;
    let bounced = portal.navigate(&format!("{base}/bounce")).await.expect_err("redirect");
    assert!(matches!(bounced, PortalError::Blocked(reason) if reason == format!("redirected to http://127.0.0.2:{port}")));
    let chosen = portal.navigate("http://example.com/").await.expect_err("origin");
    assert!(matches!(chosen, PortalError::Permanent(message) if message.contains("allowed origins")));
}

#[tokio::test]
async fn check_stops_on_a_challenge_and_a_sku_read_posts_nothing() {
    let Some(chrome) = chrome_path() else { return };
    let profile = Profile::new();
    let shop = shop();
    let base = serve(shop.clone()).await;
    let portal = launch(&base, &chrome, &profile.0).await;

    shop.0.lock().expect("shop").captcha = Captcha::HomeTitle;
    let stopped = portal.check(None).await.expect("challenge");
    assert!(stopped.contains("stopped: challenge:"), "{stopped}");
    assert!(!stopped.contains("search:"), "{stopped}");
    assert!(!shop.0.lock().expect("shop").hits.iter().any(|hit| hit == "/search"));

    shop.0.lock().expect("shop").captcha = Captcha::Off;
    let report = portal.check(Some("NM-EN")).await.expect("sku");
    assert!(report.contains("sku selectors found: quantity input, price input, save button"), "{report}");
    assert!(report.contains("quantity: 1"), "{report}");
    assert!(report.contains("price: 1.00"), "{report}");
    let guard = shop.0.lock().expect("shop");
    assert!(guard.posts.is_empty());
    assert!(!guard.hits.iter().any(|hit| hit.starts_with("POST ")));
}

#[tokio::test]
async fn fetch_orders_parses_two_pages_and_stops_at_since() {
    let Some(chrome) = chrome_path() else { return };
    let profile = Profile::new();
    let shop = shop();
    let base = serve(shop).await;
    let portal = launch(&base, &chrome, &profile.0).await;
    let orders = portal.fetch_orders(Some("2026-10-14T00:00:00Z")).await.expect("orders");
    assert_eq!(orders.len(), 2);
    assert_eq!(orders[0]["externalOrderId"], "ORD-1");
    assert_eq!(orders[0]["totalCents"], 123_456);
    assert_eq!(orders[0]["currency"], "USD");
    assert_eq!(orders[0]["placedAt"], "2026-10-15T12:00:00Z");
    assert_eq!(orders[0]["shipTo"]["city"], "Springfield");
    assert_eq!(orders[0]["lines"][0]["externalId"], "NM-EN");
    assert_eq!(orders[0]["lines"][0]["priceCents"], 150);
    assert_eq!(orders[0]["lines"][0]["quantity"], 2);
    assert_eq!(orders[1]["externalOrderId"], "ORD-2");
    assert!(orders.iter().all(|order| order["externalOrderId"] != "ORD-3"));
}

#[tokio::test]
async fn run_once_pushes_prices_and_pulls_orders() {
    let Some(chrome) = chrome_path() else { return };
    let profile = Profile::new();
    let shop = shop();
    let base = serve(shop.clone()).await;
    let portal = launch(&base, &chrome, &profile.0).await;
    let jobs = vec![
        json!({
            "jobId": 1,
            "leaseToken": "lease-1",
            "kind": "push_listing",
            "listingId": "listing-1",
            "externalId": "",
            "quantity": 4,
            "priceCents": 2500,
            "cardName": "Eevee",
            "setName": "Jungle",
            "collectorNumber": "51/64",
            "condition": "NM",
            "language": "EN",
            "reverse": false,
            "firstEdition": false
        }),
        json!({
            "jobId": 2,
            "leaseToken": "lease-2",
            "kind": "set_price",
            "listingId": "listing-2",
            "externalId": "PRICE-1",
            "quantity": 2,
            "priceCents": 38369,
            "condition": "NM",
            "language": "EN"
        }),
        json!({"jobId": 3, "leaseToken": "lease-3", "kind": "pull_orders", "since": "2026-10-14T00:00:00Z"}),
    ];
    let (api_base, mock) = api_server(jobs).await;
    let api = Client::new(&api_base, "pkn_testtokenvalue").expect("client");
    run_once(&api, &portal).await.expect("run");
    let guard = mock.lock().expect("mock");
    assert_eq!(guard.completes.len(), 3);
    assert!(guard.completes.iter().all(|row| row["outcome"] == "done"));
    assert_eq!(guard.completes[0]["externalId"], "NM-EN");
    assert_eq!(guard.posted_orders.len(), 2);
    assert_eq!(guard.posted_orders[0]["totalCents"], 123_456);
    assert_eq!(guard.posted_orders[0]["lines"][0]["externalId"], "NM-EN");
    drop(guard);
    let shop = shop.0.lock().expect("shop");
    assert_eq!(shop.skus.iter().find(|item| item.id == "NM-EN").expect("sku").quantity, "4");
    assert_eq!(shop.skus.iter().find(|item| item.id == "NM-EN").expect("sku").price, "25.00");
    assert_eq!(shop.skus.iter().find(|item| item.id == "PRICE-1").expect("sku").price, "383.69");
}

fn set_qty_job(id: i64, external_id: &str, quantity: i64) -> Value {
    json!({
        "jobId": id,
        "leaseToken": format!("lease-{id}"),
        "kind": "set_qty",
        "listingId": format!("listing-{id}"),
        "externalId": external_id,
        "quantity": quantity,
        "condition": "NM",
        "language": "EN"
    })
}

#[derive(Clone, Default)]
struct ApiMock {
    inner: Arc<Mutex<ApiInner>>,
}

#[derive(Default)]
struct ApiInner {
    claim_calls: u32,
    completes: Vec<Value>,
    heartbeats: Vec<Value>,
    posted_orders: Vec<Value>,
    jobs: Vec<Value>,
}

async fn api_server(jobs: Vec<Value>) -> (String, Arc<Mutex<ApiInner>>) {
    let mock = ApiMock::default();
    mock.inner.lock().expect("mock").jobs = jobs;
    let state = mock.inner.clone();
    let app = Router::new().route(
        "/api/channel-sync/device",
        post(move |State(mock): State<ApiMock>, headers: axum::http::HeaderMap, Json(body): Json<Value>| async move {
            let auth = headers.get("authorization").and_then(|value| value.to_str().ok()).unwrap_or("");
            if auth != "Bearer pkn_testtokenvalue" {
                return (StatusCode::UNAUTHORIZED, Json(json!({"error": "no"})));
            }
            let mut guard = mock.inner.lock().expect("mock");
            match body["action"].as_str().unwrap_or("") {
                "heartbeat" => {
                    guard.heartbeats.push(body);
                    (StatusCode::OK, Json(json!({"enabled": true, "pollAfterMs": 30000})))
                }
                "claim" => {
                    guard.claim_calls += 1;
                    let jobs = guard.jobs.clone();
                    (StatusCode::OK, Json(json!({"jobs": jobs})))
                }
                "complete" => {
                    guard.completes.push(body);
                    (StatusCode::OK, Json(json!({"ok": true})))
                }
                "orders" => {
                    if let Some(orders) = body["orders"].as_array() {
                        guard.posted_orders.extend(orders.clone());
                    }
                    (StatusCode::OK, Json(json!({"orders": 1})))
                }
                _ => (StatusCode::BAD_REQUEST, Json(json!({"error": "unknown"}))),
            }
        }),
    ).with_state(mock);
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
    listener.set_nonblocking(true).expect("nonblocking");
    let address = listener.local_addr().expect("addr");
    let listener = tokio::net::TcpListener::from_std(listener).expect("tokio");
    tokio::spawn(async move {
        axum::serve(listener, app).await.expect("serve");
    });
    tokio::time::sleep(Duration::from_millis(30)).await;
    (format!("http://{address}"), state)
}
