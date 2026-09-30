#!/usr/bin/env python3
"""Validate real image formats and scan fallback without network access."""
import contextlib,importlib.util,io,json,pathlib,tempfile,unittest,urllib.error
from unittest.mock import patch
from PIL import Image
spec=importlib.util.spec_from_file_location("scan_fetch",pathlib.Path(__file__).with_name("cardtrader-scan-fetch.py"))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
def image(size,fmt="JPEG",lossless=False):
    buf=io.BytesIO();Image.effect_noise(size,80).convert("RGB").save(buf,fmt,lossless=lossless,quality=90);return buf.getvalue()
class Response:
    def __init__(self,data):self.data=data;self.headers={"Content-Type":"image/jpeg"}
    def __enter__(self):return self
    def __exit__(self,*args):pass
    def read(self,*args):return self.data
class ScanFetchTest(unittest.TestCase):
    def test_png_jpeg_and_webp_real_dimensions(self):
        for size in [(186,260),(255,361),(400,559),(863,1207)]:
            for fmt,lossless in [("JPEG",False),("PNG",False),("WEBP",False),("WEBP",True)]:
                with self.subTest(size=size,fmt=fmt,lossless=lossless):
                    self.assertEqual(m.dimensions(image(size,fmt,lossless)),size)
    def test_malformed_bytes_are_not_images(self):
        for data in [b"",b"not an image",b"\xff\xd8\xff\xe0\x00\x10"]:
            self.assertIsNone(m.dimensions(data))
    def test_small_scan_falls_through_to_full_source(self):
        small=image((255,361));large=image((863,1207));key="413172_uxie.jpg"
        with tempfile.TemporaryDirectory() as folder:
            request={"out":folder,"jobs":{key:["https://cardtrader.com/thumb.jpg","https://cardtrader.com/full.jpg"]}}
            output=io.StringIO()
            with patch.object(m.sys,"stdin",io.StringIO(json.dumps(request))),contextlib.redirect_stdout(output),patch.object(m.urllib.request,"urlopen",side_effect=[Response(small),Response(large)]),patch.object(m.time,"sleep"):
                m.main()
            report=json.loads(output.getvalue())
            self.assertEqual(report["results"][key]["status"],"ok")
            self.assertEqual(pathlib.Path(folder,key).read_bytes(),large)
            self.assertFalse(report["blocked"])
    def test_challenge_stops_without_overwriting_scan(self):
        key="413172_uxie.jpg"
        with tempfile.TemporaryDirectory() as folder:
            dest=pathlib.Path(folder,key);dest.write_bytes(b"existing scan")
            request={"out":folder,"jobs":{key:["https://cardtrader.com/full.jpg","https://cardtrader.com/other.jpg"]}}
            output=io.StringIO()
            with patch.object(m.sys,"stdin",io.StringIO(json.dumps(request))),contextlib.redirect_stdout(output),patch.object(m.urllib.request,"urlopen",side_effect=urllib.error.HTTPError("https://cardtrader.com/full.jpg",403,"Forbidden",None,None)) as fetch:
                m.main()
            self.assertTrue(json.loads(output.getvalue())["blocked"])
            self.assertEqual(fetch.call_count,1)
            self.assertEqual(dest.read_bytes(),b"existing scan")
if __name__=="__main__":unittest.main()
