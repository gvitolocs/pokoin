import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  FEATURES,
  ALTERNATIVES,
  GUIDES,
  PRODUCT_PAGES,
  productPageForPath,
} from "../content/product-pages.mjs";
import {
  buildProductPages,
  escapeHtml,
  productPageFile,
  productPagesSitemap,
  productStructuredData,
  renderProductPage,
} from "./build-product-pages.mjs";
import {
  applyRedirect,
  writeCloudflareRouting,
} from "./write-cloudflare-web-routing.mjs";
import { CHECKOUT_COMMISSION_RATE } from "../market/src/checkout-fees.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const landing = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const hrefs = (html) =>
  [...html.matchAll(/href="([^"#][^"]*)"/g)].map((match) =>
    match[1].replaceAll("&amp;", "&"),
  );
const isProductPath = (href) =>
  /^\/(features|alternatives|learn)(\/|$)/.test(href);

test("every discovery page has unique identity, a canonical, complete text, and matching schema", () => {
  for (const field of ["path", "title", "description"]) {
    assert.equal(
      new Set(PRODUCT_PAGES.map((page) => page[field])).size,
      PRODUCT_PAGES.length,
      field,
    );
  }
  for (const page of PRODUCT_PAGES) {
    const html = renderProductPage(page, { landing });
    assert.equal((html.match(/<h1>/g) || []).length, 1, page.path);
    assert.match(
      html,
      new RegExp(
        `<link rel="canonical" href="https://pokoin.com${page.path}">`,
      ),
    );
    assert.ok(html.includes(escapeHtml(page.intro)), page.path);
    assert.ok(html.includes(escapeHtml(page.answer)), page.path);
    assert.match(html, /name="robots" content="index, follow/);
    assert.doesNotMatch(html, /noindex|aggregateRating|"offers"/);
    const graph = JSON.parse(
      html.match(
        /<script type="application\/ld\+json">([\s\S]*?)<\/script>/,
      )[1],
    )["@graph"];
    const webpage = graph.find(
      (node) =>
        node["@type"] === "WebPage" || node["@type"] === "CollectionPage",
    );
    assert.equal(webpage.url, `https://pokoin.com${page.path}`);
    assert.equal(webpage.name, page.title);
    assert.equal(webpage.dateModified, page.reviewed);
    assert.ok(html.includes(`datetime="${page.reviewed}"`));
    assert.ok(
      (page.sections || []).every((section) =>
        html.includes(escapeHtml(section.heading)),
      ),
    );
    assert.ok(
      graph.find((node) => node["@type"] === "BreadcrumbList").itemListElement
        .length >= 2,
    );
  }
});

test("homepage links lead to all public discovery pages without orphan routes", () => {
  const seen = new Set();
  const queue = hrefs(landing).filter(isProductPath);
  while (queue.length) {
    const href = queue.shift();
    const page = productPageForPath(href);
    assert.ok(page, `unknown public link: ${href}`);
    if (seen.has(page.path)) continue;
    seen.add(page.path);
    queue.push(
      ...hrefs(renderProductPage(page, { landing })).filter(isProductPath),
    );
  }
  assert.deepEqual(
    [...seen].sort(),
    PRODUCT_PAGES.map((page) => page.path).sort(),
  );
});

test("public pages link to real application actions and complete section anchors", () => {
  const files = [
    "solid/src/router.js",
    ...fs
      .readdirSync(path.join(ROOT, "solid/src/routes"))
      .filter((name) => name.endsWith(".js"))
      .map((name) => `solid/src/routes/${name}`),
  ];
  const routes = [
    ...files
      .map((file) => fs.readFileSync(path.join(ROOT, file), "utf8"))
      .join("\n")
      .matchAll(/path:\s*'([^']+)'/g),
  ]
    .map((match) => match[1])
    .filter((route) => !route.includes("*"));
  const patterns = routes.map(
    (route) =>
      new RegExp(
        `^${
          route === "/"
            ? ""
            : route
                .split("/")
                .filter(Boolean)
                .map((part) =>
                  part.startsWith(":")
                    ? part.endsWith("?")
                      ? "(?:/[^/]+)?"
                      : "/[^/]+"
                    : `/${part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
                )
                .join("")
        }/?$`,
      ),
  );
  for (const page of PRODUCT_PAGES) {
    const html = renderProductPage(page, { landing });
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
    assert.equal(new Set(ids).size, ids.length, `${page.path}: duplicate id`);
    for (const [, id] of html.matchAll(/href="#([^"]+)"/g))
      assert.ok(ids.includes(id), `${page.path}#${id}`);
    for (const href of hrefs(html)) {
      if (
        !href.startsWith("/") ||
        isProductPath(href) ||
        /\.[a-z0-9]+(?:\?|$)/.test(href)
      )
        continue;
      const plain = href
        .replace(/^\/(one-piece|magic|riftbound|yugioh|lorcana)(?=\/)/, "")
        .split("?")[0];
      assert.ok(
        patterns.some((regex) => regex.test(plain)),
        `${page.path}: unknown application action ${href}`,
      );
    }
  }
});

test("static artifact paths survive deployment routing and unknown pages do not become SPA content", () => {
  const output = fs.mkdtempSync(
    path.join(os.tmpdir(), "pokoin-product-pages-"),
  );
  try {
    buildProductPages(output);
    writeCloudflareRouting(output);
    for (const page of PRODUCT_PAGES) {
      const file = productPageFile(output, page);
      assert.ok(
        fs.readFileSync(file, "utf8").includes(escapeHtml(page.headline)),
      );
      assert.equal(
        applyRedirect(page.path),
        null,
        `${page.path}: hijacked by redirect/SPA rule`,
      );
      assert.equal(applyRedirect(`${page.path}/`), null);
    }
    assert.equal(
      fs.existsSync(path.join(output, "features/not-a-real-page.html")),
      false,
    );
    assert.throws(() =>
      productPageFile(output, { path: "/features/../../private" }),
    );
    assert.equal(productPageForPath("/features/not-a-real-page"), null);
    assert.equal(
      productPageForPath("/alternatives/collectr/").path,
      "/alternatives/collectr",
    );
    assert.match(
      fs.readFileSync(path.join(output, "sitemap-product-pages.xml"), "utf8"),
      /<lastmod>2026-10-17<\/lastmod>/,
    );
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
  }
});

test("sitemaps, legacy rewrites, and search-crawler permissions cover the public pages", () => {
  const xml = productPagesSitemap();
  assert.equal((xml.match(/<url>/g) || []).length, PRODUCT_PAGES.length);
  assert.match(
    fs.readFileSync(path.join(ROOT, "scripts/build-seo-sitemaps.mjs"), "utf8"),
    /'sitemap-product-pages.xml'/,
  );
  const vercel = JSON.parse(
    fs.readFileSync(path.join(ROOT, "vercel.json"), "utf8"),
  );
  for (const family of ["features", "alternatives", "learn"]) {
    assert.ok(
      vercel.rewrites.some(
        (rule) =>
          rule.source === `/${family}` &&
          rule.destination === `/${family}.html`,
      ),
    );
    assert.ok(
      vercel.rewrites.some(
        (rule) =>
          rule.source === `/${family}/:slug` &&
          rule.destination === `/${family}/:slug.html`,
      ),
    );
  }
  // Use an independent standard parser to catch specific-bot groups losing the private rules.
  const result = execFileSync(
    "python3",
    [
      "-c",
      `
import urllib.robotparser,json
r=urllib.robotparser.RobotFileParser()
r.parse(open(${JSON.stringify(path.join(ROOT, "robots.txt"))}).read().splitlines())
print(json.dumps({u:{p:r.can_fetch(u,'https://pokoin.com'+p) for p in ['/features/card-scanner','/alternatives/collectr','/learn/import-card-inventory','/mypokoin','/messages/poko','/wallet']} for u in ['Googlebot','Bingbot','OAI-SearchBot','ExampleBot']}))
`,
    ],
    { encoding: "utf8" },
  );
  for (const [agent, paths] of Object.entries(JSON.parse(result))) {
    for (const [pathname, allowed] of Object.entries(paths))
      assert.equal(allowed, isProductPath(pathname), `${agent} ${pathname}`);
  }
});

test("comparisons cite primary sources and the advertised commission matches checkout and settlement", () => {
  for (const page of ALTERNATIVES) {
    assert.ok(page.sources.length > 0);
    assert.ok(
      page.sources.every((source) => source.href.startsWith("https://")),
    );
    assert.ok(page.rows.length >= 4);
    assert.ok(page.competitorSummary);
  }
  const feePage = FEATURES.find(
    (page) => page.path === "/features/seller-fees",
  );
  const advertised =
    Number(feePage.headline.match(/^(\d+(?:\.\d+)?)%/)[1]) / 100;
  assert.equal(
    advertised,
    CHECKOUT_COMMISSION_RATE,
    "review fee copy when checkout commission changes",
  );
  const backend = fs.readFileSync(
    path.join(ROOT, "pokoin-rust/crates/commerce/src/handlers/orders.rs"),
    "utf8",
  );
  assert.equal(
    advertised,
    Number(backend.match(/CHECKOUT_COMMISSION_RATE:\s*f64\s*=\s*([\d.]+)/)[1]),
    "review fee copy when buyer markup changes",
  );
  const settlement = fs.readFileSync(
    path.join(ROOT, "pokoin-rust/crates/commerce/src/domain/settlement.rs"),
    "utf8",
  );
  assert.equal(
    advertised,
    Number(settlement.match(/BUYER_MARKUP_BPS:\s*i64\s*=\s*(\d+)/)[1]) / 10000,
  );
  assert.match(
    feePage.sections.flatMap((section) => section.paragraphs).join(" "),
    /caps, minimums/,
  );
  assert.ok(GUIDES.length >= 2);
});

test("text and structured data stay inert when editorial text contains markup", () => {
  const page = {
    ...FEATURES[0],
    headline: "<img src=x onerror=alert(1)>",
    title: "</script><script>alert(1)</script>",
    description: 'A "quote" & a <tag>',
  };
  const html = renderProductPage(page, { landing });
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
  assert.doesNotMatch(html, /<script>alert\(1\)/);
  const json = html.match(
    /<script type="application\/ld\+json">([\s\S]*?)<\/script>/,
  )[1];
  assert.equal(JSON.parse(json)["@graph"][1].name, page.title);
});
