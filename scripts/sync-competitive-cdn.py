#!/usr/bin/env python3
"""Download competitive sprites, scans, format badges, and country flags."""
import json
import os
import sys
import urllib.request

UA = os.environ.get('UA', 'Mozilla/5.0 (compatible; PokoinCDN/1.0; +https://pokoin.com)')


def fetch(url, dest):
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    if os.path.isfile(dest) and os.path.getsize(dest) > 32:
        return 'skip'
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            body = response.read()
    except Exception as err:
        print(f'FAIL {url} {err}')
        return 'fail'
    if len(body) < 32:
        print(f'FAIL {url} tiny {len(body)}')
        return 'fail'
    with open(dest, 'wb') as handle:
        handle.write(body)
    print(f'GET  {len(body):7d}  {os.path.relpath(dest, staging)}')
    return 'ok'


dump, staging = sys.argv[1], sys.argv[2]
data = json.loads(open(dump, encoding='utf-8').read())

sprites = sorted({row.get('sprite') for row in data.get('decks') or [] if row.get('sprite')})
formats = sorted({
    row.get('format')
    for row in (data.get('tournaments') or []) + (data.get('cityLeagues') or [])
    if row.get('format')
})
flags = set()
for row in (data.get('tournaments') or []) + (data.get('cityLeagues') or []) + (data.get('players') or []):
    for key in ('country', 'winnerFlag', 'flag'):
        if row.get(key):
            flags.add(str(row[key]).lower())
for rows in (data.get('standings') or {}).values():
    for row in rows:
        if row.get('flag'):
            flags.add(str(row['flag']).lower())
scans = set()
for row in (data.get('decks') or []) + (data.get('cards') or []):
    code = str(row.get('set') or '').upper()
    num = str(row.get('num') or '').lstrip('0') or '0'
    if code:
        scans.add((code, num.zfill(3)))

counts = {'ok': 0, 'skip': 0, 'fail': 0}


def tally(status):
    counts[status] = counts.get(status, 0) + 1


for name in sprites:
    tally(fetch(
        f'https://r2.limitlesstcg.net/pokemon/gen9/{name}.png',
        os.path.join(staging, 'sprites', f'{name}.png'),
    ))
for fmt in formats:
    tally(fetch(
        f'https://limitless3.nyc3.cdn.digitaloceanspaces.com/formats/{fmt}.png',
        os.path.join(staging, 'formats', f'{fmt}.png'),
    ))
for code, num in sorted(scans):
    tally(fetch(
        f'https://limitlesstcg.nyc3.cdn.digitaloceanspaces.com/tpci/{code}/{code}_{num}_R_EN.png',
        os.path.join(staging, 'scans', f'{code}_{num}_R_EN.png'),
    ))
for cc in sorted(flags):
    tally(fetch(
        f'https://raw.githubusercontent.com/HatScripts/circle-flags/gh-pages/flags/{cc}.svg',
        os.path.join(staging, 'flags', f'{cc}.svg'),
    ))

print('summary', counts)
if counts['fail']:
    sys.exit(1)
