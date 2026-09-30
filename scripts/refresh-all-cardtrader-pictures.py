#!/usr/bin/env python3
"""Backfill every live game's leftover JPEGs on nezopt using Oracle scan GET."""
import csv, importlib.util, io, json, os, pathlib, subprocess, sys, time, shlex, uuid
from concurrent.futures import ThreadPoolExecutor
ROOT=pathlib.Path(os.environ.get("POKOIN_CATALOG_RUN_ROOT","/home/nez/data/pokoin-catalog-refresh/"+time.strftime("%Y-%m-%d",time.gmtime())))
os.environ.update(POKOIN_SCAN_WORKERS="4",POKOIN_SCAN_CHUNK="250",POKOIN_SCAN_TAG="catalog-sat-fast-0930",POKOIN_SCAN_STATE=str(ROOT/"pictures-state.json"),POKOIN_SCAN_FAILS=str(ROOT/"pictures-fails.json"),POKOIN_SCAN_RAW=str(ROOT/"raw-scans"))
spec=importlib.util.spec_from_file_location("satellite",pathlib.Path(__file__).with_name("satellite-scan-ingest.py"))
m=importlib.util.module_from_spec(spec);sys.modules["satellite"]=m;spec.loader.exec_module(m)
# Each fetch owns its remote directory and returns explicit failure reasons.
FETCH_RESULTS={}
FETCH_BLOCKED=False
def oracle_fetch(jobs):
    global FETCH_RESULTS,FETCH_BLOCKED
    remote="/tmp/pokoin-catalog-scans-"+uuid.uuid4().hex
    source=pathlib.Path(__file__).with_name("cardtrader-scan-fetch.py").read_text()
    proc=subprocess.run(["ssh","-o","BatchMode=yes","-o","ConnectTimeout=20","pokoin-marketplace","python3 -u -c "+shlex.quote(source)],
        input=json.dumps({"out":remote,"jobs":jobs}),text=True,capture_output=True,timeout=900)
    if proc.returncode:raise RuntimeError("Oracle scan worker failed: "+proc.stderr[-500:])
    report=json.loads(proc.stdout);FETCH_RESULTS=report["results"];FETCH_BLOCKED=report["blocked"]
    RAW=ROOT/"raw-scans";RAW.mkdir(parents=True,exist_ok=True)
    subprocess.run(["rsync","-a",f"pokoin-marketplace:{remote}/",str(RAW)+"/"],check=True,capture_output=True)
    good={key:(RAW/key).read_bytes() for key,v in FETCH_RESULTS.items() if v["status"]=="ok"}
    # Clean only this invocation's owned scratch directory.
    subprocess.run(["ssh","pokoin-marketplace","rm -rf "+shlex.quote(remote)],check=True)
    return good
m.oracle_fetch=oracle_fetch
targets=[json.loads(p.read_text()) for p in ROOT.glob("*-target.json")]
targets.sort(key=lambda t:t["cardtraderGameId"]==5)
PG="pokoin-marketplace-postgres-15t"
def psql(db,sql):
    proc=subprocess.run(["docker","exec","-i",PG,"psql","-U","pokoin_marketplace","-d",db,"-At","-v","ON_ERROR_STOP=1"],input=sql,text=True,capture_output=True,timeout=180)
    if proc.returncode:raise RuntimeError(proc.stderr[-800:])
    return proc.stdout
def raw_table(t):return t["schema"]+"."+t["table"]
def db_for(t):return "pokoin_marketplace" if t["cardtraderGameId"]==5 else "pokoin_"+t["schema"].removeprefix("marketplace_")
def stamp(t,keys):
    entries=[]
    for key in keys:
        tail=key.removeprefix(t["cdnKeyPrefix"]);ct=tail.split("_",1)[0]
        if ct.isdigit() and key.startswith(t["cdnKeyPrefix"]):entries.append((int(ct),key))
    if not entries:return 0
    rows=",".join("(%d,'%s')"%(ct,key.replace("'","''")) for ct,key in entries)
    sql=f"""BEGIN; SET LOCAL lock_timeout='10s';
WITH keys(id,key) AS (VALUES {rows}) UPDATE {raw_table(t)} b
SET cdn_image_url='https://cdn.pokoin.com/'||keys.key,cdn_object_key=keys.key,
homepage_image_url='https://cdn.pokoin.com/'||regexp_replace(keys.key,'\\.jpg$','_homepage.webp'),
homepage_object_key=regexp_replace(keys.key,'\\.jpg$','_homepage.webp')
FROM keys WHERE b.id=keys.id AND nullif(b.cdn_image_url,'') IS NULL; COMMIT;"""
    psql(db_for(t),sql);return len(entries)
def overlay(t):
    tables=["marketplace_search_candidates"]
    if t["cardtraderGameId"]==5:tables+=["marketplace_cards","marketplace_card_versions"]
    for table in tables:
        psql(db_for(t),f"""SET lock_timeout='10s'; UPDATE public.{table} c SET
image_url=b.cdn_image_url,cdn_image_url=b.cdn_image_url,
preview_image_url=coalesce(b.preview_image_url,b.cdn_image_url)
FROM {raw_table(t)} b WHERE c.ct_id=b.id AND b.cdn_image_url IS NOT NULL
AND (c.cdn_image_url IS DISTINCT FROM b.cdn_image_url OR c.image_url IS DISTINCT FROM b.cdn_image_url);""")
    psql(db_for(t),f"""UPDATE public.marketplace_search_candidates c SET homepage_image_url=b.homepage_image_url FROM {raw_table(t)} b WHERE c.ct_id=b.id AND b.homepage_image_url IS NOT NULL AND c.homepage_image_url IS DISTINCT FROM b.homepage_image_url;""")
