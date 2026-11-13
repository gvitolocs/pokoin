#!/usr/bin/env python3
"""Read-only public readiness check for a newly imported expansion, any game.

  scripts/check-new-set.sh "Delta Reign"                       # Pokémon (default)
  scripts/check-new-set.sh --game one_piece "EB-05: Heroines Edition Vol.2"

Every line is OK, MISSING or SKIPPED. SKIPPED means the step does not exist for
that game (the reason is printed). A step that fails, errors or cannot be
verified is MISSING and the exit status is 1. Only public GETs are made.
See docs/NEW_SET_IMPORT.md.
"""
import argparse
import json
import re
import sys
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
API = 'https://api.pokoin.com'
CDN = 'https://cdn.pokoin.com/'

# id -> (path slug, family). Mirrors market/src/game.js and INGEST_GAMES in
# pokoin-rust/crates/api-common/src/game.rs; the unit tests compare the ids to game.js.
# Families: pokemon (own DB, Redis search, CLIP versions), cardtrader and
# cardmarket (isolated satellite DB, Postgres search).
GAMES = {
    'pokemon': ('', 'pokemon'),
    'one_piece': ('one-piece', 'cardtrader'),
    'riftbound': ('riftbound', 'cardtrader'),
    'magic': ('magic', 'cardtrader'),
    'yugioh': ('yugioh', 'cardtrader'),
    'lorcana': ('lorcana', 'cardtrader'),
    'flesh_and_blood': ('flesh-and-blood', 'cardtrader'),
    'digimon': ('digimon', 'cardtrader'),
    'dragon_ball_super': ('dragon-ball-super', 'cardtrader'),
    'vanguard': ('vanguard', 'cardtrader'),
    'star_wars': ('star-wars', 'cardtrader'),
    'union_arena': ('union-arena', 'cardtrader'),
    'gundam': ('gundam', 'cardtrader'),
    'sorcery': ('sorcery', 'cardtrader'),
    'palworld': ('palworld', 'cardtrader'),
    'cyberpunk': ('cyberpunk', 'cardtrader'),
    'final_fantasy': ('final-fantasy', 'cardmarket'),
    'star_wars_destiny': ('star-wars-destiny', 'cardmarket'),
    'weiss_schwarz': ('weiss-schwarz', 'cardmarket'),
    'force_of_will': ('force-of-will', 'cardmarket'),
    'world_of_warcraft': ('world-of-warcraft', 'cardmarket'),
    'battle_spirits_saga': ('battle-spirits-saga', 'cardmarket'),
    'dragon_born': ('dragon-born', 'cardmarket'),
    'my_little_pony': ('my-little-pony', 'cardmarket'),
    'the_spoils': ('the-spoils', 'cardmarket'),
}
PRIZE_PACK_SLUG = re.compile(r'^play-pokemon-prize-pack-series(?:-|$)')
PRIZE_PACK_SYMBOL = ROOT / 'market/public/expansion-symbols/play-pokemon-prize-pack.png'


def normalize_game(value):
    """Game id for a CLI value (`one-piece`, `One_Piece`); None when unknown."""
    key = re.sub(r'[^a-z0-9]+', '_', (value or 'pokemon').strip().lower()).strip('_')
    if key in GAMES:
        return key
    for game_id, (slug, _family) in GAMES.items():
        if slug and key == slug.replace('-', '_'):
            return game_id
    return None


def slugify(name):
    value = unicodedata.normalize('NFKD', name)
    value = ''.join(c for c in value if not unicodedata.combining(c))
    return re.sub(r'[^a-z0-9]+', '-', value.lower().replace('&', ' and ')).strip('-')


def request(url, json_body=True):
    req = urllib.request.Request(url, headers={'User-Agent': 'pokoin-new-set-check/1.0'})
    with urllib.request.urlopen(req, timeout=15) as response:
        if json_body:
            return json.load(response)
        return response.status == 200 and response.headers.get_content_type().startswith('image/')


