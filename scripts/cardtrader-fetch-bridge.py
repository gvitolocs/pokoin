#!/usr/bin/env python3
"""CardTrader GET bridge; credentials remain on Oracle, responses go to nezopt."""
import concurrent.futures, json, pathlib, sys, threading, time, urllib.request, urllib.parse
token = None
for filename in ("/home/ubuntu/cardtrader-oracle-api/.env.cardtrader-nezopt", "/home/ubuntu/cardtrader-oracle-api/.env"):
    p=pathlib.Path(filename)
    if p.exists():
        for line in p.read_text().splitlines():
            key, sep, value=line.partition("=")
            if sep and key.strip() == "CARDTRADER_AUTH_TOKEN":
                token=value.strip().strip("'\"")
if not token:
    raise SystemExit("CardTrader token unavailable")
lock=threading.Lock()
pace=threading.Lock()
next_request=0.0
def fetch(request):
    global next_request
    try:
        path=request["path"]
        if path not in ("/games","/categories","/expansions","/blueprints/export","/marketplace/products"):
            raise ValueError("Unsupported API path")
        url="https://api.cardtrader.com/api/v2"+path+"?"+urllib.parse.urlencode(request.get("params",{}))
        for attempt in range(6):
            try:
                with pace:
                    time.sleep(max(0,next_request-time.monotonic()))
                    next_request=time.monotonic()+(1.05 if path=="/marketplace/products" else 0.3)
                req=urllib.request.Request(url,headers={"Authorization":"Bearer "+token,"Accept":"application/json","User-Agent":"Pokoin-catalog-refresh/1"})
                with urllib.request.urlopen(req,timeout=90) as response:
                    data=json.load(response)
                if isinstance(data,dict) and "array" in data: data=data["array"]
                if path=="/marketplace/products":
                    if not isinstance(data,dict): raise ValueError("Expected listing book")
                elif not isinstance(data,list): raise ValueError("Expected catalogue array")
                result={"id":request["id"],"data":data}
                break
            except Exception as error:
                if attempt==5 or getattr(error,"code",None) in (401,403): raise
                time.sleep(60 if getattr(error,"code",None)==429 else 2**attempt)
    except Exception as error:
        result={"id":request["id"],"error":type(error).__name__+": "+str(error)}
    with lock:
        print(json.dumps(result,separators=(",",":")),flush=True)
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
    for line in sys.stdin:
        pool.submit(fetch,json.loads(line))
