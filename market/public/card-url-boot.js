if ("serviceWorker" in navigator) {
  navigator.serviceWorker.getRegistrations().then(function (regs) {
    regs.forEach(function (r) { r.unregister(); });
  });
}
(function () {
  var path = location.pathname.replace(/\/$/, "");
  var match = path.match(/^\/marketplace\/([a-z]{2}(?:-[a-z]{2})?)\/cards\/(\d+)(?:\/[^/?#]+)?$/i);
  if (!match) {
    return;
  }
  var lang = match[1].toLowerCase();
  var id = match[2];
  // Warm the exact URL the desk's first fetchCard will use — same slug,
  // same cache key — so the edge/origin hit once instead of twice.
  var slug = (match[3] || "").replace(/^\/+/, "");
  fetch("/api/marketplace-card-url?cardId=" + encodeURIComponent(id) + "&language=" + encodeURIComponent(lang), {
    headers: { Accept: "application/json" },
  }).then(function (res) {
    return res.ok ? res.json() : null;
  }).then(function (data) {
    var next = data && (data.canonicalPath || data.canonical_path);
    if (!next) {
      return;
    }
    var clean = String(next).split(/[?#]/)[0].replace(/\/$/, "");
    if (clean && clean !== location.pathname.replace(/\/$/, "")) {
      history.replaceState(history.state, "", next);
    }
  }).catch(function () {});
  var pageUrl = "/api/marketplace-card-page?cardId=" + encodeURIComponent(id) + "&lang=" + encodeURIComponent(lang);
  if (slug) {
    pageUrl += "&slug=" + encodeURIComponent(slug);
  }
  fetch(pageUrl, {
    headers: { Accept: "application/json" },
  }).catch(function () {});
})();
