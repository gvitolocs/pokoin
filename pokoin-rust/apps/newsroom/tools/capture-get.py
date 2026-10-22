#!/usr/bin/env python3
"""Public read-only HTTP golden capture. Never reads tokens or issues writes."""
import datetime
import json
import pathlib
import sys
import urllib.error
import urllib.request

base, output = sys.argv[1:]
rows = []
for query in ['', '?slug=missing-rust-parity', '?story=missing-rust-parity', '?export=invalid', '?export=all', '?export=published']:
    request = urllib.request.Request(base + '/api/poko/news' + query, method='GET')
    try:
        response = urllib.request.urlopen(request, timeout=15)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        rows.append({'query': query.removeprefix('?'), 'status': response.status,
                     'headers': {k: response.headers.get(k) for k in ['content-type', 'cache-control', 'access-control-allow-origin']},
                     'body': json.load(response)})
pathlib.Path(output).write_text(json.dumps({'base': base, 'capturedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'method': 'GET', 'rows': rows}, indent=2) + '\n')
print(f'captured {len(rows)} public GET responses')
