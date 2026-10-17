#!/usr/bin/env node
/** Render the same public product HTML for visitors and crawlers; no UA branching. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCT_PAGES } from "../content/product-pages.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ORIGIN = "https://pokoin.com";
export const PRODUCT_SITEMAP = "sitemap-product-pages.xml";
export const escapeHtml = (value = "") =>
  String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
const link = ({ label, href }, className = "") =>
  `<a${className ? ` class="${className}"` : ""} href="${escapeHtml(href)}">${escapeHtml(label)} <span aria-hidden="true">↗</span></a>`;
const dateLabel = (date) =>
  new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00Z`));

export function pageBreadcrumbs(page) {
  const parentPath = `/${page.path.split("/")[1]}`;
  const parent = PRODUCT_PAGES.find((item) => item.path === parentPath);
  return [
    { label: "Home", href: "/" },
    ...(parent && parent.path !== page.path
      ? [{ label: parent.label, href: parent.path }]
      : []),
    { label: page.label, href: page.path },
  ];
}

export function productStructuredData(page) {
  const url = `${ORIGIN}${page.path}`;
  const breadcrumbs = pageBreadcrumbs(page);
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": `${ORIGIN}/#organization`,
        name: "Pokoin",
        url: `${ORIGIN}/`,
        logo: `${ORIGIN}/home/logo.png`,
      },
      {
        "@type": page.kind === "hub" ? "CollectionPage" : "WebPage",
        "@id": `${url}#webpage`,
        url,
        name: page.title,
        description: page.description,
        inLanguage: "en",
        dateModified: page.reviewed,
        publisher: { "@id": `${ORIGIN}/#organization` },
        isPartOf: { "@id": `${ORIGIN}/#website` },
        about: { "@id": `${ORIGIN}/#software` },
        breadcrumb: { "@id": `${url}#breadcrumb` },
        ...(page.sources?.length
          ? { citation: page.sources.map((source) => source.href) }
          : {}),
      },
      {
        "@type": "BreadcrumbList",
        "@id": `${url}#breadcrumb`,
        itemListElement: breadcrumbs.map((item, index) => ({
          "@type": "ListItem",
          position: index + 1,
          name: item.label,
          item: `${ORIGIN}${item.href}`,
        })),
      },
      {
        "@type": "WebApplication",
        "@id": `${ORIGIN}/#software`,
        name: "Pokoin",
        url: `${ORIGIN}/`,
        operatingSystem: "Web browser",
        applicationCategory: "LifestyleApplication",
        featureList: [
          "Trading card identification",
          "Collection and portfolio tracking",
          "Seller inventory",
          "Poko card assistant",
          "Trading card marketplace",
        ],
      },
    ],
  };
}

function sharedChrome(landing) {
  const header = landing.match(/<header class="nav">[\s\S]*?<\/header>/)?.[0];
  const footer = landing.match(
    /<footer class="site-footer pad">[\s\S]*?<\/footer>/,
  )?.[0];
  const cookie = landing.match(
    /<div\s+class="cookie-banner"[\s\S]*?<\/div>/,
  )?.[0];
  if (!header || !footer || !cookie)
    throw new Error(
      "Product pages require the landing header, footer, and cookie notice.",
    );
  return {
    header: header
      .replace('href="#scanner"', 'href="/features/card-scanner"')
      .replace('href="#inventory"', 'href="/features/card-inventory"')
      .replace('href="#poko"', 'href="/features/poko-assistant"'),
    footer,
    cookie,
  };
}

function visual(page) {
  if (page.visual === "credit" || page.visual === "managed") {
    const credit = page.visual === "credit";
    return `<div class="feature-visual visual-fees${credit ? "" : " visual-managed"}"><span>${credit ? "CARD TRADE-IN" : "MANAGED SELLING"}</span><strong class="fee-number">${credit ? "90" : "15.5"}<span>%</span></strong><p>${credit ? "Market value in PKN" : "Commission on sale"}</p><span>${credit ? "At least 1 PKN per card" : "Real-money proceeds after sale"}</span></div>`;
  }
  if (page.kind === "fees") {
    return `<div class="feature-visual visual-fees"><span>POKOIN MARKETPLACE</span><strong class="fee-number">3<span>%</span></strong><p>Buyer markup</p><span>No Pokoin marketplace seller commission</span><a href="#comparison">Compare the published rates ↓</a></div>`;
  }
  if (page.visual === "poko") {
    return `<div class="feature-visual visual-poko"><img src="/home/pokoin-mascot.png" width="150" height="139" alt="Poko, your card assistant"><p>Card questions?<br><strong>Start a conversation.</strong></p><span>Printings · Artists · Sold history</span></div>`;
  }
  const labels = {
    scan: ["Find the printing.", "Photo lookup · Phone camera · Scan Connect"],
    inventory: ["Give every card a place.", "Quantity · Condition · Location"],
    collection: [
      "Keep your card world together.",
      "Collection · Portfolio · Discovery",
    ],
    marketplace: [
      "Find your next favourite.",
      "Printings · Listings · Sold history",
    ],
    extension: [
      "Keep Pokoin by your side.",
      "Your browser · Your card workflow",
    ],
    compare: [
      "Your cards. Your next move.",
      "Scan · Collect · Organise · Ask Poko",
    ],
  };
  const [heading, note] = labels[page.visual] || labels.compare;
  return `<div class="feature-visual"><div class="visual-card-fan" aria-hidden="true"><img src="https://cdn.pokoin.com/251437_snorlax-181-165-pokemon-card-151_homepage.webp" width="155" height="217" alt=""><img src="https://cdn.pokoin.com/251431_psyduck-175-165-pokemon-card-151_homepage.webp" width="155" height="217" alt=""></div><p><strong>${escapeHtml(heading)}</strong></p><span>${escapeHtml(note)}</span></div>`;
}

function cards(paths, heading = "") {
  const items = paths.map((item) =>
    PRODUCT_PAGES.find((page) => page.path === item),
  );
  if (items.some((item) => !item))
    throw new Error(`Unknown product page in ${paths.join(", ")}`);
  return `${heading ? `<h2>${escapeHtml(heading)}</h2>` : ""}<div class="resource-grid">${items.map((page) => `<a class="resource-card" href="${page.path}"><span class="eyebrow">${escapeHtml(page.category)}</span><h3>${escapeHtml(page.label)}</h3><p>${escapeHtml(page.description)}</p><span class="resource-card-link">${page.kind === "comparison" ? "Read the comparison" : page.kind === "guide" ? "Follow the walkthrough" : "Explore the tool"} <span aria-hidden="true">↗</span></span></a>`).join("")}</div>`;
}

export function renderProductPage(page, options = {}) {
  const landing =
    options.landing ?? fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const { header, footer, cookie } = sharedChrome(landing);
  const url = `${ORIGIN}${page.path}`;
  const sections = page.sections || [];
  const breadcrumbs = pageBreadcrumbs(page);
  const structured = JSON.stringify(productStructuredData(page)).replace(
    /</g,
    "\\u003c",
  );
  const contents = [
    ...(page.rows
      ? [
          {
            id: "comparison",
            heading: page.tableHeading || "The workflow comparison",
          },
        ]
      : []),
    ...sections.map((item, index) => ({
      id: `section-${index + 1}`,
      heading: item.heading,
    })),
    ...(page.faqs?.length
      ? [{ id: "questions", heading: "Common questions" }]
      : []),
    ...(page.sources?.length
      ? [{ id: "sources", heading: "Sources and review" }]
      : []),
  ];
  const table = page.rows
    ? `<section id="comparison" class="article-section"><h2>${escapeHtml(page.tableHeading || "The workflow comparison")}</h2><p class="table-scroll-note">Scroll across the table to see every column.</p><div class="comparison-scroll${page.kind === "fees" ? " fee-table" : ""}" role="region" aria-label="${escapeHtml(page.tableLabel || `Pokoin and ${page.label} comparison`)}" tabindex="0"><table><caption>Workflow details reviewed ${dateLabel(page.reviewed)}. <a href="#sources">See primary sources.</a></caption><thead><tr>${(page.tableHeaders || ["What you are comparing", page.label, "Pokoin"]).map((heading) => `<th scope="col">${escapeHtml(heading)}</th>`).join("")}</tr></thead><tbody>${page.rows.map((row) => `<tr><th scope="row">${escapeHtml(row[0])}</th><td>${escapeHtml(row[1])}</td><td>${escapeHtml(row[2])}</td></tr>`).join("")}</tbody></table></div></section>`
    : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${escapeHtml(page.title)}</title><meta name="description" content="${escapeHtml(page.description)}"><meta name="robots" content="index, follow, max-image-preview:large"><meta name="theme-color" content="#08080a"><meta name="author" content="Pokoin"><link rel="canonical" href="${url}"><link rel="icon" href="/favicon.ico"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><link rel="manifest" href="/site.webmanifest">
<meta property="og:type" content="website"><meta property="og:site_name" content="Pokoin"><meta property="og:title" content="${escapeHtml(page.title)}"><meta property="og:description" content="${escapeHtml(page.description)}"><meta property="og:url" content="${url}"><meta property="og:image" content="${ORIGIN}/home/pokoin-product-1200x630.png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:image:alt" content="Pokoin scanner, collection, inventory, marketplace, and Poko assistant"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${escapeHtml(page.title)}"><meta name="twitter:description" content="${escapeHtml(page.description)}"><meta name="twitter:image" content="${ORIGIN}/home/pokoin-product-1200x630.png">
<link rel="preload" href="/home/satoshi.woff2" as="font" type="font/woff2" crossorigin><script src="/home/landing-boot.js"></script><link rel="stylesheet" href="/home/landing.css?v=20261017-market-data"><link rel="stylesheet" href="/home/discovery.css?v=20261017-market-data"><script type="application/ld+json">${structured}</script></head>
<body class="product-page"><a class="skip-link" href="#main">Skip to content</a>${header}
<main id="main"><section class="product-hero pad"><div class="wrap"><nav class="page-crumbs" aria-label="Breadcrumb"><ol>${breadcrumbs.map((item, index) => `<li>${index === breadcrumbs.length - 1 ? `<span aria-current="page">${escapeHtml(item.label)}</span>` : `<a href="${item.href}">${escapeHtml(item.label)}</a>`}</li>`).join("")}</ol></nav><div class="product-hero-layout${page.kind === "hub" ? " is-hub" : ""}"><div><p class="eyebrow">${escapeHtml(page.category)}</p><h1>${escapeHtml(page.headline)}</h1><p class="product-intro">${escapeHtml(page.intro)}</p><div class="button-row">${link(page.primary, "button button-yellow")}${link(page.secondary, "button button-outline")}</div><p class="review-line">By Pokoin · Reviewed <time datetime="${page.reviewed}">${dateLabel(page.reviewed)}</time>${page.kind === "comparison" ? " · Independent products; no affiliation implied." : ""}</p></div>${page.kind !== "hub" ? visual(page) : ""}</div></div></section>
<div class="pad"><div class="wrap"><div class="answer-box"><span class="eyebrow">At a glance</span><p>${escapeHtml(page.answer)}</p></div>${page.cards ? `<section class="hub-resources" aria-label="Explore ${escapeHtml(page.label)}"><h2 class="hub-resource-title">${page.path === "/alternatives" ? "Compare the workflows" : page.path === "/learn" ? "Choose your walkthrough" : "Explore the toolkit"}</h2>${cards(page.cards)}</section>` : ""}</div></div>
<div class="pad article-shell"><div class="wrap article-layout"><aside class="article-nav"><p class="eyebrow">On this page</p><nav aria-label="Page contents">${contents.map((item) => `<a href="#${item.id}">${escapeHtml(item.heading)}</a>`).join("")}</nav><a class="article-nav-all" href="/${page.path.split("/")[1]}">Explore ${page.kind === "comparison" ? "comparisons" : page.kind === "guide" ? "walkthroughs" : "Pokoin tools"} →</a></aside><article class="product-article">${page.competitorSummary ? `<section class="article-section"><h2>${escapeHtml(page.label)} at a glance</h2><p>${escapeHtml(page.competitorSummary)}</p><p class="article-source-link"><a href="#sources">Official sources and review details ↓</a></p></section>` : ""}${table}${sections.map((item, index) => `<section class="article-section" id="section-${index + 1}"><h2>${escapeHtml(item.heading)}</h2>${item.paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join("")}${item.links?.length ? `<div class="article-links">${item.links.map((item) => link(item)).join("")}</div>` : ""}</section>`).join("")}
${page.faqs?.length ? `<section class="article-section" id="questions"><h2>Common questions</h2><div class="faq-list">${page.faqs.map((item) => `<details><summary>${escapeHtml(item.question)} <span aria-hidden="true">＋</span></summary><div class="faq-content"><p>${escapeHtml(item.answer)}</p></div></details>`).join("")}</div></section>` : ""}
${page.sources?.length ? `<section class="article-section source-section" id="sources"><h2>Sources and review</h2><p>${page.kind === "comparison" ? "This comparison is published by Pokoin and focuses on the documented workflows above. Competitor details were checked against these primary sources on" : "The official source pages below were checked on"} <time datetime="${page.reviewed}">${dateLabel(page.reviewed)}</time>. Check the linked pages for current features, plans, and terms.</p><ul>${page.sources.map((item) => `<li>${link(item)}</li>`).join("")}</ul></section>` : ""}</article></div></div>
<section class="pad related-section"><div class="wrap">${cards(page.related || [], "Keep exploring")}</div></section><section class="pad product-cta"><div class="wrap"><div><p class="eyebrow">The next step is yours</p><h2>Start with a card.</h2><p>Find the printing. Explore the possibilities.</p></div><div class="button-row">${link(page.primary, "button button-yellow")}${link({ label: "All Pokoin tools", href: "/features" }, "button button-outline")}</div></div></section></main>${footer}${cookie}<script src="/home/landing.js?v=20261017-market-data" defer></script></body></html>`;
}

export function productPagesSitemap() {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${PRODUCT_PAGES.map((page) => `  <url><loc>${ORIGIN}${page.path}</loc><lastmod>${page.reviewed}</lastmod></url>`).join("\n")}\n</urlset>\n`;
}

export function productPageFile(output, page) {
  if (!/^\/(features|alternatives|learn)(\/[a-z0-9-]+)?$/.test(page.path))
    throw new Error(`Invalid public product route: ${page.path}`);
  return path.join(path.resolve(output), `${page.path.slice(1)}.html`);
}

export function buildProductPages(output = path.join(ROOT, "dist-web")) {
  const landing = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  for (const page of PRODUCT_PAGES) {
    const file = productPageFile(output, page);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, renderProductPage(page, { landing }));
  }
  fs.writeFileSync(path.join(output, PRODUCT_SITEMAP), productPagesSitemap());
  return PRODUCT_PAGES.length;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const output = path.resolve(process.argv[2] || path.join(ROOT, "dist-web"));
  console.log(
    `product pages: ${buildProductPages(output)} static HTML pages in ${output}`,
  );
}
