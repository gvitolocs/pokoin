#!/usr/bin/env python3
"""Full English PP-OCRv5 of every western leftover single. Multiprocess CPU.

Western Pokemon cards in one expansion share a template. OCR the name/HP
strip plus the attack/WRR/Illus band and skip the illustration window
(same fractions as market/src/art-cut.js). Full-art / SIR / rainbow keep
the whole scan because text sits on the picture.

Does not OCR Japanese/Chinese expansions. GPU Surya/EasyOCR is the wrong
tool for this pass — Paddle English on the text chrome is the working stack.
"""
from __future__ import annotations

import argparse
import csv
import json
import multiprocessing as mp
import os
import re
import time
from pathlib import Path

os.environ.setdefault("DISABLE_MODEL_SOURCE_CHECK", "True")
os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("MKL_NUM_THREADS", "1")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
os.environ.setdefault("FLAGS_use_mkldnn", "0")

OBJECTS = Path(
    os.environ.get("POKOIN_NVME_LEFTOVERS", "/home/nez/data/pokoin-leftovers")
) / "objects"
STRONG_RE = re.compile(
    r"\b(weakness|resistance|retreat|illus|evolves?|ability|supporter|"
    r"knocked out|mega evolution|poke-body|poke-power)\b",
    re.I,
)
YOUR_RE = re.compile(r"\byour (deck|hand|bench|opponent)\b", re.I)
WEAK_RE = re.compile(r"\b(pokemon|pokémon|attack|damage|prize|trainer|stage)\b", re.I)
# Same illustration window as market/src/art-cut.js POKEMON_ART_CUT.
ART_TOP = 0.125
ART_HEIGHT = 0.36
FULL_ART_RE = re.compile(
    r"illustration rare|special illustration|full-?art|rainbow|"
    r"gold secret|hyper rare|alternate art|jumbo",
    re.I,
)

_ENGINE = None


def english_ocr_is_junk(text: str) -> bool:
    blob = str(text or "")
    if not blob.strip():
        return True
    score = (
        len(STRONG_RE.findall(blob)) * 2
        + len(YOUR_RE.findall(blob)) * 2
        + len(WEAK_RE.findall(blob))
    )
    return score < 3


def uses_full_card(num: str) -> bool:
    return bool(FULL_ART_RE.search(str(num or "")))


def western_text_canvas(rgb, num: str = ""):
    """Drop the shared illustration window; keep name bar + attack chrome."""
    from PIL import Image

    w, h = rgb.size
    if uses_full_card(num) or h < 80:
        return rgb, "full"
    header_h = max(1, int(round((ART_TOP + 0.02) * h)))
    body_y = min(h - 1, int(round((ART_TOP + ART_HEIGHT - 0.02) * h)))
    header = rgb.crop((0, 0, w, header_h))
    body = rgb.crop((0, body_y, w, h))
    canvas = Image.new("RGB", (w, header.height + body.height))
    canvas.paste(header, (0, 0))
    canvas.paste(body, (0, header.height))
    return canvas, "chrome"



def index_objects() -> tuple[dict[str, Path], dict[int, list[Path]]]:
    by_name: dict[str, Path] = {}
    by_ct: dict[int, list[Path]] = {}
    with os.scandir(OBJECTS) as entries:
        for entry in entries:
            name = entry.name
            if not name.lower().endswith((".jpg", ".jpeg", ".png")):
                continue
            path = Path(entry.path)
            by_name[name] = path
            ct_token = name.split("_", 1)[0]
            if ct_token.isdigit() and "_homepage" not in name:
                by_ct.setdefault(int(ct_token), []).append(path)
    for paths in by_ct.values():
        paths.sort(key=lambda p: p.name)
    return by_name, by_ct


