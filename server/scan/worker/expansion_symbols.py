"""Expansion hints only inside a confident, multi-expansion artwork group."""
import json
from collections import defaultdict
from pathlib import Path

import numpy as np
from PIL import Image


def family(official_id):
    if official_id.startswith('sv'):
        return 'sv'
    if official_id.startswith(('sm', 'swsh')):
        return 'swsh'
    if official_id.startswith(('bw', 'xy')):
        return 'xy'
    return None


BOXES = {'sv': (.088, .932, .171, .978),
         'swsh': (.054, .928, .112, .980),
         'xy': (.898, .921, .956, .978)}


class ExpansionSymbols:
    def __init__(self, root, providers):
        import onnxruntime as ort
        root = Path(root)
        self.meta = json.loads((root/'classes.json').read_text())
        self.labels = self.meta['classes']
        self.mapping = json.loads((root/'artwork-printings.json').read_text())
        self.session = ort.InferenceSession(str(root/'expansion-symbols.onnx'), providers=providers)
        self.providers = self.session.get_providers()
        if not any('ROCM' in p for p in self.providers):
            raise RuntimeError('Expansion symbols require the nezopt ROCm GPU')
        self.index = {}
        self.session.run(None, {'symbol': np.zeros((1,3,48,64), np.float32)})

    def members(self, catalog, cards):
        if catalog not in self.index:
            groups = defaultdict(list)
            for card in cards:
                m = self.mapping.get(str(card.get('public_id') or card.get('id')))
                if m and m.get('group'):
                    groups[m['group']].append((card, m))
            self.index[catalog] = groups
        return self.index[catalog]

    def resolve(self, oriented, hits, catalog, cards):
        detail = {'state': 'skipped', 'reason': 'not_pokemon'}
        if not catalog.startswith('pokemon_') or not hits:
            return hits, detail
        top = hits[0]
        if float(top.get('score') or 0) < .80 or top.get('item_kind') == 'card_back':
            return hits, detail | {'reason': 'weak_artwork'}
        m = self.mapping.get(str(top.get('public_id') or top.get('id')))
        if not m or not m.get('group'):
            return hits, detail | {'reason': 'unknown_artwork'}
        members = self.members(catalog, cards).get(m['group'], [])
        sets = {v['set'] for _, v in members}
        # Foil/subset marks map to their parent expansion in the export.
        if len(sets) <= 1:
            return hits, detail | {'reason': 'single_expansion', 'artwork': m['group']}
        for rival in hits[1:]:
            other = self.mapping.get(str(rival.get('public_id') or rival.get('id')), {})
            if other.get('group') != m['group'] and float(top['score'])-float(rival.get('score') or 0) < .08:
                return hits, detail | {'reason': 'ambiguous_artwork'}
        codes = {v.get('code') for _, v in members} & set(self.labels)
        if len(codes) < 2:
            return hits, detail | {'reason': 'unsupported_expansions'}
        layouts = {family(self.meta['sets'][c]['official_id']) for c in codes}
        h,w = oriented.shape[:2]
        if h < 200 or w < 120:
            return hits, detail | {'reason': 'symbol_too_small'}
        # The selected Milo orientation is reused, so rotated cards do not
        # accidentally feed their top edge to the symbol classifier.
        im = Image.fromarray(oriented)
        trials = []
        for layout in sorted(layouts):
            a,b,c,d = BOXES[layout]
            crop = im.crop((round(w*a),round(h*b),round(w*c),round(h*d))).resize((64,48), Image.Resampling.BICUBIC)
            arr = np.asarray(crop, dtype=np.float32).transpose(2,0,1)[None]/255
            logits = self.session.run(None, {'symbol': arr})[0][0]
            p = np.exp(logits-logits.max()); p /= p.sum()
            order = np.argsort(p)[::-1]
            code = self.labels[int(order[0])]
            trials.append({'layout': layout, 'code': code, 'confidence': round(float(p[order[0]]),5), 'margin': round(float(p[order[0]]-p[order[1]]),5)})
        eligible = [t for t in trials if t['code'] in codes and t['confidence'] >= .95 and t['margin'] >= .20]
        detail = {'state': 'rejected', 'reason': 'uncertain_symbol', 'artwork': m['group'], 'trials': trials}
        if not eligible or len({t['code'] for t in eligible}) != 1:
            return hits, detail
        winner = max(eligible, key=lambda t: t['confidence'])
        target = [card for card,v in members if v.get('code') == winner['code']]
        raw = {str(hit.get('public_id') or hit.get('id')): hit for hit in hits}
        # Prefer a printing already present in the artwork search; a symbol
        # never decides foil/language and never removes version choices.
        target.sort(key=lambda card: float(raw.get(str(card.get('public_id') or card.get('id')),{}).get('score') or -1),reverse=True)
        selected = dict(target[0]); public_id = str(selected.get('public_id') or selected.get('id'))
        selected['score'] = float(top['score'])
        selected['_expansion_symbol'] = winner
        # The selected row is rebuilt from the raw catalog card and would lose
        # the _search artwork stamp; every member here shares the group.
        ordered = [selected] + [dict(hit) for hit in hits if str(hit.get('public_id') or hit.get('id')) != public_id]
        for hit in ordered:
            hit.setdefault('artwork', str(m['group']))
        return ordered[:max(1,len(hits))], detail | {'state': 'matched', 'reason': 'same_artwork_expansion', 'selected_public_id': public_id, **winner}
