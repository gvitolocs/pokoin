#!/usr/bin/env python3
"""Train printed expansion marks on rectified western BW--SV card scans.

No artwork or collector number is supplied to the classifier. Runtime files
belong outside the checkout. Requires the existing nezopt ROCm torch environment.
"""
import argparse
import hashlib
import json
import random
import time
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
from PIL import Image

SIZE = (64, 48)
HOLDOUT_ART = {'v589520'}  # User's Crispin artwork; all printings stay unseen.


def symbol_box(official_id):
    if official_id.startswith('sv'):
        return (.088, .932, .171, .978)
    if official_id.startswith(('sm', 'swsh')):
        return (.054, .928, .112, .980)
    if official_id.startswith(('bw', 'xy')):
        return (.898, .921, .956, .978)
    raise ValueError(f'Unsupported layout: {official_id}')


def crop_symbol(im, official_id, camera=False):
    if camera:
        im = im.copy()
        im.thumbnail((640, 640), Image.Resampling.LANCZOS)
    w, h = im.size
    a, b, c, d = symbol_box(official_id)
    return im.crop((round(w*a), round(h*b), round(w*c), round(h*d))).resize(SIZE, Image.Resampling.BICUBIC)


def art_split(key):
    return 'val' if key in HOLDOUT_ART or int(hashlib.sha256(key.encode()).hexdigest()[:8], 16) % 5 == 0 else 'train'


def prepare(args):
    out = Path(args.output); out.mkdir(parents=True, exist_ok=True)
    roots = [Path(p) for p in args.images]
    index = defaultdict(list)
    for root in roots:
        for p in root.iterdir():
            if p.suffix.lower() not in ('.jpg', '.jpeg', '.png') or 'thumb' in p.name or '_homepage' in p.name:
                continue
            index[p.name.split('_')[0]].append(p)
    rows = [json.loads(l) for l in Path(args.catalog).read_text().splitlines() if l.strip()]
    random.Random(42).shuffle(rows)
    samples = []; counts = Counter(); missing = 0; seen = set()
    for r in rows:
        code = r['code']; key = r.get('version') or f"ct:{r['ct_id']}"
        split = art_split(key)
        if (code, r['ct_id']) in seen or counts[(code, split)] >= (180 if split == 'train' else 60):
            continue
        basename = Path(r.get('image_url') or '').name
        candidates = [root / basename for root in roots if (root / basename).is_file()]
        candidates += sorted(index.get(str(r['ct_id']), []), key=lambda p: p.stat().st_size, reverse=True)
        im = None
        for p in candidates:
            try:
                candidate = Image.open(p).convert('RGB')
                if candidate.width >= 400 and 1.25 < candidate.height / candidate.width < 1.5:
                    im = candidate; source = str(p); break
            except (OSError, ValueError):
                continue
        if im is None:
            missing += 1; continue
        crops = [np.asarray(crop_symbol(im, r['official_id'], camera=c)) for c in (False, True)]
        if np.std(crops[0]) < 8:  # Empty/placeholder marks cannot teach a set.
            continue
        seen.add((code, r['ct_id'])); counts[(code, split)] += 1
        samples.append((r | {'art_group': key, 'split': split, 'source': source}, crops))
    classes = sorted({r['code'] for r, _ in samples if counts[(r['code'], 'train')] >= 20 and counts[(r['code'], 'val')] >= 5})
    samples = [(r, c) for r, c in samples if r['code'] in classes]
    assert not ({r['art_group'] for r, _ in samples if r['split'] == 'train'} & {r['art_group'] for r, _ in samples if r['split'] == 'val'})
    x = np.stack([c for _, c in samples]); y = np.array([classes.index(r['code']) for r, _ in samples]); val = np.array([r['split'] == 'val' for r, _ in samples])
    np.savez_compressed(out/'crops.npz', x=x, y=y, val=val)
    (out/'manifest.jsonl').write_text(''.join(json.dumps(r)+'\n' for r, _ in samples))
    metadata = {'classes': classes, 'sets': {r['code']: {'name': r['set'], 'official_id': r['official_id']} for r, _ in samples}, 'input_size': SIZE, 'holdout_artwork': sorted(HOLDOUT_ART), 'counts': {c: {s: int(sum(r['code'] == c and r['split'] == s for r, _ in samples)) for s in ('train', 'val')} for c in classes}, 'missing_images': missing}
    (out/'classes.json').write_text(json.dumps(metadata, indent=2))
    print(json.dumps({'classes': len(classes), 'samples': len(samples), 'train': int((~val).sum()), 'val': int(val.sum()), 'missing_images': missing}), flush=True)


