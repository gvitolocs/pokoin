import json,sys,collections
def tables(v,path='$'):
    if isinstance(v,list):
        if v and all(isinstance(x,dict) for x in v):
            yield path,v
        for i,x in enumerate(v[:3] if v and all(isinstance(x,dict) for x in v) else v):
            yield from tables(x,f'{path}[{i}]')
    elif isinstance(v,dict):
        for k,x in v.items(): yield from tables(x,f'{path}.{k}')
f=sys.argv[1]; d=json.load(open(f))
for path,rows in tables(d):
    if len(rows)<5: continue
    keys=[]; 
    for r in rows:
        for k in r:
            if k not in keys: keys.append(k)
    shapes=collections.Counter(tuple(r.keys()) for r in rows)
    print(f'== {path} rows={len(rows)} cols={len(keys)} shapes={len(shapes)}')
    cols={k:[json.dumps(r.get(k,'<absent>'),ensure_ascii=False) for r in rows] for k in keys}
    for k in keys:
        vals=cols[k]; dist=len(set(vals))
        same=[k2 for k2 in keys[:keys.index(k)] if cols[k2]==vals]
        print(f'  {k:34s} distinct={dist:4d} {"SAME="+same[0] if same else ""} ex={vals[0][:70]}')
