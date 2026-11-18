const toggle = document.querySelector(".nav-toggle");
const navLinks = document.querySelector(".nav-links");
const nav = document.querySelector(".nav");
const mobileNav = window.matchMedia("(max-width: 720px)");

if (toggle && navLinks) {
  const background = document.querySelectorAll(
    "main, .site-footer, .cookie-banner",
  );
  const setMenuOpen = (open, restoreFocus = false) => {
    open = open && mobileNav.matches;
    toggle.classList.toggle("is-open", open);
    navLinks.classList.toggle("is-open", open);
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
    document.body.style.overflow = open ? "hidden" : "";
    background.forEach((element) => {
      element.inert = open;
    });
    if (restoreFocus) toggle.focus();
  };
  toggle.addEventListener("click", () => {
    const open = toggle.getAttribute("aria-expanded") !== "true";
    setMenuOpen(open);
    if (open) navLinks.querySelector("a")?.focus();
  });
  navLinks.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => setMenuOpen(false));
  });
  document.addEventListener("keydown", (event) => {
    if (toggle.getAttribute("aria-expanded") !== "true") return;
    if (event.key === "Escape") {
      event.preventDefault();
      setMenuOpen(false, true);
    }
    if (event.key === "Tab") {
      const first = navLinks.querySelector("a");
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        toggle.focus();
      } else if (!event.shiftKey && document.activeElement === toggle) {
        event.preventDefault();
        first?.focus();
      }
    }
  });
  mobileNav.addEventListener("change", () => setMenuOpen(false));
}

if (nav) {
  const onScroll = () =>
    nav.classList.toggle("is-scrolled", window.scrollY > 10);
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });
}

const tabs = [...document.querySelectorAll('.demo-tabs [role="tab"]')];
const activateTab = (tab, focus = false) => {
  tabs.forEach((item) => {
    const active = item === tab;
    item.setAttribute("aria-selected", String(active));
    item.tabIndex = active ? 0 : -1;
    const panel = document.getElementById(item.getAttribute("aria-controls"));
    if (panel) panel.hidden = !active;
  });
  if (focus) tab.focus();
};
tabs.forEach((tab, index) => {
  tab.addEventListener("click", () => activateTab(tab));
  tab.addEventListener("keydown", (event) => {
    let next;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    if (event.key === "ArrowLeft")
      next = (index - 1 + tabs.length) % tabs.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = tabs.length - 1;
    if (next == null) return;
    event.preventDefault();
    activateTab(tabs[next], true);
  });
});

let marketPrefetched = false;
function prefetchMarketplace() {
  if (marketPrefetched || navigator.connection?.saveData) return;
  marketPrefetched = true;
  fetch("/marketplace", { credentials: "same-origin" })
    .then((response) => (response.ok ? response.text() : ""))
    .then((html) => {
      const doc = new DOMParser().parseFromString(html, "text/html");
      doc
        .querySelectorAll(
          'script[src], link[rel="stylesheet"], link[rel="modulepreload"]',
        )
        .forEach((element) => {
          const href =
            element.getAttribute("src") || element.getAttribute("href");
          if (!href) return;
          const link = document.createElement("link");
          link.rel = "prefetch";
          link.href = href;
          document.head.appendChild(link);
        });
    })
    .catch(() => {});
}
document.querySelectorAll('a[href="/marketplace"]').forEach((link) => {
  link.addEventListener("pointerenter", prefetchMarketplace, { once: true });
  link.addEventListener("focus", prefetchMarketplace, { once: true });
});

// Share the existing consent key and cookie with the marketplace SPA.
const COOKIE_KEY = "pokoin.cookieConsent";
const COOKIE_NAME = "pokoin_cookie_consent";
const cookieBanner = document.querySelector("[data-cookie-banner]");
if (cookieBanner) {
  // "1" = all cookies, "essential" = sign-in and cart only (market/src/cookie-consent.js).
  const answered = (() => {
    try {
      if (/^(1|essential)$/.test(localStorage.getItem(COOKIE_KEY) || "")) return true;
    } catch (_) {}
    try {
      return /(?:^|;\s*)pokoin_cookie_consent=(1|essential)(?:;|$)/.test(document.cookie);
    } catch (_) {
      return false;
    }
  })();
  const answer = (value) => () => {
    try {
      localStorage.setItem(COOKIE_KEY, value);
    } catch (_) {}
    try {
      const secure = location.protocol === "https:" ? "; Secure" : "";
      document.cookie = `${COOKIE_NAME}=${value}; Max-Age=31536000; Path=/; SameSite=Lax${secure}`;
    } catch (_) {}
    cookieBanner.remove();
  };
  if (answered) {
    cookieBanner.remove();
  } else {
    cookieBanner.querySelector("[data-cookie-accept]")?.addEventListener("click", answer("1"));
    cookieBanner.querySelector("[data-cookie-essential]")?.addEventListener("click", answer("essential"));
  }
}

// Account button: landing-boot.js already painted "Log in" or the session's
// username (a CSS string). Write the real text and point a signed-in visitor
// straight at MyPokoin instead of the sign-in page.
if (document.documentElement.classList.contains("signed-in")) {
  const name = (() => {
    try {
      const raw = getComputedStyle(document.documentElement).getPropertyValue("--account-name").trim();
      return raw ? JSON.parse(raw) : "";
    } catch (_) {
      return "";
    }
  })();
  document.querySelectorAll("[data-account-link]").forEach((link) => {
    link.setAttribute("href", "/mypokoin");
    link.removeAttribute("rel");
    const label = link.querySelector("[data-account-name]");
    if (label && name) label.textContent = name;
  });
}

// The hero's endless float/scan/marquee loops pause once it scrolls away.
const hero = document.querySelector(".home-hero");
if (hero && typeof IntersectionObserver === "function") {
  new IntersectionObserver((entries) => {
    for (const entry of entries) hero.classList.toggle("is-offscreen", !entry.isIntersecting);
  }).observe(hero);
}
