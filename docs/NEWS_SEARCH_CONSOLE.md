# Pokoin News — Search Console, Google News and Discover checklist

Google News no longer offers a manual application. A site is eligible
through its own technical and editorial signals and Google decides on
inclusion. **Eligibility is not inclusion.** Never claim Pokoin News appears
in Google News, Top Stories or Discover until Search Console shows it.

## 0. Before the first public article

- [ ] `pokoin-news` Worker route `pokoin.com/news*` attached (production change; needs approval).
- [ ] `SITE.publisher.legalName` / `address` in `news/lib/site.mjs` filled with the real legal entity, or a conscious decision to publish without them (transparency pages then show only "Pokoin" and the contact email).
- [ ] `robots.txt` deployed with the two news `Sitemap:` lines. Nothing disallows `/news`.
- [ ] The Cloudflare crawler-policy skip rule (`fd1dc4d1…`, verified Search Engine Crawler → skip SBFM, see [SEO.md](SEO.md)) also covers `/news*`. It matches on host, so no change is expected. Verify with a URL Inspection live test.

## 1. Search Console property

- [ ] The domain property `pokoin.com` (DNS-verified) already covers `/news`. If only a URL-prefix property exists, add `https://pokoin.com/`.
- [ ] Optional: add a URL-prefix property `https://pokoin.com/news/` to get news-only performance and indexing views.

## 2. Sitemaps

- [ ] Submit `https://pokoin.com/news-sitemap.xml` (Google News sitemap, last 48 h only; it may be empty between stories, which is valid).
- [ ] Submit `https://pokoin.com/news/sitemap.xml` (every article, section, author and policy page). The main index `sitemap.xml` also references it.
- [ ] Both report **Success** with a discovered-URL count matching `dist-news/build-report.json`.

## 3. URL Inspection (per representative template)

For one article of each template (breaking, reveal, fact check, market pulse, explainer):

- [ ] **Live test**: "URL is available to Google", "Page can be indexed".
- [ ] Rendered HTML (View tested page → HTML) contains the `<h1>`, the full body text and the "Published" `<time>`, without relying on JavaScript.
- [ ] **Detected structured data**: Article (NewsArticle) valid, plus Breadcrumbs. For a CONFIRMED/FALSE fact check, ClaimReview valid.
- [ ] The Google-selected canonical equals the user-declared canonical `https://pokoin.com/news/<slug>`.
- [ ] Request indexing for the first launch articles only (do not spam requests).

Off-Search-Console checks: the Rich Results Test (`https://search.google.com/test/rich-results`) and the Schema Markup Validator (`https://validator.schema.org/`) on the same URLs.

## 4. Reports to watch (once data exists)

| Report | Where | What we look for |
| --- | --- | --- |
| Page indexing | Indexing → Pages, filtered to `/news/` | Articles "Indexed"; investigate "Crawled – currently not indexed" and "Duplicate" |
| Sitemaps | Indexing → Sitemaps | news sitemap fetched regularly, no errors |
| News performance | Performance → **Google News** (appears only after Google News traffic exists) | clicks/impressions on news.google.com and the News app |
| Discover | Performance → **Discover** (appears only after Discover impressions reach Google's threshold) | impressions/CTR per article; image-led stories |
| Search | Performance → Search results, page filter `/news/` | queries, Top Stories appearances (search appearance filter) |
| Enhancements | Breadcrumbs / Article snippets / Review snippets | no invalid items |
| Core Web Vitals | Experience → Core Web Vitals (mobile) | `/news` URLs in "Good" |

Record what you observe (date, report, numbers) in the newsroom health notes.
`/api/poko/news/health` reports `searchConsole.status: "not_connected"`
until a Search Console API integration exists. It never estimates indexing.

## 5. Recurring

- [ ] Weekly: Page indexing for `/news/`, sitemap status, any manual action or security issue.
- [ ] After template or CSS changes: one URL Inspection live test plus Rich Results Test.
- [ ] After a correction: the page shows the correction note and `dateModified` moved. Re-inspect only if the headline changed.
