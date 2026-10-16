#!/usr/bin/env python3
"""CardTrader GET bridge; credentials remain on Oracle, responses go to nezopt."""
import concurrent.futures, json, pathlib, sys, threading, time, urllib.request, urllib.parse, os, fcntl, email.utils
def load_token():
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
    return token

token=None

class CooldownGate:
    """Share a five-minute pause across this pipeline's Oracle processes."""
    def __init__(self):
        self.path=pathlib.Path(os.environ.get("POKOIN_CT_COOLDOWN_FILE","/tmp/pokoin-catalog-cardtrader-cooldown.json"))
        self.lock=threading.Lock()
        self.next_request=0.0
    def deadline(self):
        try:
            with self.path.open("a+") as f:
                fcntl.flock(f,fcntl.LOCK_EX);f.seek(0)
                text=f.read();value=json.loads(text) if text else {}
                return float(value.get("until",0))
        except (ValueError,OSError):
            return 0
    def wait(self,interval=0.3):
        while True:
            with self.lock:
                delay=max(self.deadline()-time.time(),self.next_request-time.monotonic())
                if delay<=0:
                    self.next_request=time.monotonic()+interval
                    return
            time.sleep(delay)
    def backoff(self,error):
        delay=300.0
        value=(getattr(error,"headers",None) or {}).get("Retry-After")
        if value:
            try:delay=max(delay,float(value))
            except ValueError:
                try:delay=max(delay,email.utils.parsedate_to_datetime(value).timestamp()-time.time())
                except (ValueError,TypeError,OverflowError):pass
        with self.path.open("a+") as f:
            fcntl.flock(f,fcntl.LOCK_EX);f.seek(0)
            text=f.read()
            try:previous=float(json.loads(text).get("until",0)) if text else 0
            except (ValueError,TypeError):previous=0
            until=max(previous,time.time()+delay)
            f.seek(0);f.truncate()
            json.dump({"until":until,"httpStatus":getattr(error,"code",None)},f);f.flush()
        print("CardTrader HTTP "+str(getattr(error,"code",None))+": pausing for "+str(round(until-time.time()))+"s before retry",file=sys.stderr,flush=True)

lock=threading.Lock()
gate=CooldownGate()
def listing_book(body):
    """Keep a listing book as raw bytes: parsing it costs ~10x its size in RAM on this VM.
    JSON strings cannot contain raw CR/LF, so removing them only drops whitespace and keeps one book per line."""
    if b"\n" in body or b"\r" in body: body=body.replace(b"\r",b"").replace(b"\n",b"")
    if body[:64].lstrip()[:1]!=b"{": raise ValueError("Expected listing book")
    return body
def emit(request_id,data=None,error=None,raw=None):
    """Write one reply line; a raw listing book is spliced in as the "data" value without parsing."""
    with lock:
        if raw is None:
            result={"id":request_id,"error":error} if error is not None else {"id":request_id,"data":data}
            print(json.dumps(result,separators=(",",":")),flush=True)
            return
        head='{"id":'+json.dumps(request_id)+',"data":'
        out=getattr(sys.stdout,"buffer",None)
        if out is None:
            sys.stdout.write(head+raw.decode("utf-8")+"}\n");sys.stdout.flush()
        else:
            sys.stdout.flush();out.write(head.encode());out.write(raw);out.write(b"}\n");out.flush()
def fetch(request):
    data=None;raw=None
    try:
        path=request["path"]
        if path not in ("/games","/categories","/expansions","/blueprints/export","/marketplace/products"):
            raise ValueError("Unsupported API path")
        url="https://api.cardtrader.com/api/v2"+path+"?"+urllib.parse.urlencode(request.get("params",{}))
        attempt=0
        while True:
            try:
                gate.wait(1.05 if path=="/marketplace/products" else 0.3)
                req=urllib.request.Request(url,headers={"Authorization":"Bearer "+token,"Accept":"application/json","User-Agent":"Pokoin-catalog-refresh/1"})
                with urllib.request.urlopen(req,timeout=90) as response:
                    if path=="/marketplace/products":
                        raw=listing_book(response.read())
                        break
                    data=json.load(response)
                if isinstance(data,dict) and "array" in data: data=data["array"]
                if not isinstance(data,list): raise ValueError("Expected catalogue array")
                break
            except Exception as error:
                if getattr(error,"code",None)==401:raise
                if getattr(error,"code",None) in (403,429):
                    gate.backoff(error)
                    continue
                if attempt==5:raise
                time.sleep(2**attempt);attempt+=1
    except Exception as error:
        emit(request["id"],error=type(error).__name__+": "+str(error))
        return
    emit(request["id"],data=data,raw=raw)
def main():
    global token
    token=load_token()
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        for line in sys.stdin:
            pool.submit(fetch,json.loads(line))
if __name__=="__main__":main()
