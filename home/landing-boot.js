document.documentElement.classList.add("js");
try {
  if (localStorage.getItem("pokoin.cookieConsent") === "1" || /(?:^|;\s*)pokoin_cookie_consent=1(?:;|$)/.test(document.cookie)) {
    document.documentElement.classList.add("cookies-ok");
  }
} catch (e) {}
