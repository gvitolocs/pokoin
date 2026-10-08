#!/usr/bin/env python3
"""Restore Pokemon card-back rows in a CNN pokemon_generic catalog (new dir).

The live milo_cnn catalog (catalogs-cnn-v22-allgames-20261004c) has zero
item_kind=card_back rows, so app._prefer_card_back_hits / _should_skip_card_back_box
never fire (card_back_score stays null) and Vinted back photos come back as
lookalike fronts (~0.69 Eelektross). This builds a sibling catalog dir with the
back rows appended to pokemon_generic, leaving the live dir untouched.

Embedder is copied verbatim from server/scan/worker/app.py (milo.onnx 128-d,
448^2, ImageNet mean/std, L2-normalised) and run CPU-only, so parity with the
stored vectors is exact. The live catalog dir is never modified; the worker is
never restarted by this tool.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
import urllib.request
from io import BytesIO
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps

# Constants copied from server/scan/worker/app.py (do not import app.py).
MILO_SIZE = 448
MILO_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
MILO_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)

BATTLE_ROOT = Path('/home/nez/Projects/BattleScan')
MODELS = Path(os.environ.get('CARDSCAN_MODELS', str(BATTLE_ROOT / 'runtime/fast-models-cnn')))
MILO_PATH = MODELS / 'milo.onnx'
STAGING = BATTLE_ROOT / '.staging/card-back'
BACK_IMAGE = STAGING / 'pokemon-tcg-back.jpg'
BACK_URL = 'https://images.pokemontcg.io/base1/back.png'
DEFAULT_SRC = Path('/home/nez/data/pokoin-scan-catalogs/catalogs-cnn-v22-allgames-20261004c')
DEFAULT_DST = Path('/home/nez/data/pokoin-scan-catalogs/catalogs-cnn-v22-allgames-20261005-backs')
GENERIC = 'pokemon_generic'


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def _cos(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-12))


def _load_rows(path: Path) -> list:
    return [json.loads(line) for line in path.read_text(encoding='utf-8').splitlines() if line.strip()]


def _write_rows(path: Path, rows: list) -> None:
    path.write_text(''.join(json.dumps(row, ensure_ascii=False) + '\n' for row in rows), encoding='utf-8')


def build_embedder() -> np.ndarray:
    import onnxruntime as ort

    opts = ort.SessionOptions()
    opts.intra_op_num_threads = int(os.environ.get('CARDSCAN_THREADS', '1'))
    opts.inter_op_num_threads = 1
    session = ort.InferenceSession(str(MILO_PATH), opts, providers=['CPUExecutionProvider'])
    input_name = session.get_inputs()[0].name

    def embed(crop_rgb: np.ndarray) -> np.ndarray:
        im = Image.fromarray(crop_rgb).resize((MILO_SIZE, MILO_SIZE), Image.BILINEAR)
        x = np.asarray(im, dtype=np.float32) / 255.0
        x = (x - MILO_MEAN) / MILO_STD
        x = np.transpose(x, (2, 0, 1))[None, ...]
        vec = np.asarray(session.run(None, {input_name: x})[0], dtype=np.float32).reshape(-1)
        n = float(np.linalg.norm(vec))
        return vec / max(n, 1e-8)

    return embed


def fetch_rgb(url: str) -> np.ndarray:
    req = urllib.request.Request(url, headers={'User-Agent': 'pokoin-catalog-backs/1.0'})
    with urllib.request.urlopen(req, timeout=20) as resp:
        blob = resp.read()
    source = Image.open(BytesIO(blob))
    return np.asarray(ImageOps.exif_transpose(source).convert('RGB'))


def load_rgb(path: Path) -> np.ndarray:
    source = Image.open(str(path))
    return np.asarray(ImageOps.exif_transpose(source).convert('RGB'))


def back_sources(extra: list) -> list:
    """(path, public_id, reference_source) for every card-back photo to embed."""
    sources = [(BACK_IMAGE, 'pokemon-card-back', 'pokemon-tcg-card-back')]
    variants = STAGING / 'variants'
    if variants.is_dir():
        for f in sorted(variants.glob('*.jpg')):
            sources.append((f, f'pokemon-card-back-{f.stem}', f'card-back-variant:{f.name}'))
    for f in sorted(STAGING.glob('vinted-lilia-back-*.jpg')):
        sources.append((f, f'pokemon-card-back-{f.stem}', f'card-back-variant:{f.name}'))
    for d in extra:
        d = Path(d)
        if d.is_dir():
            for f in sorted(d.glob('*.jpg')):
                sources.append((f, f'pokemon-card-back-{f.stem}', f'extra-back:{f.name}'))
    return sources


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('--src', type=Path, default=DEFAULT_SRC)
    ap.add_argument('--dst', type=Path, default=DEFAULT_DST)
    ap.add_argument('--extra', type=Path, action='append', default=[])
    ap.add_argument('--probe', type=Path, default=None)
    args = ap.parse_args()

    src, dst = args.src, args.dst
    if not src.is_dir():
        sys.exit(f'src catalog not found: {src}')
    if dst.exists():
        sys.exit(f'dst already exists, refusing to overwrite: {dst}')
    generic_src = src / GENERIC
    if not generic_src.is_dir():
        sys.exit(f'src catalog has no {GENERIC} subdir: {generic_src}')

    manifest = json.loads((src / 'manifest.json').read_text(encoding='utf-8'))
    entry = next((item for item in manifest.get('catalogs') or [] if item.get('id') == GENERIC), None)
    if entry is None:
        sys.exit('manifest has no pokemon_generic entry; cannot update it')
    if not MILO_PATH.is_file():
        sys.exit(f'milo model not found: {MILO_PATH}')
    if _sha256(MILO_PATH) != manifest.get('model_sha256'):
        sys.exit('milo.onnx does not match the manifest model_sha256; aborting')

    # --- create DST: manifest copy, hard-link sibling catalogs, copy pokemon_generic ---
    dst.mkdir(parents=True)
    shutil.copy2(src / 'manifest.json', dst / 'manifest.json')
    os.chmod(dst / 'manifest.json', 0o644)
    me = os.getuid()
    for subdir in sorted(p for p in src.iterdir() if p.is_dir()):
        target = dst / subdir.name
        target.mkdir()
        for f in sorted(subdir.iterdir()):
            if f.is_file():
                if subdir.name == GENERIC:
                    # copy2 preserves the read-only source mode (0444); make the
                    # copies writable so np.save / write_text can truncate them.
                    dest = target / f.name
                    shutil.copy2(f, dest)
                    os.chmod(dest, 0o644)
                else:
                    os.link(f, target / f.name)
        try:
            os.chown(target, me, os.getgid())
        except PermissionError:
            pass
    try:
        os.chown(dst, me, os.getgid())
    except PermissionError:
        pass

    # --- embedder (CPU-only) + parity check on 3 existing rows ---
    embed = build_embedder()
    rows = _load_rows(generic_src / 'metadata.jsonl')
    vectors = np.load(generic_src / 'embeddings.npy')
    if vectors.shape != (len(rows), 128):
        sys.exit(f'src pokemon_generic mismatch: {vectors.shape} vs {len(rows)} rows')
    print(f'src {GENERIC}: {len(rows)} rows, vectors {vectors.shape}')

    parity_rows = [r for r in rows if r.get('image_url')]
    if len(parity_rows) < 3:
        sys.exit('not enough rows with image_url for parity check')
    min_cos = 1.0
    for i, row in enumerate(parity_rows[:3]):
        url = str(row['image_url'])
        stored = vectors[i]
        try:
            fresh = embed(fetch_rgb(url))
            cos = _cos(fresh, stored)
        except Exception as exc:
            print(f'parity row {i} {row.get("name")!r} {url} FAILED: {exc!r}', flush=True)
            sys.exit('parity check failed (download/embed error)')
        print(f'parity row {i} {row.get("name")!r} {url} cosine={cos:.5f}', flush=True)
        min_cos = min(min_cos, cos)
    if min_cos < 0.98:
        print(f'parity check FAILED: min cosine {min_cos:.5f} < 0.98', flush=True)
        sys.exit(1)
    print(f'parity OK (min cosine {min_cos:.5f})', flush=True)

    # --- embed the card-back photos ---
    existing_ids = {str(r.get('public_id') or '') for r in rows}
    new_rows: list = []
    new_vecs: list = []
    for path, public_id, reference_source in back_sources(args.extra):
        if not path.is_file():
            print(f'skip (missing): {path}', flush=True)
            continue
        if public_id in existing_ids:
            print(f'skip (already present): {public_id}', flush=True)
            continue
        vec = embed(load_rgb(path)).astype(np.float32).reshape(1, -1)
        new_rows.append({
            'id': public_id,
            'ct_id': '',
            'public_id': public_id,
            'name': 'Pokemon Card Back',
            'collector_number': 'Back',
            'set': 'Card Back',
            'game': 'pokemon',
            'language': 'generic',
            'image_url': BACK_URL,
            'pokoin_url': '',
            'reference_source': reference_source,
            'item_kind': 'card_back',
        })
        new_vecs.append(vec)
        print(f'added {public_id} ({path.name})', flush=True)
    if not new_vecs:
        print('nothing new to add; leaving DST in place for inspection', flush=True)
        return

    combined = np.concatenate([vectors, np.vstack(new_vecs)], axis=0).astype(np.float32)
    all_rows = rows + new_rows
    dst_cat = dst / GENERIC
    np.save(dst_cat / 'embeddings.npy', combined)
    _write_rows(dst_cat / 'metadata.jsonl', all_rows)
    print(f'DST {GENERIC}: {len(all_rows)} rows ({len(rows)} + {len(new_rows)} backs)', flush=True)

    # --- update the DST manifest (count / sha256 / supplements) ---
    entry['count'] = len(all_rows)
    entry['sha256'] = {
        name: _sha256(dst_cat / name) for name in ('embeddings.npy', 'metadata.jsonl')
    }
    (dst / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    print(f'DST manifest updated: {GENERIC} count={entry["count"]}', flush=True)

    # --- self-test: embed the back again, search DST pokemon_generic ---
    d_vectors = np.load(dst_cat / 'embeddings.npy')
    d_rows = _load_rows(dst_cat / 'metadata.jsonl')
    if d_vectors.shape != (len(d_rows), 128):
        sys.exit(f'DST {GENERIC} mismatch: {d_vectors.shape} vs {len(d_rows)} rows')

    def is_back(rec: dict) -> bool:
        if str(rec.get('item_kind') or '') == 'card_back':
            return True
        compact = ''.join(ch for ch in str(rec.get('name') or '').lower() if ch.isalnum())
        return 'pokemoncardback' in compact or compact == 'cardback'

    back_mask = np.fromiter((is_back(r) for r in d_rows), dtype=bool)
    q = embed(load_rgb(BACK_IMAGE))
    scores = d_vectors @ q
    k = min(3, scores.shape[0])
    top = np.argpartition(scores, -k)[-k:]
    top = top[np.argsort(scores[top])[::-1]]
    print('self-test top 3 (query = pokemon-tcg-back.jpg):', flush=True)
    for rank, i in enumerate(top, 1):
        rec = d_rows[int(i)]
        print(f'  {rank}. {rec.get("name")!r} score={float(scores[int(i)]):.4f} back={is_back(rec)}', flush=True)
    top1 = d_rows[int(top[0])]
    if not (is_back(top1) and float(scores[int(top[0])]) >= 0.95):
        print(f'self-test FAILED: top1 is not a card back >= 0.95', flush=True)
        sys.exit(1)
    print('self-test OK: top1 is a card back >= 0.95', flush=True)

    if args.probe and args.probe.is_dir():
        print(f'probe ({args.probe}) max card-back score per image:', flush=True)
        for f in sorted(args.probe.glob('*.jpg')):
            try:
                pv = embed(load_rgb(f))
            except Exception as exc:
                print(f'  {f.name}: FAILED {exc!r}', flush=True)
                continue
            ps = d_vectors @ pv
            if back_mask.any():
                mx = float(np.max(ps[back_mask]))
            else:
                mx = -1.0
            print(f'  {f.name}: max card-back score={mx:.4f}', flush=True)

    print(f'done. DST={dst}', flush=True)


if __name__ == '__main__':
    main()
