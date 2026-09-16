#!/usr/bin/env python3
"""English PP-OCRv5 first. Qwen3-VL only on leftover junk (JP vs CN)."""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

os.environ.setdefault("DISABLE_MODEL_SOURCE_CHECK", "True")

sys.path.insert(0, str(Path(__file__).resolve().parent))
from qwen_llama import chat_image
from PIL import Image
from paddleocr import PaddleOCR

OBJECTS = Path(
    os.environ.get("POKOIN_NVME_LEFTOVERS", "/home/nez/data/pokoin-leftovers")
) / "objects"
MODEL = "qwen3-vl:32b-instruct"
PROMPT = """This leftover scan failed English OCR. Classify the PRINTED RULES TEMPLATE.

Return ONLY JSON:
{"print":"japanese"|"chinese"|"korean"|"english"|"other","why":"<=12 words"}

japanese = にげる, hiragana/katakana in the rules (not only a big attack title).
chinese = Han rules without kana: 撤退, 宝可梦.
korean = Hangul template.
english = Weakness / Resistance / Retreat / Illus. in Latin.
other = Indonesian, Thai, French, or unreadable.
"""
PRINT_RE = re.compile(
    r'\{[^{}]*"print"\s*:\s*"(japanese|chinese|korean|english|other)"[^{}]*\}',
    re.I,
)
STRONG_RE = re.compile(
    r"\b(weakness|resistance|retreat|illus|evolves?|ability|supporter|"
    r"knocked out|mega evolution|poke-body|poke-power)\b",
    re.I,
)
YOUR_RE = re.compile(r"\byour (deck|hand|bench|opponent)\b", re.I)
WEAK_RE = re.compile(r"\b(pokemon|pokémon|attack|damage|prize|trainer|stage)\b", re.I)


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


def image_key(image: str) -> str:
    name = str(image or "").split("?", 1)[0]
    return name.rsplit("/", 1)[-1]


def pick_card(cards: list[dict]) -> tuple[dict | None, Path | None]:
    for card in cards or []:
        key = image_key(card.get("image") or "")
        if not key:
            continue
        path = OBJECTS / key
        if path.is_file():
            return card, path
    return None, None


def parse_print(text: str) -> dict:
    blob = str(text or "")
    match = PRINT_RE.search(blob)
    raw = match.group(0) if match else blob[blob.find("{") : blob.rfind("}") + 1]
    data = json.loads(raw)
    print_lang = str(data.get("print") or "").strip().lower()
    if print_lang not in {"japanese", "chinese", "korean", "english", "other"}:
        raise ValueError(f"bad print {print_lang!r}")
    return {"print": print_lang, "why": str(data.get("why") or "").strip()[:160]}


def english_ocr(engine: PaddleOCR, path: Path) -> dict:
    with Image.open(path) as im:
        rgb = im.convert("RGB")
        w, h = rgb.size
        work = path
        tmp = None
        if h < 600:
            rgb = rgb.resize((w * 2, h * 2), Image.Resampling.LANCZOS)
            tmp = path.with_name(path.stem + ".ocr-up.png")
            rgb.save(tmp)
            work = tmp
    started = time.perf_counter()
    item = engine.predict(str(work))[0]
    elapsed = round(time.perf_counter() - started, 2)
    if tmp is not None:
        tmp.unlink(missing_ok=True)
    texts = [str(t) for t in (item.get("rec_texts") or [])]
    scores = [float(s) for s in (item.get("rec_scores") or [])]
    blob = "\n".join(texts)
    return {
        "text": blob,
        "conf": round(sum(scores) / len(scores), 4) if scores else 0,
        "junk": english_ocr_is_junk(blob),
        "s": elapsed,
        "lines": len(texts),
    }


def qwen_classify(path: Path) -> dict:
    t0 = time.time()
    text = chat_image(PROMPT, path.read_bytes(), model=MODEL, max_tokens=80)
    parsed = parse_print(text)
    parsed["s"] = round(time.time() - t0, 2)
    return parsed


