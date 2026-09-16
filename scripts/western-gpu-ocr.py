#!/usr/bin/env python3
"""Official PP-OCRv5 ONNX on the 7900 XTX via onnxruntime-rocm.

Weights: Hugging Face PaddlePaddle/PP-OCRv5_mobile_det_onnx +
PaddlePaddle/en_PP-OCRv5_mobile_rec_onnx (same family as CPU Paddle).
ROCMExecutionProvider first — not MIGraphX (PP-OCR rec is dynamic width).
MIOpen JIT needs ~/.local/rocm/include (rocrand + Triton's hip_runtime.h);
there is no /opt/rocm on this box.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import sys
import time
from pathlib import Path

os.environ.setdefault("HIP_VISIBLE_DEVICES", "0")
os.environ.setdefault("HSA_OVERRIDE_GFX_VERSION", "11.0.0")
os.environ.setdefault("OMP_NUM_THREADS", "4")

ORT = "/tmp/pokoin-ort-rocm"
ROCM_HOME = str(Path.home() / ".local/rocm")
SONAMES = str(Path.home() / ".local/lib/rocm-sonames")
TORCH_LIB = "/home/nez/Projects/ai-toolkit/venv/lib/python3.12/site-packages/torch/lib"
DET_ONNX = "/home/nez/.cache/ppocrv5-onnx/det/inference.onnx"
REC_ONNX = "/home/nez/.cache/ppocrv5-onnx/en-rec/inference.onnx"
REC_KEYS = "/home/nez/.cache/ppocrv5-onnx/en-rec/keys.txt"

os.environ.setdefault("ROCM_PATH", ROCM_HOME)
os.environ.setdefault("HIP_PATH", ROCM_HOME)
inc = str(Path(ROCM_HOME) / "include")
os.environ["CPATH"] = inc + os.pathsep + os.environ.get("CPATH", "")
os.environ["CPLUS_INCLUDE_PATH"] = inc + os.pathsep + os.environ.get(
    "CPLUS_INCLUDE_PATH", ""
)
ld = [p for p in (SONAMES, TORCH_LIB) if Path(p).is_dir()]
os.environ["LD_LIBRARY_PATH"] = os.pathsep.join(
    ld + ([os.environ["LD_LIBRARY_PATH"]] if os.environ.get("LD_LIBRARY_PATH") else [])
)
if ORT not in sys.path:
    sys.path.insert(0, ORT)


def load_cpu_mod():
    spec = importlib.util.spec_from_file_location(
        "western_full_ocr",
        Path(__file__).resolve().parent / "western-full-ocr.py",
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


ILLUS_RE = re.compile(r"(?:illus|ithus|wus|fles|llus)\.?", re.I)


def footer_canvas(rgb, frac: float = 0.22):
    w, h = rgb.size
    top = max(0, int(round((1.0 - frac) * h)))
    return rgb.crop((0, top, w, h))


def ocr_lines(ocr, image) -> list[str]:
    result, _elapse = ocr(image)
    texts = []
    if result:
        for item in result:
            if isinstance(item, (list, tuple)) and len(item) >= 2:
                texts.append(str(item[1]))
    return texts


def latest_ocr_rows(*jsonls: Path) -> dict[int, dict]:
    by_id: dict[int, dict] = {}
    for jsonl in jsonls:
        if not jsonl or not jsonl.is_file():
            continue
        for line in jsonl.read_text().splitlines():
            if not line.strip():
                continue
            row = json.loads(line)
            by_id[int(row["ct_id"])] = row
    return by_id


def needs_footer_retry(row: dict | None) -> bool:
    if not row or not row.get("ok"):
        return False
    text = str(row.get("text") or "")
    if ILLUS_RE.search(text):
        return False
    return bool(row.get("junk"))


def patch_rapidocr_rocm() -> None:
    from rapidocr_onnxruntime.utils import infer_engine as ie

    original = ie.OrtInferSession._get_ep_list

    def _get_ep_list(self):
        providers = original(self)
        if "ROCMExecutionProvider" in self.had_providers:
            opts = {"device_id": 0, "arena_extend_strategy": "kSameAsRequested"}
            providers.insert(0, ("ROCMExecutionProvider", opts))
        return providers

    ie.OrtInferSession._get_ep_list = _get_ep_list


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--csv", default="/tmp/western-leftovers.csv")
    parser.add_argument(
        "--out",
        default="/home/nez/Projects/pokoin-web/scripts/out/western-full-ocr-gpu.jsonl",
    )
    parser.add_argument("--also-done", action="append", default=None)
    parser.add_argument("--parity", choices=("all", "even", "odd"), default="even")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument(
        "--retry-junk-footer",
        action="store_true",
        help="Re-OCR the bottom strip of chrome-junk leftovers that have no Illus. token.",
    )
    args = parser.parse_args()

    import numpy as np
    import onnxruntime as ort
    from PIL import Image
    from rapidocr_onnxruntime import RapidOCR

    print("ort", ort.__version__, "providers", ort.get_available_providers(), flush=True)
    if "ROCMExecutionProvider" not in ort.get_available_providers():
        raise SystemExit("ROCMExecutionProvider missing")

    patch_rapidocr_rocm()
    ocr = RapidOCR(
        use_cls=False,
        det_model_path=DET_ONNX,
        rec_model_path=REC_ONNX,
        rec_keys_path=REC_KEYS,
        rec_img_shape=[3, 48, 320],
        det_limit_side_len=960,
        det_limit_type="max",
        det_mean=[0.485, 0.456, 0.406],
        det_std=[0.229, 0.224, 0.225],
        det_thresh=0.3,
        det_box_thresh=0.6,
        det_unclip_ratio=1.5,
    )
    print(
        "ppocrv5-onnx ready",
        "det_ep",
        ocr.text_det.infer.session.get_providers()[0],
        "rec_ep",
        ocr.text_rec.session.session.get_providers()[0],
        flush=True,
    )

    mod = load_cpu_mod()
    rows = mod.load_csv(Path(args.csv))
    mod.attach_paths(rows)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    also = args.also_done or [
        "/home/nez/Projects/pokoin-web/scripts/out/western-full-ocr.jsonl"
    ]
    prior = latest_ocr_rows(out, *[Path(p) for p in also])
    if args.retry_junk_footer:
        todo = [
            row
            for row in rows
            if needs_footer_retry(prior.get(int(row["ct_id"])))
        ]
        done = {ct for ct, rec in prior.items() if not needs_footer_retry(rec)}
    else:
        done = set(prior)
        todo = [row for row in rows if int(row["ct_id"]) not in done]
        if args.parity != "all":
            want_even = args.parity == "even"
            todo = [row for row in todo if (int(row["ct_id"]) % 2 == 0) == want_even]
    if args.limit:
        todo = todo[: args.limit]
    print(
        f"gpu ppocrv5-onnx-rocm todo {len(todo)} resume {len(done)} "
        f"parity={args.parity} footer={args.retry_junk_footer}",
        flush=True,
    )
    if not todo:
        return

    started = time.time()
    ok = junk = fail = 0
    with out.open("a", encoding="utf-8") as progress:
        for index, row in enumerate(todo, start=1):
            path = Path(row["path"]) if row.get("path") else None
            record = {
                "expansion_id": int(row["expansion_id"]),
                "expansion": row["expansion"],
                "code": row["code"],
                "card_id": int(row["card_id"]),
                "ct_id": int(row["ct_id"]),
                "name": row["name"],
                "num": row["num"],
                "engine": "ppocrv5-onnx-rocm",
            }
            t0 = time.perf_counter()
            try:
                if path is None:
                    raise FileNotFoundError("missing")
                with Image.open(path) as im:
                    rgb = im.convert("RGB")
                if args.retry_junk_footer:
                    canvas = footer_canvas(rgb)
                    crop = "footer"
                    prev = str((prior.get(int(row["ct_id"])) or {}).get("text") or "")
                else:
                    canvas, crop = mod.western_text_canvas(rgb, row.get("num", ""))
                    prev = ""
                texts = ocr_lines(ocr, canvas)
                blob = "\n".join(texts)
                if (
                    not args.retry_junk_footer
                    and mod.english_ocr_is_junk(blob)
                    and not ILLUS_RE.search(blob)
                ):
                    extra = ocr_lines(ocr, footer_canvas(rgb))
                    extra_blob = "\n".join(extra)
                    if extra_blob.strip():
                        texts.extend(extra)
                        blob = f"{blob}\n{extra_blob}".strip()
                        crop = f"{crop}+footer"
                if prev:
                    blob = f"{prev}\n{blob}".strip()
                    crop = "chrome+footer"
                record["crop"] = crop
                record.update(
                    ok=True,
                    junk=mod.english_ocr_is_junk(blob),
                    text=blob[:1500],
                    conf=0,
                    s=round(time.perf_counter() - t0, 3),
                    file=path.name,
                    lines=len(texts),
                )
            except Exception as exc:
                record.update(
                    ok=False,
                    junk=True,
                    text="",
                    conf=0,
                    s=round(time.perf_counter() - t0, 3),
                    err=f"{type(exc).__name__}: {exc}",
                )
            progress.write(json.dumps(record, ensure_ascii=False) + "\n")
            progress.flush()
            if not record.get("ok"):
                fail += 1
            elif record.get("junk"):
                junk += 1
            else:
                ok += 1
            if index % 10 == 0 or index <= 3 or index == len(todo):
                elapsed = time.time() - started
                rate = index / elapsed if elapsed else 0
                print(
                    f"gpu {index}/{len(todo)} ok={ok} junk={junk} fail={fail} "
                    f"{rate:.2f}/s last={record.get('s')}s "
                    f"eta={(len(todo)-index)/rate/60 if rate else 0:.1f}m",
                    flush=True,
                )

    # ROCM EP allocator aborts in atexit ("corrupted size vs prev_size").
    os._exit(0)


if __name__ == "__main__":
    main()