def attach_paths(rows: list[dict]) -> dict:
    by_name, by_ct = index_objects()
    report = {"exact": 0, "ext": [], "remap": [], "missing": []}
    for row in rows:
        key = str(row["image"] or "").split("?", 1)[0]
        path = by_name.get(key)
        how = "exact"
        if path is None:
            stem = Path(key).stem
            for ext in (".jpg", ".jpeg", ".png"):
                alt = by_name.get(f"{stem}{ext}")
                if alt is not None:
                    path = alt
                    how = "ext"
                    report["ext"].append(
                        {"ct_id": int(row["ct_id"]), "cdn": key, "file": alt.name}
                    )
                    break
        if path is None:
            hits = by_ct.get(int(row["ct_id"])) or []
            if hits:
                path = hits[0]
                how = "remap"
                report["remap"].append(
                    {
                        "ct_id": int(row["ct_id"]),
                        "cdn": key,
                        "file": path.name,
                        "name": row["name"],
                    }
                )
        if path is None:
            row["path"] = ""
            report["missing"].append(
                {
                    "ct_id": int(row["ct_id"]),
                    "cdn": key,
                    "name": row["name"],
                    "expansion": row["expansion"],
                }
            )
        else:
            row["path"] = str(path)
            if how == "exact":
                report["exact"] += 1
    return report


def init_worker() -> None:
    global _ENGINE
    os.environ["DISABLE_MODEL_SOURCE_CHECK"] = "True"
    os.environ["OMP_NUM_THREADS"] = "1"
    os.environ["MKL_NUM_THREADS"] = "1"
    os.environ["OPENBLAS_NUM_THREADS"] = "1"
    os.environ["NUMEXPR_NUM_THREADS"] = "1"
    os.environ["VECLIB_MAXIMUM_THREADS"] = "1"
    os.environ["PADDLE_NUM_THREADS"] = "1"
    os.environ["CPU_NUM"] = "1"
    os.environ["FLAGS_use_mkldnn"] = "0"
    os.environ["FLAGS_num_threads"] = "1"
    try:
        import cv2

        cv2.setNumThreads(1)
    except Exception:
        pass
    import paddle

    setter = getattr(paddle, "set_num_threads", None)
    if callable(setter):
        setter(1)
    else:
        core = getattr(paddle, "base", None)
        core = getattr(core, "core", None) if core is not None else None
        core_setter = getattr(core, "set_num_threads", None)
        if callable(core_setter):
            core_setter(1)
    from paddleocr import PaddleOCR

    _ENGINE = PaddleOCR(
        text_detection_model_name="PP-OCRv5_mobile_det",
        text_recognition_model_name="en_PP-OCRv5_mobile_rec",
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
    )


def ocr_one(row: dict) -> dict:
    from PIL import Image

    path = Path(row["path"]) if row.get("path") else None
    record = {
        "expansion_id": int(row["expansion_id"]),
        "expansion": row["expansion"],
        "code": row["code"],
        "card_id": int(row["card_id"]),
        "ct_id": int(row["ct_id"]),
        "name": row["name"],
        "num": row["num"],
    }
    if path is None:
        record.update(ok=False, junk=True, text="", conf=0, s=0, err="missing")
        return record
    record["file"] = path.name
    started = time.perf_counter()
    try:
        with Image.open(path) as im:
            rgb = im.convert("RGB")
            w, h = rgb.size
            rgb, crop = western_text_canvas(rgb, row.get("num", ""))
            record["crop"] = crop
            cw, ch = rgb.size
            tmp = path.with_name(path.stem + f".ocr-{os.getpid()}.jpg")
            if ch < 400:
                rgb = rgb.resize((cw * 2, ch * 2), Image.Resampling.LANCZOS)
            rgb.save(tmp, quality=92)
            work = tmp
        item = _ENGINE.predict(str(work))[0]
        Path(work).unlink(missing_ok=True)
        texts = [str(t) for t in (item.get("rec_texts") or [])]
        scores = [float(s) for s in (item.get("rec_scores") or [])]
        blob = "\n".join(texts)
        record.update(
            ok=True,
            junk=english_ocr_is_junk(blob),
            text=blob[:1500],
            conf=round(sum(scores) / len(scores), 4) if scores else 0,
            s=round(time.perf_counter() - started, 3),
            lines=len(texts),
            size=f"{w}x{h}",
        )
    except Exception as exc:
        record.update(
            ok=False,
            junk=True,
            text="",
            conf=0,
            s=round(time.perf_counter() - started, 3),
            err=f"{type(exc).__name__}: {exc}",
        )
    return record


