#!/usr/bin/env python3
"""Send only this refresh's newly encoded JPEG/webp pairs to the Pi serving copy."""
import datetime,json,os,pathlib,subprocess,time
root=pathlib.Path(os.environ.get("POKOIN_CATALOG_RUN_ROOT","/home/nez/data/pokoin-catalog-refresh/"+time.strftime("%Y-%m-%d",time.gmtime())))
objects=pathlib.Path("/home/nez/data/pokoin-leftovers/objects")
cutoff=datetime.datetime.fromisoformat(root.name).replace(tzinfo=datetime.timezone.utc).timestamp()
statepath=root/"picture-sync-state.json"
state=json.loads(statepath.read_text()) if statepath.exists() else {}
files=[]
for directory,_,names in os.walk(objects):
    for name in names:
        if not name.endswith("_homepage.webp"):continue
        home=pathlib.Path(directory)/name
        if home.stat().st_mtime<cutoff:continue
        jpg=home.with_name(name.replace("_homepage.webp",".jpg"))
        if not jpg.exists():continue
        for p in (jpg,home):
            key=p.relative_to(objects).as_posix();version=[p.stat().st_size,p.stat().st_mtime_ns]
            if state.get(key)!=version:files.append((key,version))
for start in range(0,len(files),500):
    batch=files[start:start+500]
    manifest=root/"picture-sync-files.txt";manifest.write_text("\n".join(key for key,_ in batch)+"\n")
    subprocess.run(["rsync","-a","--timeout=120","--files-from="+str(manifest),str(objects)+"/","pi-home:/srv/pokoin/card-images/objects/"],check=True)
    state.update(dict(batch));statepath.write_text(json.dumps(state))
print("Pi serving copy updated:",len(files),"files",flush=True)