def load_done(jsonl: Path) -> dict[int, dict]:
    done = {}
    if not jsonl.is_file():
        return done
    for line in jsonl.read_text().splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        if "ocr_junk" not in row:
            continue
        done[int(row["expansion_id"])] = row
    return done


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", default="/tmp/ocr-expansions-full.json")
    parser.add_argument("--jsonl", default="/tmp/expansion-english-ocr.jsonl")
    parser.add_argument(
        "--out",
        default="/home/nez/Projects/pokoin-web/market/public/review/ocr-expansions.json",
    )
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()

    expansions = json.loads(Path(args.input).read_text())
    if args.limit:
        expansions = expansions[: args.limit]
    jsonl_path = Path(args.jsonl)
    done = load_done(jsonl_path)
    print(f"expansions {len(expansions)} resume {len(done)}", flush=True)
    engine = PaddleOCR(
        lang="en",
        ocr_version="PP-OCRv5",
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
    )

    with jsonl_path.open("a", encoding="utf-8") as progress:
        for index, row in enumerate(expansions, start=1):
            expansion_id = int(row["expansion_id"])
            if expansion_id in done:
                continue
            card, path = pick_card(row.get("cards") or [])
            record = {
                "expansion_id": expansion_id,
                "name": row.get("name"),
                "code": row.get("code"),
                "nationality": row.get("nationality"),
                "listed": row.get("listed"),
                "official_source": row.get("official_source"),
                "kind": row.get("kind"),
                "total": row.get("total"),
            }
            if not card or path is None:
                record.update({
                    "ocr_junk": True,
                    "ocr_text": "",
                    "print": "missing",
                    "why": "no local leftover",
                    "s": 0,
                    "card": None,
                })
            else:
                ocr = english_ocr(engine, path)
                record["ocr_junk"] = ocr["junk"]
                record["ocr_text"] = ocr["text"][:800]
                record["ocr_s"] = ocr["s"]
                record["ocr_conf"] = ocr["conf"]
                record["card"] = {
                    "id": card["id"],
                    "ct_id": card["ct_id"],
                    "name": card["name"],
                    "num": card["num"],
                    "image": card["image"].split("?", 1)[0],
                }
                if not ocr["junk"]:
                    record["print"] = "english"
                    record["why"] = "English OCR hit TCG template"
                    record["s"] = ocr["s"]
                else:
                    try:
                        parsed = qwen_classify(path)
                    except Exception as exc:
                        print(f"QWEN FAIL {row['name']}: {exc}", flush=True)
                        time.sleep(2)
                        parsed = qwen_classify(path)
                    record["print"] = parsed["print"]
                    record["why"] = parsed["why"]
                    record["s"] = parsed["s"]
            progress.write(json.dumps(record, ensure_ascii=False) + "\n")
            progress.flush()
            done[expansion_id] = record
            print(
                f"{index}/{len(expansions)} {row['name']} db={row['nationality']} "
                f"junk={record.get('ocr_junk')} qwen={record.get('print')} "
                f"ocr={record.get('ocr_s')}s vl={record.get('s')}s",
                flush=True,
            )

    board_rows = []
    for row in expansions:
        hit = done.get(int(row["expansion_id"]))
        if not hit:
            continue
        card = hit.get("card")
        board_rows.append({
            "expansion_id": hit["expansion_id"],
            "name": hit["name"],
            "code": hit.get("code") or "",
            "nationality": hit["nationality"],
            "listed": hit.get("listed"),
            "official_source": hit.get("official_source") or "",
            "kind": hit.get("kind") or "",
            "total": hit.get("total") or 0,
            "ocr_junk": bool(hit.get("ocr_junk")),
            "ocr_text": hit.get("ocr_text") or "",
            "qwen_print": hit.get("print"),
            "qwen_why": hit.get("why") or "",
            "qwen_s": hit.get("s") or 0,
            "cards": [card] if card else [],
        })
    board = {
        "revision": "2026-09-13-en-ocr-then-qwen",
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "host": "test.pokoin.com",
        "path": "/ocr",
        "engine": "PP-OCRv5 English, then qwen3-vl:32b on junk",
        "model": MODEL,
        "count": len(board_rows),
        "expansions": board_rows,
    }
    Path(args.out).write_text(
        json.dumps(board, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(f"wrote {args.out} n={len(board_rows)}", flush=True)


if __name__ == "__main__":
    main()