def refresh_image_sources(t,rows):
    updates=[]
    exports={}
    for row in rows:
        expansion=row.get("expansion_id")
        if expansion not in exports:
            file=ROOT/("_blueprints_export-"+str(expansion)+".json")
            exports[expansion]={str(b["id"]):b for b in json.loads(file.read_text())} if file.exists() else {}
        latest=exports[expansion].get(row["ct_id"],{}).get("image")
        if not latest:continue
        full=latest.get("url") or "";show=(latest.get("show") or {}).get("url") or ""
        image=(latest.get("preview") or {}).get("url") or full
        if not image:continue
        image=m.helper().abs_cardtrader(image)
        row.update(full_url=full,show_url=show,image_url=image)
        payload=json.dumps(latest).replace("'","''")
        updates.append(f"({int(row['ct_id'])},'{payload}'::jsonb,'{image.replace(chr(39),chr(39)*2)}')")
    for start in range(0,len(updates),250):
        values=",".join(updates[start:start+250])
        if not values:continue
        psql(db_for(t),f"""WITH fresh(id,image,url) AS (VALUES {values})
UPDATE {raw_table(t)} b SET blueprint=jsonb_set(b.blueprint,'{{image}}',fresh.image),
image_url=fresh.url,cardtrader_image_url=fresh.url
FROM fresh WHERE b.id=fresh.id AND nullif(b.cdn_image_url,'') IS NULL
AND (b.blueprint->'image' IS DISTINCT FROM fresh.image OR b.cardtrader_image_url IS DISTINCT FROM fresh.url);""")
    return rows
def run(t):
    db=db_for(t);prefix=t["cdnKeyPrefix"];failed={};saved=0
    m.log("PICTURES "+db)
    # A bounded pass avoids retrying inaccessible scans indefinitely.
    data=psql(db,f"""COPY (SELECT id::text ct_id,expansion_id,name,coalesce(cardtrader_image_url,image_url) image_url,blueprint->'image'->>'url' full_url,blueprint->'image'->'show'->>'url' show_url FROM {raw_table(t)} WHERE nullif(cdn_image_url,'') IS NULL ORDER BY id) TO STDOUT WITH CSV HEADER""")
    rows=refresh_image_sources(t,list(csv.DictReader(io.StringIO(data))))
    for start in range(0,len(rows),50):
        chunk=rows[start:start+50];jobs={};existing=[]
        for row in chunk:
            key=m.helper().leftover_key(row["ct_id"],row["name"],row["image_url"])
            if not key:continue
            key=prefix+key
            if (m.OBJECTS/key).exists() and (m.OBJECTS/key.replace(".jpg","_homepage.webp")).exists():existing.append(key);continue
            # Use exact source metadata, never guess a filename from the name.
            urls=[]
            for value in (row.get("full_url"),row.get("show_url"),row.get("image_url")):
                for url in m.helper().full_urls(value or ""):
                    if url not in urls:urls.append(url)
            if urls:jobs[key]=urls
            else:failed[key]={"status":"missing_source_url"}
        stamp(t,existing)
        if not jobs:continue
        bodies=m.oracle_fetch(jobs)
        # Pillow encoding stays on nezopt. Existing helpers preserve card treatment.
        with ThreadPoolExecutor(max_workers=4) as pool:
            statuses=list(pool.map(m._encode_one,list(bodies.items())))
        good=[key for (key,_),status in zip(bodies.items(),statuses) if status=="ok"]
        stamp(t,good);saved+=len(good)
        for key in jobs:
            if key not in good:failed[key]=FETCH_RESULTS.get(key,{"status":"encode_failed"})
        overlay(t)
        m.log(f"{db} processed={min(start+50,len(rows))}/{len(rows)} saved={saved} failed={len(failed)}")
        (ROOT/"pictures-live-status.json").write_text(json.dumps({"database":db,"processed":min(start+50,len(rows)),"total":len(rows),"saved":saved,"failed":failed,"blocked":FETCH_BLOCKED},indent=2))
        if FETCH_BLOCKED:break
    overlay(t)
    remaining=psql(db,f"select count(*) from {raw_table(t)} where nullif(cdn_image_url,'') is null").strip()
    return {"database":db,"attempted":len(rows),"saved":saved,"failed":failed,"missingCdn":int(remaining)}
def main():
    report=json.loads((ROOT/"pictures-status.json").read_text()) if (ROOT/"pictures-status.json").exists() else {"games":[],"errors":[]}
    done={g["database"] for g in report["games"]}
    for t in targets:
        if db_for(t) in done:continue
        try:report["games"].append(run(t))
        except Exception as error:report["errors"].append({"game":t["slug"],"error":str(error)});m.log(str(error))
        (ROOT/"pictures-status.json").write_text(json.dumps(report,indent=2))
        if FETCH_BLOCKED:
            report["blocked"]="CardTrader scan origin returned 401/403/429; retry on the next scheduled run"
            break
    report["finishedAt"]=time.strftime("%FT%TZ",time.gmtime());(ROOT/"pictures-status.json").write_text(json.dumps(report,indent=2))
    return bool(report["errors"] or any(g["failed"] for g in report["games"]))
if __name__=="__main__":raise SystemExit(main())
