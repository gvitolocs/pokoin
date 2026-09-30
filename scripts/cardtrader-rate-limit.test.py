#!/usr/bin/env python3
"""Rate-limit retries use one shared cooldown without network or real sleeps."""
import contextlib,importlib.util,io,json,os,pathlib,tempfile,unittest,urllib.error
from unittest.mock import patch,MagicMock
ROOT=pathlib.Path(__file__).parent
def load(name):
    spec=importlib.util.spec_from_file_location(name,ROOT/(name+".py"))
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
bridge=load("cardtrader-fetch-bridge");scan=load("cardtrader-scan-fetch")
class Response:
    def __enter__(self):return self
    def __exit__(self,*args):pass
    def read(self,*args):return b"{}"
class RateLimitTest(unittest.TestCase):
    def check_delay(self,headers,expected):
        for m in (bridge,scan):
            with self.subTest(module=m.__name__),tempfile.TemporaryDirectory() as folder:
                clock=[1000.0];sleeps=[]
                def sleep(seconds):sleeps.append(seconds);clock[0]+=seconds
                with patch.dict(os.environ,{"POKOIN_CT_COOLDOWN_FILE":folder+"/cooldown.json"}),patch.object(m.time,"time",side_effect=lambda:clock[0]),patch.object(m.time,"monotonic",side_effect=lambda:clock[0]),patch.object(m.time,"sleep",side_effect=sleep),contextlib.redirect_stderr(io.StringIO()):
                    limiter=m.CooldownGate();other_process=m.CooldownGate()
                    limiter.backoff(urllib.error.HTTPError("https://api.cardtrader.com",429,"Limited",headers,None))
                    other_process.wait()
                self.assertEqual(sleeps,[expected])
                self.assertEqual(clock[0],1000+expected)
    def test_waits_five_minutes_and_all_workers_share_pause(self):
        self.check_delay({},300.0)
    def test_respects_longer_retry_after(self):
        self.check_delay({"Retry-After":"600"},600.0)
    def test_retries_same_api_request_after_rate_limit(self):
        gate=MagicMock();output=io.StringIO()
        error=urllib.error.HTTPError("https://api.cardtrader.com",429,"Limited",{},None)
        with patch.object(bridge,"token","test"),patch.object(bridge,"gate",gate),patch.object(bridge.urllib.request,"urlopen",side_effect=[error,Response()]) as request,contextlib.redirect_stdout(output):
            bridge.fetch({"id":7,"path":"/marketplace/products","params":{"expansion_id":4690}})
        self.assertEqual(json.loads(output.getvalue()),{"id":7,"data":{}})
        self.assertEqual(request.call_args_list[0].args[0].full_url,request.call_args_list[1].args[0].full_url)
        self.assertEqual(gate.wait.call_count,2);gate.backoff.assert_called_once_with(error)
    def test_authentication_failure_does_not_retry(self):
        gate=MagicMock();output=io.StringIO()
        error=urllib.error.HTTPError("https://api.cardtrader.com",401,"Unauthorized",{},None)
        with patch.object(bridge,"token","test"),patch.object(bridge,"gate",gate),patch.object(bridge.urllib.request,"urlopen",side_effect=error) as request,contextlib.redirect_stdout(output):
            bridge.fetch({"id":7,"path":"/marketplace/products","params":{"expansion_id":4690}})
        self.assertIn("401",json.loads(output.getvalue())["error"])
        self.assertEqual(request.call_count,1);gate.backoff.assert_not_called()
if __name__=="__main__":unittest.main()

