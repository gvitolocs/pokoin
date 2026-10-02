#!/usr/bin/env python3
"""Build symbol parent-set/artwork lookup from a read-only catalog JSONL export."""
import argparse
import hashlib
import json
from pathlib import Path

p = argparse.ArgumentParser(); p.add_argument('--data', required=True); p.add_argument('--manifest', required=True)
args = p.parse_args(); root = Path(args.data)
meta = json.loads((root/'classes.json').read_text())
sets = meta['sets']; official = {v['official_id']:k for k,v in sets.items()}
names = sorted(((v['name'].casefold(),k) for k,v in sets.items()),reverse=True,key=lambda r:len(r[0]))
mapping = {}
for line in (root/'artwork-catalog.jsonl').read_text().splitlines():
    r = json.loads(line)
    code = r['code'] if r['code'] in sets else official.get(r['official_id'])
    if code is None and r['code'].startswith(('p-', 'm-')) and r['code'][2:] in sets:
        code = r['code'][2:]
    if code is None:
        for name,k in names:
            if r['set'].casefold() == name or r['set'].casefold().startswith(name+' ('):
                code = k; break
    mapping[r['id']] = {'group':r['group'], 'code':code, 'set':sets[code]['name'] if code else r['set']}
(root/'artwork-printings.json').write_text(json.dumps(mapping, separators=(',',':')))
manifest = {name:hashlib.sha256((root/name).read_bytes()).hexdigest() for name in ('classes.json','artwork-printings.json','expansion-symbols.onnx')}
Path(args.manifest).write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps({'cards':len(mapping),'artwork_groups':len({v['group'] for v in mapping.values()}),'manifest':manifest}))