def network(n):
    import torch.nn as nn
    layers = []; channels = 3
    for width in (32, 64, 96, 128):
        layers += [nn.Conv2d(channels, width, 3, padding=1), nn.BatchNorm2d(width), nn.ReLU(), nn.MaxPool2d(2)]
        channels = width
    return nn.Sequential(*layers, nn.Flatten(), nn.Dropout(.15), nn.Linear(128*3*4, n))


def train(args):
    import torch
    import torch.nn.functional as F
    started = time.monotonic()
    torch.set_num_threads(8); torch.manual_seed(42); random.seed(42)
    if not torch.cuda.is_available() or not torch.version.hip:
        raise RuntimeError('Training requires the physical ROCm GPU; CPU fallback is disabled')
    props = torch.cuda.get_device_properties(0)
    if 'gfx1100' not in props.gcnArchName:
        raise RuntimeError(f'Expected 7900 XTX gfx1100, found {props.gcnArchName}')
    out = Path(args.output); meta = json.loads((out/'classes.json').read_text()); data = np.load(out/'crops.npz')
    x = torch.tensor(data['x'].transpose(0, 1, 4, 2, 3).copy(), device='cuda', dtype=torch.float32)/255
    y = torch.tensor(data['y'], device='cuda', dtype=torch.long); valid = torch.tensor(data['val'], device='cuda')
    train_ids = torch.where(~valid)[0]; val_ids = torch.where(valid)[0]
    model = network(len(meta['classes'])).cuda(); opt = torch.optim.AdamW(model.parameters(), lr=.002, weight_decay=.01)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(opt, args.epochs)
    best = 0.; history = []
    def evaluate(ids, mode):
        model.eval(); preds = []; confs = []
        with torch.no_grad():
            for chunk in ids.split(256):
                probs = model(x[chunk, mode]).softmax(1); conf, pred = probs.max(1)
                preds.append(pred); confs.append(conf)
        return torch.cat(preds), torch.cat(confs)
    for epoch in range(args.epochs):
        model.train(); losses = []; order = train_ids[torch.randperm(len(train_ids), device='cuda')]
        for ids in order.split(256):
            modes = torch.randint(2, (len(ids),), device='cuda'); batch = x[ids, modes]
            theta = torch.zeros(len(ids), 2, 3, device='cuda'); angle = (torch.rand(len(ids), device='cuda')-.5)*.10
            scale = .94 + torch.rand(len(ids), device='cuda')*.12
            theta[:,0,0] = angle.cos()*scale; theta[:,1,1] = angle.cos()*scale
            theta[:,0,1] = -angle.sin(); theta[:,1,0] = angle.sin()
            theta[:,:,2] = (torch.rand(len(ids),2,device='cuda')-.5)*.08
            batch = F.grid_sample(batch, F.affine_grid(theta, batch.shape, align_corners=False), padding_mode='border', align_corners=False)
            contrast = .65 + torch.rand(len(ids),1,1,1,device='cuda')*.6
            brightness = (torch.rand(len(ids),1,1,1,device='cuda')-.5)*.2
            batch = ((batch-.5)*contrast+.5+brightness+torch.randn_like(batch)*.02).clamp(0,1)
            opt.zero_grad(set_to_none=True); loss = F.cross_entropy(model(batch), y[ids], label_smoothing=.03); loss.backward(); opt.step(); losses.append(loss.item())
        scheduler.step()
        clean, _ = evaluate(val_ids,0); camera, _ = evaluate(val_ids,1)
        clean_acc = (clean==y[val_ids]).float().mean().item(); camera_acc = (camera==y[val_ids]).float().mean().item()
        score = (clean_acc+camera_acc)/2
        record = {'epoch': epoch+1, 'loss': sum(losses)/len(losses), 'clean_accuracy': clean_acc, 'camera640_accuracy': camera_acc}; history.append(record); print(json.dumps(record),flush=True)
        if score > best:
            best = score; torch.save(model.state_dict(), out/'best.pt')
    model.load_state_dict(torch.load(out/'best.pt', weights_only=True)); model.eval()
    clean, _ = evaluate(val_ids,0); camera, conf = evaluate(val_ids,1)
    report = {'gpu': props.name, 'architecture': props.gcnArchName, 'torch': torch.__version__, 'hip': torch.version.hip, 'classes': len(meta['classes']), 'train_cards': len(train_ids), 'validation_cards': len(val_ids), 'clean_accuracy': (clean==y[val_ids]).float().mean().item(), 'camera640_accuracy': (camera==y[val_ids]).float().mean().item(), 'history': history, 'per_class': {}, 'confusions': [], 'crispin_holdout': []}
    for i, code in enumerate(meta['classes']):
        mask = y[val_ids]==i
        report['per_class'][code] = {'cards': int(mask.sum()), 'clean': float((clean[mask]==i).float().mean()), 'camera640': float((camera[mask]==i).float().mean())}
    counter = Counter((meta['classes'][int(a)], meta['classes'][int(b)]) for a,b in zip(y[val_ids].cpu(),camera.cpu()) if a!=b)
    report['confusions'] = [{'actual': a, 'predicted': b, 'count': n} for (a,b),n in counter.most_common(30)]
    manifest = [json.loads(l) for l in (out/'manifest.jsonl').read_text().splitlines()]
    for j, sample_id in enumerate(val_ids.cpu().tolist()):
        r = manifest[sample_id]
        if r['art_group'] in HOLDOUT_ART:
            report['crispin_holdout'].append({'ct_id': r['ct_id'], 'actual': r['code'], 'predicted': meta['classes'][int(camera[j])], 'confidence': float(conf[j])})
    for threshold in (.8,.9,.95):
        accepted = conf>=threshold
        report[f'confidence_{threshold}'] = {'coverage': float(accepted.float().mean()), 'accuracy': float((camera[accepted]==y[val_ids][accepted]).float().mean()) if accepted.any() else None}
    torch.jit.trace(model.cpu(), torch.zeros(1,3,48,64)).save(str(out/'expansion-symbols.ts'))
    torch.onnx.export(model, torch.zeros(1,3,48,64), str(out/'expansion-symbols.onnx'), input_names=['symbol'], output_names=['logits'], dynamic_axes={'symbol': {0: 'batch'}, 'logits': {0: 'batch'}}, opset_version=17, dynamo=False)
    report['training_seconds'] = time.monotonic()-started
    report['model_sha256'] = hashlib.sha256((out/'expansion-symbols.ts').read_bytes()).hexdigest()
    (out/'metrics.json').write_text(json.dumps(report,indent=2)); print(json.dumps({k:v for k,v in report.items() if k not in ('history','per_class')}),flush=True)


