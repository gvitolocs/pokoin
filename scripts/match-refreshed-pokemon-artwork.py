#!/usr/bin/env python3
"""Match only today's new Pokemon artwork buckets on the nezopt GPU."""
import importlib.util,os,pathlib,shutil,sys,time
ROOT=pathlib.Path(os.environ.get("POKOIN_CATALOG_RUN_ROOT","/home/nez/data/pokoin-catalog-refresh/"+time.strftime("%Y-%m-%d",time.gmtime())))
source=pathlib.Path("/home/nez/Projects/pokemon-card-extension/scripts/cluster-name-version-sets.py")
sys.path.insert(0,str(source.parent))
spec=importlib.util.spec_from_file_location("catalog_clip",source);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
outputs=ROOT/"clip";outputs.mkdir(exist_ok=True)
for attribute,name in (("CACHE","artbox-clip.npz"),("PIXEL_CACHE","artbox-pixel.npz")):
 destination=outputs/name
 if not destination.exists():shutil.copyfile(getattr(m,attribute),destination)
 setattr(m,attribute,destination)
m.CANDIDATES=outputs/"candidates.json";m.GROUPS=outputs/"groups.json"
m.PI_OBJECTS=pathlib.Path("/home/nez/data/pokoin-leftovers/objects")
m.PI_ARTCUT=outputs/"artcut";m.PI_ARTCUT.mkdir(exist_ok=True)
ids=m.psql("select string_agg(b.id::text,',') from pokoin_pokemon_blueprints b join marketplace_search_candidates c on c.ct_id=b.id where b.imported_at >= '"+ROOT.name+"'::date and c.item_kind='single' and c.product_type='card' and b.cdn_image_url is not null;").strip().splitlines()
value=next((line.strip() for line in ids if line.strip() and all(ch.isdigit() or ch=="," for ch in line.strip())),"")
if not value:print("No new Pokemon singles with scans");raise SystemExit(0)
sys.argv=[str(source),"--refresh-candidates","--ids",value]
m.main()
