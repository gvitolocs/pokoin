# Meili `effective_print_bucket` (print-universe filter)

## Why

Typeahead / search print chips (Western / Japanese / Korean / Chinese) are a
**hard candidate universe**, not a post-top-K display preference.

Canonical classification lives in:

- `pokoin-web/market/src/print-bucket.js`
- `cardvault/.../api/_print_bucket.js` (mirror)

Priority: explicit printing nationality → expansion nationality → `unknown`.
Empty is **never** silently `western`.

## Index field

| Field | Meaning |
| --- | --- |
| `nationality` | Expansion nationality stamped at sync time (may be empty) |
| `effective_print_bucket` | `western` \| `japanese` \| `korean` \| `chinese` \| `indonesian` \| `thai` \| `idth` \| `unknown` |

`filterableAttributes` includes `effective_print_bucket` and `nationality`
(`api/_meili_document.js`).

Suggest/search Meili queries add:

```text
effective_print_bucket = "western"
```

when `print_language=western` (etc.). If the live index lacks the filterable
attribute yet, the API catches the Meili error, retrieves unfiltered, and
still **post-filters** with `effectivePrintBucket` before the 20-cap.

## Reindex (do not run against production from this change alone)

From `cardvault/pokemon_card_vault` with writer/replica `MARKETPLACE_DATABASE_URL`
and Meili env (`MEILI_HOST`, `MEILI_API_KEY`, `MEILI_MARKETPLACE_INDEX`):

```bash
# 1) Patch settings (adds filterableAttributes)
node -e "const {meiliRequest}=require('./api/_meili_client'); const {meiliMarketplaceIndexName}=require('./api/_meili_marketplace'); const {meiliMarketplaceIndexSettings}=require('./api/_meili_document'); (async()=>{ const i=meiliMarketplaceIndexName(); await meiliRequest('/indexes/'+encodeURIComponent(i)+'/settings',{method:'PATCH',body:meiliMarketplaceIndexSettings()}); console.log('settings patched', i); })().catch(e=>{console.error(e); process.exit(1);})"

# 2) Full document rebuild (stamps nationality + effective_print_bucket)
node scripts/meili-sync-marketplace-full.js
```

Delta sync (`meili-sync-marketplace-delta.js`) also uses
`MARKETPLACE_MEILI_SYNC_SELECT` / `mapMarketplaceMeiliDoc`, so ongoing updates
pick up the new fields after the full pass.

## Revert

1. Remove `effective_print_bucket` / `nationality` from
   `meiliMarketplaceIndexSettings()` + `mapMarketplaceMeiliDoc`.
2. Re-PATCH settings and re-sync (or leave stale fields unused — filters
   simply stop being sent when code reverts).
3. SPA/API post-filter via `effectivePrintBucket` remains correct even without
   the Meili filter.

## Verification

```bash
# After reindex: filtered estimatedTotalHits must differ from all-print
curl -sS "$MEILI_HOST/indexes/$MEILI_MARKETPLACE_INDEX/search" \
  -H "Authorization: Bearer $MEILI_API_KEY" \
  -H 'Content-Type: application/json' \
  --data '{"q":"palkia legend","filter":["language = \\"en\\"","effective_print_bucket = \\"western\\""],"limit":1}'
```
