#!/usr/bin/env python3
"""Match today's new Pokemon artwork buckets (CLIP, on the CPU by default).

POKOIN_ARTWORK_DEVICE=cpu (default) hides the GPU from torch; =gpu opts in. The
GPU run segfaulted in libamdhip64 every night from 2026-11-08, once the local
Qwen server held 21.5 GB of the card.


Also re-tries recent printings still alone on their singleton version whose
scan has landed since: a JPEG recovered after the import day (the card-pictures
stage runs after this one) used to leave the printing a singleton forever. CN
30th Celebration 028/30th-P Espeon ex (ct 414196) missed MEP 108 + JP 043 that
way. POKOIN_ARTWORK_LOOKBACK_DAYS (default 60, 0 = off) sets the window.
"""
import importlib.util,os,pathlib,shutil,sys,time

LEFTOVERS=pathlib.Path("/home/nez/data/pokoin-leftovers/objects")
SINGLETON_SQL=(
 "select string_agg(c.ct_id::text,',') from marketplace_search_candidates c"
 " join pokoin_version_sets v on v.version=c.version"
 " where c.item_kind='single' and c.product_type='card' and v.source='singleton' and v.member_count=1"
 " and c.imported_at >= now() - make_interval(days => {days})"
 " and exists (select 1 from marketplace_search_candidates o where o.name=c.name and o.card_id<>c.card_id"
 " and o.item_kind='single' and o.product_type='card');"
)

def id_list(raw):
 """The digits-and-commas line of psql output, as ints."""
 line=next((line.strip() for line in raw.strip().splitlines() if line.strip() and all(ch.isdigit() or ch=="," for ch in line.strip())),"")
 return [int(part) for part in line.split(",") if part]

def scanned_ct_ids(names):
 """Blueprint ids with a leftover JPEG (`{ct_id}_{slug}.jpg`; homepage webps do not count)."""
 found=set()
 for name in names:
  head,_,rest=name.partition("_")
  if rest and head.isdigit() and name.lower().endswith(".jpg"):
   found.add(int(head))
 return found

def late_scan_ids(ct_ids,objects):
 if not ct_ids:return []
 scanned=scanned_ct_ids(entry.name for entry in os.scandir(objects))
 return [ct_id for ct_id in ct_ids if ct_id in scanned]

def select_device(env=None):
 """Hide the GPU from torch unless POKOIN_ARTWORK_DEVICE=gpu. Must run before the CLIP module imports torch."""
 env=os.environ if env is None else env
 mode=env.get("POKOIN_ARTWORK_DEVICE","cpu").strip().lower() or "cpu"
 if mode=="gpu":
  print("artwork device: gpu (POKOIN_ARTWORK_DEVICE=gpu, GPU left visible)",flush=True)
 else:
  mode="cpu"
  env["HIP_VISIBLE_DEVICES"]="";env["CUDA_VISIBLE_DEVICES"]=""
  print("artwork device: cpu (default; the GPU segfaulted on a nearly full card since 2026-11-08, set POKOIN_ARTWORK_DEVICE=gpu to opt in)",flush=True)
 return mode

def main():
 select_device()
 ROOT=pathlib.Path(os.environ.get("POKOIN_CATALOG_RUN_ROOT","/home/nez/data/pokoin-catalog-refresh/"+time.strftime("%Y-%m-%d",time.gmtime())))
 source=pathlib.Path("/home/nez/Projects/Startup/Pokoin/pokemon-card-extension/scripts/cluster-name-version-sets.py")
 sys.path.insert(0,str(source.parent))
 spec=importlib.util.spec_from_file_location("catalog_clip",source);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
 outputs=ROOT/"clip";outputs.mkdir(exist_ok=True)
 for attribute,name in (("CACHE","artbox-clip.npz"),("PIXEL_CACHE","artbox-pixel.npz")):
  destination=outputs/name
  if not destination.exists():shutil.copyfile(getattr(m,attribute),destination)
  setattr(m,attribute,destination)
 m.CANDIDATES=outputs/"candidates.json";m.GROUPS=outputs/"groups.json"
 m.PI_OBJECTS=LEFTOVERS
 m.PI_ARTCUT=outputs/"artcut";m.PI_ARTCUT.mkdir(exist_ok=True)
 new=id_list(m.psql("select string_agg(b.id::text,',') from pokoin_pokemon_blueprints b join marketplace_search_candidates c on c.ct_id=b.id where b.imported_at >= '"+ROOT.name+"'::date and c.item_kind='single' and c.product_type='card' and b.cdn_image_url is not null;"))
 days=int(os.environ.get("POKOIN_ARTWORK_LOOKBACK_DAYS","60"))
 late=late_scan_ids(id_list(m.psql(SINGLETON_SQL.format(days=days))),LEFTOVERS) if days>0 else []
 ids=sorted(set(new)|set(late))
 print(f"artwork match: {len(new)} new, {len(late)} recent singletons with a scan",flush=True)
 if not ids:print("No new Pokemon singles with scans");raise SystemExit(0)
 sys.argv=[str(source),"--refresh-candidates","--ids",",".join(map(str,ids))]
 m.main()

if __name__=="__main__":
 main()
