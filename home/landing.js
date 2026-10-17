const toggle = document.querySelector(".nav-toggle");
const navLinks = document.querySelector(".nav-links");
const nav = document.querySelector(".nav");
const mobileNav = window.matchMedia("(max-width: 720px)");
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

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

const revealEls = document.querySelectorAll(".reveal");
if (reduceMotion.matches || !("IntersectionObserver" in window)) {
  revealEls.forEach((el) => el.classList.add("is-visible"));
} else {
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      });
    },
    { threshold: 0.08 },
  );
  revealEls.forEach((el) => observer.observe(el));
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
  const accepted = (() => {
    try {
      if (localStorage.getItem(COOKIE_KEY) === "1") return true;
    } catch (_) {}
    try {
      return /(?:^|;\s*)pokoin_cookie_consent=1(?:;|$)/.test(document.cookie);
    } catch (_) {
      return false;
    }
  })();
  if (accepted) {
    cookieBanner.remove();
  } else {
    cookieBanner
      .querySelector("[data-cookie-accept]")
      ?.addEventListener("click", () => {
        try {
          localStorage.setItem(COOKIE_KEY, "1");
        } catch (_) {}
        try {
          const secure = location.protocol === "https:" ? "; Secure" : "";
          document.cookie = `${COOKIE_NAME}=1; Max-Age=31536000; Path=/; SameSite=Lax${secure}`;
        } catch (_) {}
        cookieBanner.remove();
      });
  }
}