def load_csv(path: Path) -> list[dict]:
    rows = []
    with path.open(newline="", encoding="utf-8") as handle:
        for expansion_id, expansion, code, nationality, card_id, ct_id, name, num, image in csv.reader(handle):
            rows.append(
                {
                    "expansion_id": expansion_id,
                    "expansion": expansion,
                    "code": code,
                    "nationality": nationality,
                    "card_id": card_id,
                    "ct_id": ct_id,
                    "name": name,
                    "num": num,
                    "image": image,
                }
            )
    return rows


def load_done(*jsonls: Path) -> set[int]:
    done = set()
    for jsonl in jsonls:
        if not jsonl or not jsonl.is_file():
            continue
        for line in jsonl.read_text().splitlines():
            if not line.strip():
                continue
            row = json.loads(line)
            done.add(int(row["ct_id"]))
    return done


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--csv", default="/tmp/western-leftovers.csv")
    parser.add_argument(
        "--out",
        default="/home/nez/Projects/pokoin-web/scripts/out/western-full-ocr.jsonl",
    )
    parser.add_argument("--workers", type=int, default=os.cpu_count() or 12)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument(
        "--report",
        default="/home/nez/Projects/pokoin-web/scripts/out/western-leftover-image-report.json",
    )
    parser.add_argument("--also-done", action="append", default=[])
    parser.add_argument(
        "--parity",
        choices=("all", "even", "odd"),
        default="all",
    )
    args = parser.parse_args()

    rows = load_csv(Path(args.csv))
    report = attach_paths(rows)
    Path(args.report).parent.mkdir(parents=True, exist_ok=True)
    Path(args.report).write_text(json.dumps(report, indent=2) + "\n")
    print(
        f"images exact={report['exact']} ext={len(report['ext'])} "
        f"remap={len(report['remap'])} missing={len(report['missing'])}",
        flush=True,
    )
    if args.limit:
        rows = rows[: args.limit]
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    done = load_done(out, *[Path(p) for p in args.also_done])
    todo = [row for row in rows if int(row["ct_id"]) not in done]
    if args.parity != "all":
        want_even = args.parity == "even"
        todo = [row for row in todo if (int(row["ct_id"]) % 2 == 0) == want_even]
    print(
        f"western {len(rows)} resume {len(done)} todo {len(todo)} "
        f"workers {args.workers} parity={args.parity}",
        flush=True,
    )
    if not todo:
        return

    started = time.time()
    ok = junk = fail = 0
    ctx = mp.get_context("spawn")
    with out.open("a", encoding="utf-8") as progress, ctx.Pool(
        processes=args.workers,
        initializer=init_worker,
    ) as pool:
        for index, record in enumerate(
            pool.imap_unordered(ocr_one, todo, chunksize=4),
            start=1,
        ):
            progress.write(json.dumps(record, ensure_ascii=False) + "\n")
            progress.flush()
            if not record.get("ok"):
                fail += 1
            elif record.get("junk"):
                junk += 1
            else:
                ok += 1
            if index % 50 == 0 or index == len(todo):
                elapsed = time.time() - started
                rate = index / elapsed if elapsed else 0
                print(
                    f"{index}/{len(todo)} ok={ok} junk={junk} fail={fail} "
                    f"{rate:.1f}/s eta={(len(todo)-index)/rate/60 if rate else 0:.1f}m",
                    flush=True,
                )


if __name__ == "__main__":
    mp.set_start_method("spawn", force=True)
    main()
