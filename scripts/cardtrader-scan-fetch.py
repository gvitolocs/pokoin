#!/usr/bin/env python3
"""Bounded official CardTrader scan fetcher. Stdlib only on Oracle."""
import concurrent.futures,json,pathlib,sys,threading,time,urllib.request,urllib.error,urllib.parse,struct

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
    jobs=request["jobs"];halt=threading.Event();pace=threading.Lock();next_request=0.0
    def one(item):
        nonlocal next_request
        key,urls=item;attempts=[]
        if pathlib.PurePosixPath(key).is_absolute() or ".." in pathlib.PurePosixPath(key).parts:
            return key,{"status":"invalid_key"}
        for url in urls:
            if halt.is_set():return key,{"status":"blocked","attempts":attempts}
            parsed=urllib.parse.urlparse(url)
            if parsed.scheme!="https" or parsed.hostname not in ("cardtrader.com","www.cardtrader.com"):
                continue
            try:
                with pace:
                    time.sleep(max(0,next_request-time.monotonic()));next_request=time.monotonic()+0.3
                if halt.is_set():return key,{"status":"blocked","attempts":attempts}
                req=urllib.request.Request(url,headers={"User-Agent":"Pokoin-catalog-refresh/1","Accept":"image/*"})
                with urllib.request.urlopen(req,timeout=15) as response:
                    if "image/" not in response.headers.get("Content-Type",""):
                        attempts.append({"url":url,"status":"not_image"});continue
                    data=response.read(20*1024*1024)
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
