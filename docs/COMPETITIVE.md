# Competitive (Pokoin Oracle assets)

`/marketplace/competitive` is a **static tournament snapshot** (`market/src/data/limitless.json`), not a live Limitless scrape and not `GET /api/marketplace-competitive`.

Every picture on that tree is **same-origin Pokoin**:

`/card-images/competitive/{sprites|formats|scans|flags}/…`

Production `pokoin.com/card-images/*` is the `pokoin-cdn-card-images` Cloudflare Worker, which fetches the Raspberry Pi (`https://cdn.pokoin.com`, disk `/srv/pokoin/card-images/objects/competitive`). Vercel and local Vite proxy `/card-images/*` to that same Pi host. Do **not** hotlink `r2.limitlesstcg.net`, `limitless3.nyc3.cdn.digitaloceanspaces.com`, or `limitlesstcg.nyc3.cdn.digitaloceanspaces.com`. Tournament / deck / player / card **links** stay on `/marketplace/competitive/…`.

## URL helpers

`market/src/competitive-assets.js` (re-exported from `competitive.js`):

| Helper | Example |
| --- | --- |
| `SPRITE(name)` | `/card-images/competitive/sprites/dragapult.png` |
| `FORMAT(id)` | `/card-images/competitive/formats/standard.png` |
| `FLAG(cc)` | `/card-images/competitive/flags/us.svg` (ISO lowercase) |
| `scanUrl(set, num)` | `/card-images/competitive/scans/TWM_130_R_EN.png` |

Tests: `node --test market/src/competitive.test.js`.

Country flags are HatScripts [circle-flags](https://github.com/HatScripts/circle-flags) (MIT), same family as print flags in `market/public/flags/`. Language print flags stay in `/flags/{lang}.svg`. Competitive **country** flags are Oracle SVGs, not Limitless PNGs.

## Sync onto Oracle

```bash
scripts/sync-competitive-cdn.sh            # default host oracle-peer1
# python collector: scripts/sync-competitive-cdn.py
```

Reads the dump, downloads **missing** files only, rsyncs to `/home/ubuntu/pokoin-cdn/competitive/`.

| Kind | Source (one-time copy) | Disk key |
| --- | --- | --- |
| Deck sprites | Limitless gen9 PNG | `competitive/sprites/{name}.png` |
| Format badges | Limitless formats PNG | `competitive/formats/{id}.png` |
| Card scans | Limitless TPCI PNG | `competitive/scans/{SET}_{NNN}_R_EN.png` |
| Country flags | HatScripts circle-flags SVG | `competitive/flags/{cc}.svg` |

`pokoin-oracle-cdn-server.js` and the `pokoin-cdn-card-images` Worker
`keepRawObjectKey` include `competitive/` so those PNG/SVG files are **not**
rewritten to leftover JPEG. `pokoin.com/card-images/*` is that Worker, which
fetches the Pi (`cdn.pokoin.com`).

## Routes

| Path | Page |
| --- | --- |
| `/marketplace/competitive` | Overview: top decks + recent / upcoming / city leagues |
| `/marketplace/competitive/tournaments` | Completed / upcoming / city |
| `/marketplace/competitive/tournaments/:id` | Event standings + meta |
| `/marketplace/competitive/decks` | Archetype table (sprites) |
| `/marketplace/competitive/decks/:id` | Deck hero scan + results |
| `/marketplace/competitive/decklists/:id` | List columns → our card routes |
| `/marketplace/competitive/cards` | Snapshot card grid |
| `/marketplace/competitive/players` | Rankings + flags |

`DATA.latest.href` is `/marketplace/competitive/tournaments/515`, not `limitless-tournament.html`.

## Surfaces (CARD_ART Type G)

Sprites, format badges, country flags, and TPCI-style scans. `CardArt` as `<img>` only. **No** `cut`. **No** leftover `imageSrc` keys. Competitive is Pokemon-host only (`game.js` `features.competitive`).