def predict(args):
    import torch
    out = Path(args.output); meta = json.loads((out/'classes.json').read_text()); model = torch.jit.load(str(out/'expansion-symbols.ts')); model.eval()
    # Layout is a separate visual family, not an expansion prediction. Try each
    # family when unknown; callers must require a clear calibrated margin.
    families = [args.layout] if args.layout else ['sv','swsh','xy']
    im = Image.open(args.image).convert('RGB'); results = []
    with torch.no_grad():
        for family in families:
            crop = np.asarray(crop_symbol(im,family)).copy()
            probs = model(torch.tensor(crop.transpose(2,0,1)[None],dtype=torch.float32)/255).softmax(1)[0]
            scores, ids = probs.topk(3)
            results.append({'layout':family,'candidates':[{'code':meta['classes'][int(i)],'confidence':float(s),'set':meta['sets'][meta['classes'][int(i)]]['name']} for s,i in zip(scores,ids)]})
    print(json.dumps(results,indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument('action',choices=['prepare','train','predict']); parser.add_argument('--output',required=True); parser.add_argument('--catalog'); parser.add_argument('--images',nargs='+'); parser.add_argument('--epochs',type=int,default=35); parser.add_argument('--image'); parser.add_argument('--layout',choices=['sv','swsh','xy'])
    args = parser.parse_args(); {'prepare':prepare,'train':train,'predict':predict}[args.action](args)
