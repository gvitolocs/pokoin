document.documentElement.classList.add("js");
try {
  if (localStorage.getItem("pokoin.cookieConsent") === "1" || /(?:^|;\s*)pokoin_cookie_consent=1(?:;|$)/.test(document.cookie)) {
    document.documentElement.classList.add("cookies-ok");
  }
} catch (e) {}
// Account button paint hint: the marketplace's last-known session
// (market/src/auth-session.js, localStorage or the .pokoin.com cookie).
// Runs in <head> so a signed-in visitor never sees "Log in" first; the
// name is a CSS string until landing.js writes the real text.
var signedIn = false;
try {
  var raw = null;
  try {
    raw = localStorage.getItem("pokoin.auth.session");
  } catch (e) {}
  if (!raw) {
    var m = /(?:^|;\s*)pokoin\.auth\.session\.cookie=([^;]*)/.exec(document.cookie);
    if (m) raw = decodeURIComponent(m[1]);
  }
  var s = raw ? JSON.parse(raw) : null;
  if (s && s.signedIn === true && String(s.uid || "").trim()) {
    var name = String(s.username || "").replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 32);
    signedIn = true;
    document.documentElement.classList.add("signed-in");
    document.documentElement.style.setProperty("--account-name", JSON.stringify(name || "My Pokoin"));
    // The binder's stored first page for this uid (market/src/landing-binder.js):
    // home.css holds the demo cards back while the island paints it.
    try {
      var page = JSON.parse(localStorage.getItem("pokoin.landing.binder.v1") || "null");
      if (page && page.uid === String(s.uid).trim()) document.documentElement.classList.add("binder-mine");
    } catch (e) {}
  }
} catch (e) {}
if (!signedIn) {
  try {
    localStorage.removeItem("pokoin.landing.binder.v1");
  } catch (e) {}
}
