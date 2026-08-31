const toggle = document.querySelector(".nav-toggle");
const navLinks = document.querySelector(".nav-links");
const nav = document.querySelector(".nav");

if (toggle && navLinks) {
  const mobileNav = () => window.matchMedia("(max-width: 991px)").matches;
  const setMenuOpen = (open) => {
    toggle.classList.toggle("is-open", open);
    navLinks.classList.toggle("is-open", open);
    toggle.setAttribute("aria-expanded", String(open));
    if (mobileNav()) navLinks.setAttribute("aria-hidden", String(!open));
    else navLinks.removeAttribute("aria-hidden");
    document.body.style.overflow = open ? "hidden" : "";
  };
  toggle.addEventListener("click", () => {
    setMenuOpen(!toggle.classList.contains("is-open"));
  });
  navLinks.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => setMenuOpen(false));
  });
}

if (nav) {
  const onScroll = () => {
    nav.classList.toggle("is-scrolled", window.scrollY > 10);
  };
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.getRegistrations().then((regs) => {
    regs.forEach((r) => r.unregister());
  }).catch(() => {});
}

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function staggerDelay(el) {
  if (el.dataset.delay != null && el.dataset.delay !== "") {
    return Number(el.dataset.delay);
  }
  if (el.classList.contains("reveal-fade")) return 300;
  const parent = el.parentElement;
  if (!parent) return 0;
  const sibs = [...parent.children].filter((n) => n.classList.contains("reveal"));
  const idx = Math.max(0, sibs.indexOf(el));
  return Math.min(idx, 3) * 150;
}

const revealEls = document.querySelectorAll(".reveal");
if (reduceMotion) {
  revealEls.forEach((el) => el.classList.add("is-visible"));
} else {
  const revealObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          revealObserver.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.15, rootMargin: "0px 0px -40px 0px" }
  );
  revealEls.forEach((el) => {
    const delay = staggerDelay(el);
    if (el.matches(".store-btn, .btn-dark")) {
      el.style.transitionDelay = `0ms, ${delay}ms, ${delay}ms`;
    } else {
      el.style.transitionDelay = `${delay}ms`;
    }
    revealObserver.observe(el);
  });
}

function animateCounter(el) {
  const text = el.textContent.trim();
  const match = text.match(/^(\d+)/);
  if (!match) return;
  const target = parseInt(match[1], 10);
  if (!target) return;
  const duration = 2000;
  const start = performance.now();
  const tick = (now) => {
    if (el._countCancelled) return;
    const t = Math.min(1, (now - start) / duration);
    el.textContent = String(Math.round(target * t));
    if (t < 1) {
      el._countTimer = requestAnimationFrame(tick);
    } else {
      el.textContent = String(target);
      el._countTimer = 0;
    }
  };
  el._countTimer = requestAnimationFrame(tick);
}

if (!reduceMotion) {
  const counters = document.querySelectorAll("[data-count]");
  const countObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting && !entry.target.classList.contains("counted")) {
          entry.target.classList.add("counted");
          animateCounter(entry.target);
        }
      });
    },
    { threshold: 0.5 }
  );
  counters.forEach((counter) => countObserver.observe(counter));
}

const heightEl = document.querySelector("[data-height]");
const peerEl = document.querySelector("[data-peers]");
const healthEl = document.querySelector("[data-health]");
const peerList = document.querySelector("[data-peer-list]");

function fill(el, value) {
  if (!el) return;
  el._countCancelled = true;
  if (el._countTimer) {
    cancelAnimationFrame(el._countTimer);
    el._countTimer = 0;
  }
  el.classList.add("counted");
  el.textContent = value;
}

function flagEmoji(cc) {
  if (!/^[A-Za-z]{2}$/.test(cc || "")) return "";
  return String.fromCodePoint(
    ...[...cc.toUpperCase()].map((c) => 127397 + c.charCodeAt(0))
  );
}

function placeText(geo) {
  if (!geo) return "";
  const city = geo.city || "";
  const country = geo.country || "";
  const cc = (geo.countryCode || "").toUpperCase();
  const place = [city, country].filter(Boolean).join(", ");
  const code = cc ? ` [${cc}]` : "";
  const flag = flagEmoji(cc);
  return [flag, `${place}${code}`].filter(Boolean).join(" ").trim();
}

function peerRow(peer, fallbackHeight) {
  const row = document.createElement("div");
  row.className = "peer";
  const left = document.createElement("span");
  const dot = document.createElement("span");
  dot.className = "dot";
  const place = placeText(peer);
  left.append(dot, place ? ` ${place}` : " peer");
  const right = document.createElement("span");
  const height = peer.chainHeight != null ? peer.chainHeight : fallbackHeight;
  right.className = "live";
  right.textContent = height ? `bootstrap · height ${height}` : "bootstrap";
  row.append(left, right);
  return row;
}

const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 400));

function prefetchMarketplace() {
  if (window.__pokoinMarketPrefetch) return;
  window.__pokoinMarketPrefetch = true;
  fetch("/marketplace", { credentials: "same-origin" })
    .then((r) => r.text())
    .then((html) => {
      const doc = new DOMParser().parseFromString(html, "text/html");
      doc.querySelectorAll("script[src], link[rel='stylesheet'], link[rel='modulepreload']").forEach((el) => {
        const href = el.getAttribute("src") || el.getAttribute("href");
        if (!href) return;
        const link = document.createElement("link");
        link.rel = el.tagName === "SCRIPT" || el.getAttribute("rel") === "modulepreload" ? "modulepreload" : "prefetch";
        link.href = href;
        document.head.appendChild(link);
      });
    })
    .catch(() => {});
  fetch("/api/marketplace-home-page", { headers: { Accept: "application/json" } }).catch(() => {});
  fetch("/api/marketplace-expansion-page?limit=48&offset=0&productType=card&slug=mega-evolution", {
    headers: { Accept: "application/json" },
  }).catch(() => {});
}

document.querySelectorAll('a[href="/marketplace"], a[href="/marketplace/"]').forEach((a) => {
  a.addEventListener("pointerenter", prefetchMarketplace, { once: true });
  a.addEventListener("focus", prefetchMarketplace, { once: true });
});

idle(() => {
  prefetchMarketplace();
  fetch("https://rpc.pokoin.com/health", { cache: "no-store" })
    .then((r) => r.json())
    .then((d) => {
      if (d.chainHeight != null) fill(heightEl, String(d.chainHeight));
      if (d.status) fill(healthEl, d.status);
    })
    .catch(() => {});
  fetch("https://rpc.pokoin.com/network/peer-status.json", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      if (!d) return;
      const live = (d.peers || []).filter((p) => p.reachable !== false);
      const count = d.livePeerCount != null ? d.livePeerCount : live.length;
      if (count) fill(peerEl, String(count));
      if (!peerList || !live.length) return;
      const height = d.chainHeight != null ? d.chainHeight : heightEl ? heightEl.textContent : "";
      peerList.replaceChildren(...live.map((p) => peerRow(p, height)));
    })
    .catch(() => {});
});
