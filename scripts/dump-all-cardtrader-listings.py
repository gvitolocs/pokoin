#!/usr/bin/env python3
"""Daily raw listing books for all live CardTrader games; no inferred sales."""
import gzip,json,os,pathlib,shlex,subprocess,time
ROOT=pathlib.Path(os.environ.get("POKOIN_CATALOG_RUN_ROOT","/home/nez/data/pokoin-catalog-refresh/"+time.strftime("%Y-%m-%d",time.gmtime())))
OUT=ROOT/"listing-books";OUT.mkdir(parents=True,exist_ok=True)
source=pathlib.Path(__file__).with_name("cardtrader-fetch-bridge.py").read_text()
process=subprocess.Popen(["ssh","-o","BatchMode=yes","-o","ConnectTimeout=20","pokoin-marketplace","python3 -u -c "+shlex.quote(source)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
games={json.loads(p.read_text())["cardtraderGameId"] for p in ROOT.glob("*-target.json")}
expansions=json.loads((ROOT/"_expansions-all.json").read_text())
wanted=[e for e in expansions if int(e.get("game_id",0)) in games]
# New printings in any expansion get captured before the historical backlog.
priority=set()
for target_path in ROOT.glob("*-target.json"):
    t=json.loads(target_path.read_text())
    db="pokoin_marketplace" if t["cardtraderGameId"]==5 else "pokoin_"+t["schema"].removeprefix("marketplace_")
    sql=f"SELECT DISTINCT expansion_id FROM {t['schema']}.{t['table']} WHERE imported_at >= '{ROOT.name}'::date;"
    probe=subprocess.run(["docker","exec","pokoin-marketplace-postgres-15t","psql","-U","pokoin_marketplace","-d",db,"-At","-v","ON_ERROR_STOP=1","-c",sql],capture_output=True,text=True,timeout=30)
    if probe.returncode:raise RuntimeError("Cannot determine new-printing listing scope: "+probe.stderr[-500:])
    priority.update(int(v) for v in probe.stdout.splitlines() if v.isdigit())
wanted.sort(key=lambda e:(int(e["id"]) not in priority,int(e["game_id"])!=5,int(e["game_id"]),-int(e["id"])))
if os.environ.get("POKOIN_DUMP_LIMIT"): wanted=wanted[:int(os.environ["POKOIN_DUMP_LIMIT"])]
priority.intersection_update(int(e["id"]) for e in wanted)
report={"startedAt":time.strftime("%FT%TZ",time.gmtime()),"totalExpansions":len(wanted),"completed":0,"blueprintsWithListings":0,"listings":0,"errors":[],"games":sorted(games)}
cached_books=set()
report["newPrintingExpansions"]=len(priority)
report["newPrintingExpansionsCompleted"]=0
# Account for every retained book before resuming, regardless of queue order.
for e in wanted:
    dest=OUT/(str(e["game_id"])+"-"+str(e["id"])+".json.gz")
    if not dest.exists():continue
    with gzip.open(dest,"rt") as f:cached=json.load(f)
    report["blueprintsWithListings"]+=len(cached)
    report["listings"]+=sum(len(v) for v in cached.values() if isinstance(v,list))
    report["completed"]+=1;cached_books.add(e["id"])
    if int(e["id"]) in priority:report["newPrintingExpansionsCompleted"]+=1
(ROOT/"listing-dump-status.json").write_text(json.dumps(report,indent=2))
try:
    for index,e in enumerate(wanted,1):
        dest=OUT/(str(e["game_id"])+"-"+str(e["id"])+".json.gz")
        if e["id"] in cached_books:continue
        process.stdin.write(json.dumps({"id":index,"path":"/marketplace/products","params":{"expansion_id":e["id"]}})+"\n");process.stdin.flush()
        message=json.loads(process.stdout.readline())
        if message.get("error"):
            report["errors"].append({"expansionId":e["id"],"gameId":e["game_id"],"error":message["error"]})
        else:
            data=message["data"]
            count=sum(len(rows) for rows in data.values() if isinstance(rows,list))
            with gzip.open(str(dest)+".part","wt",compresslevel=3) as out:json.dump(data,out,separators=(",",":"))
            pathlib.Path(str(dest)+".part").replace(dest)
            report["completed"]+=1;report["blueprintsWithListings"]+=len(data);report["listings"]+=count
            if int(e["id"]) in priority:report["newPrintingExpansionsCompleted"]+=1
        (ROOT/"listing-dump-status.json").write_text(json.dumps(report,indent=2))
        if message.get("error") and ("403" in message["error"] or "401" in message["error"]):
            report["blocked"]="CardTrader listing endpoint refused by Cloudflare; retaining collected books and retrying at the next scheduled run"
            break
        if index%25==0:print(time.strftime("%FT%TZ",time.gmtime()),"daily listing books",report["completed"],"/",len(wanted),"listings",report["listings"],flush=True)
finally:
    process.stdin.close();process.wait(timeout=180)
report["finishedAt"]=time.strftime("%FT%TZ",time.gmtime());(ROOT/"listing-dump-status.json").write_text(json.dumps(report,indent=2))
raise SystemExit(bool(report["errors"]))
