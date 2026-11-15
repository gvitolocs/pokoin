#!/usr/bin/env python3
"""Read-only public smoke check for a newly imported Pokémon expansion."""
import argparse
import json
import re
import sys
import unicodedata
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
API = 'https://api.pokoin.com'


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


def suggest_ids(body):
    return {str(p.get('card_id') or p.get('id')) for g in body.get('groups', []) for p in g.get('printings', [])}


def run(name):
    slug = slugify(name)
    failures = 0

    def report(ok, label, detail):
        nonlocal failures
        print(f'{"OK" if ok else "MISSING"}: {label}: {detail}')
        failures += not ok

    page = request(API + '/api/marketplace-expansion-page?' + urllib.parse.urlencode({'slug': slug, 'limit': 400}))
    expansion, cards = page.get('expansion') or {}, page.get('cards') or []
    report(expansion.get('name', '').casefold() == name.casefold() and bool(cards), 'catalog', f'{expansion.get("cardCount", 0)} cards reported')
    report(bool(cards), 'singles', f'{len(cards)} sampled')
    if not cards:
        return 1
    card = cards[0]
    card_id = str(card.get('card_id') or card.get('id') or '')
    image = card.get('imageUrl') or ''
    image_url = urllib.parse.urljoin('https://cdn.pokoin.com/', image.replace('/card-images/', '', 1))
    try:
        image_ok = bool(image) and request(image_url, False)
    except Exception:
        image_ok = False
    report(image_ok, 'image (one sample)', image_url)
    version = request(API + '/api/marketplace-version-set?' + urllib.parse.urlencode({'cardId': card_id}))
    report(bool(version.get('version')), 'version set (one sample)', f'{card_id}: {version.get("version") or "absent"}; singleton matches require review')
    by_name = request(API + '/api/marketplace-suggest?' + urllib.parse.urlencode({'q': card.get('name', ''), 'limit': 24}))
    report(card_id in suggest_ids(by_name), 'search index (one sample)', f'{card_id} by card name')
    by_set = request(API + '/api/marketplace-suggest?' + urllib.parse.urlencode({'q': name, 'limit': 24}))
    sample_ids = {str(c.get('card_id') or c.get('id')) for c in cards}
    report(bool(sample_ids & suggest_ids(by_set)), 'set-name suggest', 'sampled singles returned for set name')
    set_file = (ROOT / 'market/src/data/suggest-sets.js').read_text()
    report(f'"slug":"{slug}"' in set_file, 'local suggest set catalog', slug)
    symbol = expansion.get('symbolImageUrl') or expansion.get('defaultSymbolUrl') or ''
    try:
        symbol_ok = bool(symbol) and request(symbol, False)
    except Exception:
        symbol_ok = False
    report(symbol_ok, 'symbol HTTP', f'{symbol or "absent"}; inspect visually for text plates')
    featured = json.loads((ROOT / 'market/src/data/featured-set.json').read_text())
    report(featured.get('newCardsSet', '').casefold() == name.casefold(), 'featured set override', f'{featured.get("newCardsSet", "absent")}; release-date ordering requires manual review')
    rail = request(API + '/api/marketplace-home/new-cards')
    rail_cards = rail.get('cards') or []
    report(bool(rail_cards) and all((c.get('set_name') or c.get('set') or '').casefold() == name.casefold() for c in rail_cards), 'new-cards rail', ', '.join(sorted({c.get('set_name') or c.get('set') or '?' for c in rail_cards})))
    print('UNVERIFIED: samples do not prove all images, artwork matches, or release-date ordering; review them separately.')
    return int(bool(failures))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('set_name')
    args = parser.parse_args()
    try:
        return run(args.set_name)
    except (OSError, ValueError, KeyError) as error:
        print(f'ERROR: check could not complete: {error}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
