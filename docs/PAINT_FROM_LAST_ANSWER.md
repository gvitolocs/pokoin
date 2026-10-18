# Paint from the last answer

Giuseppe (2026-10-18): "all around the site things get refreshed even if
nothing has changed … just leave it and load the refetch when things change."

This is the rule for every page and panel:

1. **Paint from the last answer.** When this browser has seen the data, the
   first frame shows it. Use memory, a synchronous `localStorage` copy for
   small things, and the IndexedDB stores for big ones. Never show a skeleton,
   an empty state or a default value first, then swap.
2. **Revalidate in the background.** Use a cheap freshness check: a stamp
   (`stamp=1` for MyPokoin, `fresh=1` for shops), an ETag, or the Cloudflare
   HTTP cache. Never use Worker logic.
3. **Change the DOM only when the data differs.** Reconcile rows by id (a
   Solid store `reconcile`, `reconcileRows`, or `<For keyed={(row) => id}>`).
   An answer equal to the painted one changes nothing: same nodes, same image
   URLs.
4. **Skeletons are the last resort.** They wait 250 ms before showing (the
   `skel-appear` rule in `market/src/styles.css`). That covers `.tile-skel`,
   `.shop-row-skel`, `.skeleton-*` and `.wait-text`. Always reserve their
   space.

## Where the last answers live

| What | Store | Wiped |
| --- | --- | --- |
| Seller's own book (MyPokoin, Collection, dashboard) | IndexedDB `pokoin-private`, `market/src/inventory-book.js` | Sign-out; other accounts on sign-in |
| Pricer settings, CardTrader link state, cart recommendations | `localStorage` `pokoin.pricer-settings.v1`, `pokoin.ctStatus.v1`, `pokoin.cartRecs.v1` | Sign-out (`wipePrivateBooks`) |
| Card desk listings and rarity select rows | `localStorage` `pokoin.deskListings.v1`, `pokoin.deskVersions.v1` (`market/src/desk-listings-store.js`), 24 desks, 3 days | Expiry |
| Set print nationality (desk language and flag) | `localStorage` `pokoin.printNationality.v1` | Never changes |
| Image URLs that failed and the sibling that loaded (`_homepage.webp` thumbs, `.jpg`→`.webp` scans, missing wordmarks and symbols) | `localStorage` `pokoin.imgFallback.v1` (`market/src/image-fallback-memo.js`); a dead image for 1 day, a working sibling for 7 | Expiry |
| Seller shop header (name, photo, item counts) | `localStorage` `pokoin-seller-identity` (`market/src/seller-seed.js`) | 200 newest |
| Artist albums this browser stored | `localStorage` `pokoin.artistAlbums.v1`: the live 48-tile page waits 300 ms for IndexedDB | 200 newest |
| Catalogue reads (sets, artists, names, shops, card pages) | IndexedDB `pokoin-local` (`market/src/local-store.js`) | Dictionary version |

Signed-in panels read the cached session (`signedIn()`, `authSession()`), not
`authUser()`. `authUser()` is undefined until Firebase answers on every reload.

## Measuring

The reload churn probe and its harness (outside the repo, on nezopt
`~/tmp/mypokoin-swr`) record, for a reload with unchanged data, every removed
node, text, `src` and class change, skeleton and layout shift. The before and
after numbers are in the PR that introduced this file.
