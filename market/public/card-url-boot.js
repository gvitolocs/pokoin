if ("serviceWorker" in navigator) {
  navigator.serviceWorker.getRegistrations().then(function (regs) {
    regs.forEach(function (r) { r.unregister(); });
  });
}

// Path slugs from market/src/game.js. Pokemon stays unprefixed.
// Subdomains match gameIdFromHost (onepiece.* / riftbound.*).
var GAME_API = {
  "one-piece": "one_piece",
  "riftbound": "riftbound",
  "magic": "magic",
  "yugioh": "yugioh",
  "lorcana": "lorcana",
  "flesh-and-blood": "flesh_and_blood",
  "digimon": "digimon",
  "dragon-ball-super": "dragon_ball_super",
  "vanguard": "vanguard",
  "star-wars": "star_wars",
  "union-arena": "union_arena",
  "gundam": "gundam",
  "sorcery": "sorcery",
  "palworld": "palworld",
  "cyberpunk": "cyberpunk",
  "weiss-schwarz": "weiss_schwarz",
  "force-of-will": "force_of_will",
  "world-of-warcraft": "world_of_warcraft",
  "battle-spirits-saga": "battle_spirits_saga",
  "final-fantasy": "final_fantasy",
  "star-wars-destiny": "star_wars_destiny",
  "the-spoils": "the_spoils",
  "my-little-pony": "my_little_pony",
  "dragon-born": "dragon_born"
};

// Optional game prefix, then /marketplace/{lang}/cards/{id}/{slug}.
// Lang keeps the old 2-letter (and en-us) shape and adds zht.
var CARD_BOOT_RE = /^\/(?:([a-z0-9-]+)\/)?marketplace\/(zht|[a-z]{2}(?:-[a-z]{2})?)\/cards\/(\d+)(?:\/([^/?#]+))?$/i;

function hostApiGame(hostname) {
  var host = String(hostname || "").toLowerCase().split(":")[0];
  if (host === "onepiece.pokoin.com" || host.indexOf("onepiece.") === 0) return "one_piece";
  if (host === "riftbound.pokoin.com" || host.indexOf("riftbound.") === 0) return "riftbound";
  return "";
}

/**
 * The desk's first fetchCard / fetchCanonicalPath, as a same-origin URL.
 * Query order matches URLSearchParams then withGameQuery's &game=.
 * Headers match gameRequestHeaders so the edge cache key
 * (path + search + x-pokoin-game + x-pokoin-host) is the same request.
 */
function cardBootPlan(pathname, hostname) {
  var path = String(pathname || "").replace(/\/$/, "");
  var match = path.match(CARD_BOOT_RE);
  if (!match) return null;
  var gameSlug = (match[1] || "").toLowerCase();
  if (gameSlug && !GAME_API[gameSlug]) return null;
  var lang = match[2].toLowerCase();
  var id = match[3];
  var slug = match[4] || "";
  var apiGame = gameSlug ? GAME_API[gameSlug] : hostApiGame(hostname);
  var host = String(hostname || "").toLowerCase().split(":")[0];
  var pageParams = new URLSearchParams();
  pageParams.set("cardId", id);
  pageParams.set("lang", lang);
  if (slug) pageParams.set("slug", slug);
  var pageUrl = "/api/marketplace-card-page?" + pageParams.toString();
  var urlParams = new URLSearchParams();
  urlParams.set("cardId", id);
  urlParams.set("language", lang);
  var urlUrl = "/api/marketplace-card-url?" + urlParams.toString();
  if (apiGame) {
    var gameQuery = "&game=" + encodeURIComponent(apiGame);
    pageUrl += gameQuery;
    urlUrl += gameQuery;
  }
  var headers = { Accept: "application/json" };
  if (apiGame) {
    headers["x-pokoin-game"] = apiGame;
    headers["x-pokoin-host"] = host;
  }
  return {
    pageUrl: pageUrl,
    urlUrl: urlUrl,
    headers: headers,
    lang: lang,
    id: id,
    slug: slug,
    apiGame: apiGame
  };
}

// The SPA calls api.pokoin.com (extension-auth-bridge.js PUBLIC_API_ORIGIN), not
// same-origin /api: prefetch that exact URL so the desk read is a browser-cache
// hit (card-page max-age=10) instead of a second request through the Worker.
var API_ORIGIN = "https://api.pokoin.com";

function startCardUrlBoot() {
  if (typeof location === "undefined" || typeof fetch !== "function") return;
  var plan = cardBootPlan(location.pathname, location.hostname);
  if (!plan) return;
  fetch(API_ORIGIN + plan.urlUrl, {
    headers: plan.headers
  }).then(function (res) {
    return res.ok ? res.json() : null;
  }).then(function (data) {
    var next = data && (data.canonicalPath || data.canonical_path);
    if (!next) return;
    var clean = String(next).split(/[?#]/)[0].replace(/\/$/, "");
    if (clean && clean !== location.pathname.replace(/\/$/, "")) {
      history.replaceState(history.state, "", next);
    }
  }).catch(function () {});
  // One card-page prefetch. The desk's fetchCard uses this same URL and
  // the same game headers, so the edge serves that response instead of
  // building the page again.
  fetch(API_ORIGIN + plan.pageUrl, {
    headers: plan.headers
  }).catch(function () {});
}

if (typeof location !== "undefined" && typeof fetch === "function") {
  startCardUrlBoot();
}