def webp_size(url):
    """(width, height) from the first bytes of a WebP file; None if not WebP."""
    req = urllib.request.Request(url, headers={'User-Agent': 'pokoin-new-set-check/1.0', 'Range': 'bytes=0-63'})
    with urllib.request.urlopen(req, timeout=15) as response:
        head = response.read(64)
    if head[:4] != b'RIFF' or head[8:12] != b'WEBP':
        return None
    kind = head[12:16]
    if kind == b'VP8 ':
        return (int.from_bytes(head[26:28], 'little') & 0x3FFF, int.from_bytes(head[28:30], 'little') & 0x3FFF)
    if kind == b'VP8L':
        bits = int.from_bytes(head[21:25], 'little')
        return ((bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1)
    if kind == b'VP8X':
        return (int.from_bytes(head[24:27], 'little') + 1, int.from_bytes(head[27:30], 'little') + 1)
    return None


def card_key(card):
    return str(card.get('card_id') or card.get('id') or '')


def suggest_ids(body):
    return {str(p.get('card_id') or p.get('id')) for g in body.get('groups', []) for p in g.get('printings', [])}


def is_single(card):
    return card.get('itemKind') == 'single' and card.get('productType') == 'card'


def cdn_url(path):
    return urllib.parse.urljoin(CDN, (path or '').replace('/card-images/', '', 1))


def query(path, game, **params):
    if game != 'pokemon':
        params['game'] = game
    return API + path + '?' + urllib.parse.urlencode(params)


def run(name, game='pokemon'):
    """Print one line per step. Returns the process exit status."""
    if game not in GAMES:
        print(f'ERROR: unknown game {game!r}; known: {", ".join(GAMES)}', file=sys.stderr)
        return 2
    prefix_slug, family = GAMES[game]
    pokemon = game == 'pokemon'
    failures = 0

    def report(ok, label, detail):
        nonlocal failures
        print(f'{"OK" if ok else "MISSING"}: {label}: {detail}')
        failures += not ok

    def skip(label, reason):
        print(f'SKIPPED: {label}: {reason}')

    def attempt(label, call):
        """Run a network step; a failed public request is MISSING, never swallowed."""
        try:
            return call(), True
        except urllib.error.HTTPError as error:
            body = error.read(200).decode('utf-8', 'replace') if hasattr(error, 'read') else ''
            report(False, label, f'HTTP {error.code} {body.strip()}')
        except (OSError, ValueError) as error:
            report(False, label, f'request failed: {error}')
        return None, False

    print(f'game: {game} ({family}); set: {name}')
    slug = slugify(name)
    if not pokemon:
        # Satellite catalogs are found through the set index; a slug miss is an
        # HTTP 500 there (no marketplace_card_versions table), so never guess.
        index, ok = attempt('catalog', lambda: request(query('/api/marketplace-expansion-page', game, limit=2000)))
        if not ok:
            return 1
        listed = [e for e in index.get('expansions') or [] if (e.get('name') or '').casefold() == name.casefold()]
        report(bool(listed), 'catalog (set index)', f'{len(index.get("expansions") or [])} sets listed; {"found" if listed else "no set named " + name}')
        if not listed:
            return 1
        slug = listed[0].get('slug') or slug
    page, ok = attempt('catalog', lambda: request(query('/api/marketplace-expansion-page', game, slug=slug, limit=400)))
    if not ok:
        return 1
    expansion, cards = page.get('expansion') or {}, page.get('cards') or []
    report(expansion.get('name', '').casefold() == name.casefold() and bool(cards), 'catalog', f'{expansion.get("cardCount", 0)} cards reported, slug {slug}')
    singles = [c for c in cards if is_single(c)]
    report(bool(singles), 'singles', f'{len(singles)} singles of {len(cards)} sampled (itemKind=single, productType=card)')
    if not singles:
        return 1
    card = singles[0]
    card_id = card_key(card)
    image = card.get('imageUrl') or ''
    image_url = cdn_url(image)
    expected = f'{prefix_slug}/' if prefix_slug else ''
    try:
        ct_id = int(card_id) // 2
    except ValueError:
        ct_id = None
    key = image.replace('/card-images/', '', 1)
    # Pokémon rows may carry the public id in the key (the SPA and CDN rewrite it
    # to the leftover ct_id, docs/GAMES.md); other games always use prefix + ct_id.
    wanted = [f'{expected}{ct_id}_'] + ([f'{card_id}_'] if pokemon else [])
    key_ok = ct_id is not None and key.startswith(tuple(wanted))
    report(key_ok, 'image key matches card id', f'{image or "absent"}: expects {" or ".join(w + "…" for w in wanted)} for public id {card_id}')
    image_ok, ok = attempt('image (one sample)', lambda: bool(image) and request(image_url, False))
    if ok:
        report(image_ok, 'image (one sample)', image_url)
    thumb = card.get('homepageImageUrl') or ''
    thumb_url = cdn_url(thumb)
    size, ok = attempt('thumbnail (one sample)', lambda: webp_size(thumb_url) if thumb else None)
    if ok and pokemon:
        report(bool(size) and size[0] == 480, 'thumbnail (one sample)', f'{thumb_url}: {size[0] if size else "not a WebP"} px wide, 480 expected')
    elif ok:
        report(bool(size), 'thumbnail (one sample)', f'{thumb_url}: {size[0] if size else "not a WebP"} px wide (width not asserted: only Pokémon has a 480 px contract)')
    version, ok = attempt('version set', lambda: request(query('/api/marketplace-version-set', game, cardId=card_id)))
    if ok and pokemon:
        report(bool(version.get('version')), 'version set (one sample)', f'{card_id}: {version.get("version") or "absent"}; singleton matches require review')
    elif ok:
        members = {card_key(p) for p in version.get('printings') or []}
        report(card_id in members, 'version set (name groups)', f'{card_id}: {version.get("version") or "absent"}, {len(members)} printings; CLIP artwork groups are Pokémon-only')
    by_name, ok = attempt('search index', lambda: request(query('/api/marketplace-suggest', game, q=card.get('name', ''), limit=24)))
    if ok:
        report(card_id in suggest_ids(by_name), 'search index (one sample)', f'{card_id} by card name')
    by_set, ok = attempt('set-name suggest', lambda: request(query('/api/marketplace-suggest', game, q=name, limit=24)))
    if ok:
        sample_ids = {card_key(c) for c in singles}
        returned = [p for g in by_set.get('groups', []) for p in g.get('printings', [])]
        returned_singles = [p for p in returned if is_single(p)]
        hits = sample_ids & {card_key(p) for p in returned_singles}
        report(bool(hits), 'set-name suggest', f'{len(returned)} printings returned, {len(returned_singles)} singles, {len(hits)} of the sampled singles; the API ranks sealed products first for a bare set name')
    if pokemon:
        set_file = (ROOT / 'market/src/data/suggest-sets.js').read_text()
        report(f'"slug":"{slug}"' in set_file, 'local suggest set catalog', slug)
    else:
        skip('local suggest set catalog', 'market/src/data/suggest-sets.js is the Pokémon typeahead vocabulary; other games search Postgres')
    symbol = expansion.get('symbolImageUrl') or expansion.get('defaultSymbolUrl') or ''
    if pokemon and PRIZE_PACK_SLUG.match(slug):
        report(PRIZE_PACK_SYMBOL.is_file(), 'symbol (bundled Prize Pack mark)', f'{PRIZE_PACK_SYMBOL.relative_to(ROOT)} ships with the web build; inspect visually')
    elif pokemon:
        symbol_ok, ok = attempt('symbol HTTP', lambda: bool(symbol) and request(symbol, False))
        if ok:
            report(symbol_ok, 'symbol HTTP', f'{symbol or "absent"}; inspect visually for text plates')
    else:
        probe = f'{CDN}{prefix_slug}/expansions/symbols/{slug}.png'
        absent = False
        try:
            probe_ok = request(probe, False)
        except urllib.error.HTTPError as error:
            probe_ok, absent = False, error.code == 404
            if not absent:
                report(False, 'symbol HTTP', f'{probe}: HTTP {error.code}')
        except (OSError, ValueError) as error:
            probe_ok = False
            report(False, 'symbol HTTP', f'{probe}: request failed: {error}')
        if probe_ok:
            report(True, 'symbol HTTP', f'{probe}; inspect visually')
        elif absent:
            skip('symbol', f'no satellite symbol pipeline; the API returns none and {probe} is 404, so the SPA paints the letter mark')
    if pokemon:
        featured = json.loads((ROOT / 'market/src/data/featured-set.json').read_text())
        report(featured.get('newCardsSet', '').casefold() == name.casefold(), 'featured set override', f'{featured.get("newCardsSet", "absent")}; release-date ordering requires manual review')
        rail, ok = attempt('new-cards rail', lambda: request(API + '/api/marketplace-home/new-cards'))
        if ok:
            rail_cards = rail.get('cards') or []
            report(bool(rail_cards) and all((c.get('set_name') or c.get('set') or '').casefold() == name.casefold() for c in rail_cards), 'new-cards rail', ', '.join(sorted({c.get('set_name') or c.get('set') or '?' for c in rail_cards})))
    else:
        skip('featured set override', 'featured-set.json and the New cards rail are Pokémon-only (the rail ignores ?game=)')
        skip('new-cards rail', 'Pokémon-only; satellite homes use marketplace-home-page newest rows')
    print('UNVERIFIED: samples do not prove all images, artwork matches, or release-date ordering; review them separately.')
    return int(bool(failures))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('set_name')
    parser.add_argument('--game', default='pokemon', help='game id or path slug (default pokemon)')
    args = parser.parse_args(argv)
    game = normalize_game(args.game)
    if game is None:
        print(f'ERROR: unknown game {args.game!r}; known: {", ".join(GAMES)}', file=sys.stderr)
        return 2
    try:
        return run(args.set_name, game)
    except (OSError, ValueError, KeyError) as error:
        print(f'ERROR: check could not complete: {error}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
