"""HTTP smoke test of an isolated real ROCm worker on a free port."""
import json
import os
import re
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path

worker=Path(__file__).resolve().parents[1]/'worker'
runtime=Path('/home/nez/Projects/BattleScan')
env=os.environ.copy()
env.update(CARDSCAN_ROOT=str(runtime), CARDSCAN_MODELS=str(runtime/'runtime/fast-models-cnn'),
           CARDSCAN_CATALOGS=str(runtime/'runtime/catalogs-cnn-v22'), CARDSCAN_THREADS='4',
           CARDSCAN_ORT_PATH=str(runtime/'runtime/ort-rocm'),
           HIP_VISIBLE_DEVICES='0', HSA_OVERRIDE_GFX_VERSION='11.0.0',
           ROCM_PATH='/home/nez/.local/rocm', HIP_PATH='/home/nez/.local/rocm',
           LD_LIBRARY_PATH='/home/nez/.local/lib/rocm-sonames:/home/nez/Projects/ai-toolkit/venv/lib/python3.12/site-packages/torch/lib')
assert env.get('CARDSCAN_EXPANSION_SYMBOLS'), 'Supply the release artifact directory'
with tempfile.TemporaryFile() as log:
    process=subprocess.Popen([str(runtime/'.venv/bin/uvicorn'),'app:app','--app-dir',str(worker),'--host','127.0.0.1','--port','0'],env=env,stdout=log,stderr=log)
    try:
        deadline=time.monotonic()+90; base=None
        while time.monotonic()<deadline:
            log.seek(0); content=log.read().decode(errors='replace')
            match=re.search(r'Uvicorn running on (http://127.0.0.1:\d+)',content)
            if match: base=match.group(1);break
            assert process.poll() is None,content[-3000:]
            time.sleep(.5)
        assert base,content[-3000:]
        health=json.load(urllib.request.urlopen(base+'/health'))
        assert health['device']=='rocm',health
        assert health['expansion_symbols']['enabled'],health
        assert 'ROCMExecutionProvider' in health['expansion_symbols']['providers'],health
        root=Path('/home/nez/data/pokoin-leftovers/objects')
        for file,expected in [('298440_crispin.jpg','scr'),('316730_crispin.jpg','pre'),('318027_crispin.jpg','pre')]:
            boundary='pokoin-smoke-boundary'
            body=(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="card.jpg"\r\nContent-Type: image/jpeg\r\n\r\n'.encode()+(root/file).read_bytes()+f'\r\n--{boundary}--\r\n'.encode())
            req=urllib.request.Request(base+'/identify?catalog=pokemon_generic&top_k=8',data=body,headers={'Content-Type':'multipart/form-data; boundary='+boundary})
            result=json.load(urllib.request.urlopen(req,timeout=30));top=result['top1'];mark=top.get('_expansion_symbol')
            assert mark and mark['code']==expected,(file,top)
            # The phone capture gate keys cards by artwork: hits must carry the group.
            assert top.get('artwork'),(file,top)
            print(json.dumps({'fixture':file,'public_id':top['public_id'],'symbol':mark,'artwork':top.get('artwork'),'identify_ms':result['identify_ms']}),flush=True)
        assert process.poll() is None,'Worker exited during inference'
        print(json.dumps({'passed':True,'providers':health['expansion_symbols']['providers']}),flush=True)
    finally:
        process.terminate()
        try: status=process.wait(timeout=15)
        except subprocess.TimeoutExpired:process.kill();status=process.wait()
        # The unchanged deployed ROCm worker also aborts at interpreter teardown.
        # Keep that known shutdown result visible; inference crashes never pass.
        print(json.dumps({'shutdown_exit':status,'known_rocm_teardown_abort':status==-6}),flush=True)
