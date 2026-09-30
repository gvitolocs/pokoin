#!/usr/bin/env python3
"""Bounded official CardTrader scan fetcher. Stdlib only on Oracle."""
import concurrent.futures,json,pathlib,sys,threading,time,urllib.request,urllib.error,urllib.parse,struct,os,fcntl,email.utils


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

def dimensions(data):
    if data.startswith(b"\x89PNG\r\n\x1a\n") and len(data)>=24:
        return struct.unpack(">II",data[16:24])
    if data.startswith(b"\xff\xd8"):
        at=2
        while at+4<=len(data):
            if data[at]!=255:at+=1;continue
            while at<len(data) and data[at]==255:at+=1
            if at>=len(data):break
            marker=data[at];at+=1
            if marker in (0xd8,0xd9,0x01) or 0xd0<=marker<=0xd7:continue
            if at+2>len(data):break
            size=int.from_bytes(data[at:at+2],"big")
            if size<2 or at+size>len(data):break
            if marker in (0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf) and size>=7:
                return (int.from_bytes(data[at+5:at+7],"big"),int.from_bytes(data[at+3:at+5],"big"))
            if marker==0xda:break
            at+=size
    if data[:4]==b"RIFF" and data[8:12]==b"WEBP":
        if data[12:16]==b"VP8X" and len(data)>=30:
            return (1+int.from_bytes(data[24:27],"little"),1+int.from_bytes(data[27:30],"little"))
        if data[12:16]==b"VP8 " and len(data)>=30 and data[23:26]==b"\x9d\x01\x2a":
            return (int.from_bytes(data[26:28],"little")&0x3fff,int.from_bytes(data[28:30],"little")&0x3fff)
        if data[12:16]==b"VP8L" and len(data)>=25 and data[20]==47:
            n=int.from_bytes(data[21:25],"little");return ((n&0x3fff)+1,((n>>14)&0x3fff)+1)
    return None

def main():
    request=json.load(sys.stdin)
    out=pathlib.Path(request["out"]);out.mkdir(parents=True,exist_ok=True)
    jobs=request["jobs"];halt=threading.Event();gate=CooldownGate()
    def fetch_image(url):
        attempt=0
        while True:
            if halt.is_set():return None,"blocked"
            gate.wait()
            if halt.is_set():return None,"blocked"
            try:
                req=urllib.request.Request(url,headers={"User-Agent":"Pokoin-catalog-refresh/1","Accept":"image/*"})
                with urllib.request.urlopen(req,timeout=15) as response:
                    content_type=response.headers.get("Content-Type","")
                    data=response.read(20*1024*1024) if "image/" in content_type else None
                return data,content_type
            except urllib.error.HTTPError as e:
                if e.code not in (403,429):raise
                gate.backoff(e)
            except (urllib.error.URLError,TimeoutError,OSError):
                if attempt==5:raise
                time.sleep(2**attempt);attempt+=1
    def one(item):
        key,urls=item;attempts=[]
        if pathlib.PurePosixPath(key).is_absolute() or ".." in pathlib.PurePosixPath(key).parts:
            return key,{"status":"invalid_key"}
        for url in urls:
            if halt.is_set():return key,{"status":"blocked","attempts":attempts}
            parsed=urllib.parse.urlparse(url)
            if parsed.scheme!="https" or parsed.hostname not in ("cardtrader.com","www.cardtrader.com"):
                continue
            try:
                data,content_type=fetch_image(url)
                if content_type=="blocked":return key,{"status":"blocked","attempts":attempts}
                if data is None:
                    attempts.append({"url":url,"status":"not_image"});continue
                size=dimensions(data)
                if not size or size==(186,260) or size[0]<400 or len(data)<=9000:
                    attempts.append({"url":url,"status":"undersized" if size else "unrecognized_image","dimensions":size,"bytes":len(data)});continue
                dest=out/key;dest.parent.mkdir(parents=True,exist_ok=True)
                part=dest.with_name(dest.name+".part");part.write_bytes(data);part.replace(dest)
                return key,{"status":"ok","url":url,"dimensions":size,"bytes":len(data)}
            except urllib.error.HTTPError as e:
                attempts.append({"url":url,"status":e.code})
                if e.code in (401,403,429):
                    halt.set();return key,{"status":"blocked","attempts":attempts}
            except (urllib.error.URLError,TimeoutError,OSError) as e:
                attempts.append({"url":url,"status":type(e).__name__})
        statuses=[a.get("status") for a in attempts]
        status="undersized" if "undersized" in statuses else "source_unavailable"
        return key,{"status":status,"attempts":attempts}
    result={}
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        for key,status in pool.map(one,jobs.items()):
            result[key]=status
            tmp=out/"fetch-status.json.part";tmp.write_text(json.dumps(result));tmp.replace(out/"fetch-status.json")
    print(json.dumps({"results":result,"blocked":halt.is_set()}),flush=True)
if __name__=="__main__":main()
