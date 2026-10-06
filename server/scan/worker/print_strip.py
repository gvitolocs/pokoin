"""OCR of the bottom print strip of a rectified card: collector number + language."""
import os
import re
import time

import numpy as np

V5_DEFAULT = '/home/nez/.cache/ppocrv5-onnx'

KNOWN_PREFIXES = {'TG', 'GG', 'SV', 'RC', 'H', 'SH', 'XY', 'SM', 'BW', 'DP', 'SWSH', 'SVP'}

_LANG_WORDS = {
    'en': {'weakness', 'resistance', 'retreat', 'lv', 'hp'},
    'fr': {'faiblesse', 'retraite', 'niv', 'niveau', 'évolution'},
    'it': {'debolezza', 'resistenza', 'ritirata', 'evoluzione'},
    'de': {'schwäche', 'resistenz', 'rückzug', 'rückzugskosten', 'entwicklung', 'kp'},
    'es': {'debilidad', 'resistencia', 'retirada', 'ps'},
    'pt': {'fraqueza', 'resistência', 'recuo'},
    'nl': {'zwakte'},
}
_STRIP_LANG_TOKENS = {'EN', 'IT', 'FR', 'DE', 'ES', 'PT', 'NL'}
_MAGIC_LANG_TOKENS = {
    'EN': 'en', 'IT': 'it', 'FR': 'fr', 'DE': 'de', 'ES': 'es', 'PT': 'pt',
    'JP': 'ja', 'JA': 'ja', 'KO': 'ko', 'RU': 'ru', 'CS': 'zh-Hans', 'CT': 'zh-Hant',
    'PH': 'ph',
}
_MAGIC_RARITIES = 'CURMLST'
_MAGIC_SET_RE = re.compile(
    r'\b([A-Z0-9]{3,4})(?:\s*[•·.\-*]\s*|\s{1,3})(EN|IT|FR|DE|ES|PT|JP|JA|KO|RU|CS|CT|PH)\b')
_MAGIC_COLLECTOR_RE = re.compile(
    r'(?<![A-Z0-9])([' + _MAGIC_RARITIES + r'])\s*0*(\d{1,4})\b')


def _norm_side(side):
    side = side.upper()
    m = re.match(r'^([A-Z]{0,4})(\d{1,3})$', side)
    if not m:
        return None
    prefix, digits = m.group(1), m.group(2)
    if prefix and prefix not in KNOWN_PREFIXES:
        prefix = ''
    return prefix + (digits.lstrip('0') or '0'), int(digits)


def parse_collector(lines):
    best = None
    for text, conf in lines:
        fixed = re.sub(r'[Oo](?=[A-Za-z]*\d)', '0', text)
        fixed = re.sub(r'[Il](?=[A-Za-z]*\d)', '1', fixed)
        for m in re.finditer(
                r'([A-Za-z]{0,4}\d{1,3})\s*/\s*([A-Za-z]{0,4}\d{1,3})(?!\d)',
                fixed):
            left = _norm_side(m.group(1))
            right = _norm_side(m.group(2))
            if left is None or right is None:
                continue
            left, left_int = left
            right, right_int = right
            if right_int < 1:
                continue
            if left_int > right_int + 120:
                continue
            if best is None or conf > best[0]:
                best = (conf, left, right, m.group(0).strip())
    if best is None:
        return None
    return {'num': best[1], 'den': best[2], 'raw': best[3], 'conf': round(float(best[0]), 4)}


def detect_language(texts):
    text = ' '.join(t for t, _ in texts).lower()
    words = re.findall(r'[a-zà-öø-ÿ0-9]+', text)
    scores = {code: 0.0 for code in _LANG_WORDS}
    evidence = {code: [] for code in _LANG_WORDS}
    for word in set(words):
        for code, wordlist in _LANG_WORDS.items():
            if word in wordlist:
                scores[code] += 1
                evidence[code].append(word)
    if 'pv' in words:
        scores['fr'] += 0.5
        scores['it'] += 0.5
        evidence['fr'].append('pv')
        evidence['it'].append('pv')
    set_code = None
    for m in re.finditer(r'\b([A-Z0-9]{3})\s+([A-Z]{2})\s+\d{1,4}\s*/\s*\d{1,4}\b',
                         ' '.join(t for t, _ in texts)):
        set_code = m.group(1)
        code = _MAGIC_LANG_TOKENS.get(m.group(2))
        if code in scores:
            scores[code] += 3
            evidence[code].append(m.group(2))
    if re.search(r'[\u3040-\u30ff]', text):
        scores.setdefault('ja', 0.0)
        scores['ja'] = scores.get('ja', 0.0) + 3
        evidence.setdefault('ja', [])
        evidence['ja'].append('kana')
    if re.search(r'[\uac00-\ud7a3]', text):
        scores.setdefault('ko', 0.0)
        scores['ko'] = scores.get('ko', 0.0) + 3
        evidence.setdefault('ko', [])
        evidence['ko'].append('hangul')
    ranked = sorted(
        ((code, score) for code, score in scores.items() if code in _LANG_WORDS or code in ('ja', 'ko')),
        key=lambda item: -item[1])
    if not ranked or ranked[0][1] < 1:
        return None, set_code
    best_code, best_score = ranked[0]
    runner = ranked[1][1] if len(ranked) > 1 else 0.0
    if best_score - runner < 1:
        return None, set_code
    return (
        {'code': best_code, 'score': best_score, 'evidence': evidence[best_code][:6]},
        set_code,
    )


def parse_magic_line(lines):
    collector = None
    set_code = None
    language = None
    for text, conf in lines:
        if collector is None:
            m = _MAGIC_COLLECTOR_RE.search(text)
            if m:
                collector = {'num': m.group(2), 'raw': m.group(0).strip()}
        if set_code is None:
            m = _MAGIC_SET_RE.search(text)
            if m:
                set_code = m.group(1)
                code = _MAGIC_LANG_TOKENS.get(m.group(2))
                if code and code in _LANG_WORDS:
                    language = {'code': code, 'score': 3, 'evidence': [m.group(2)]}
    if collector is None and set_code is None and language is None:
        return None
    return {'collector': collector, 'set_code': set_code, 'language': language}


class PrintStrip:
    def __init__(self, root=V5_DEFAULT, providers=None):
        from rapidocr_onnxruntime import RapidOCR
        self._ocr = RapidOCR(
            use_cls=False,
            min_side_len=8,
            det_model_path=os.path.join(root, 'det', 'inference.onnx'),
            rec_model_path=os.path.join(root, 'en-rec', 'inference.onnx'),
            rec_keys_path=os.path.join(root, 'en-rec', 'keys.txt'),
            rec_img_shape=[3, 48, 320],
            det_limit_side_len=960,
            det_limit_type='max',
            det_mean=[0.485, 0.456, 0.406],
            det_std=[0.229, 0.224, 0.225],
            det_thresh=0.3,
            det_box_thresh=0.5,
            det_unclip_ratio=1.6,
        )

    def _ocr_lines(self, bgr):
        lines = []
        result, _ = self._ocr(bgr)
        for item in result or []:
            text = (item[1] or '').strip()
            if text:
                lines.append((text, float(item[2])))
        return lines

    def read(self, card_rgb, game='pokemon'):
        t0 = time.perf_counter()
        h = card_rgb.shape[0]
        # Modern Magic prints a two-line collector block; start higher for other games.
        start = 0.84 if game == 'pokemon' else 0.78
        bottom = card_rgb[int(round(start * h)):, :, ::-1]
        lines = self._ocr_lines(bottom)
        upside_down = False
        result = None
        if game != 'pokemon':
            result = parse_magic_line(lines)
        if game == 'pokemon':
            collector = parse_collector(lines)
            if collector is None:
                top = np.rot90(card_rgb[:int(round(0.16 * h)), :, ::-1], 2)
                top_lines = self._ocr_lines(top)
                collector = parse_collector(top_lines)
                if collector is not None:
                    upside_down = True
            language, set_code = detect_language(lines)
            result = {
                'collector': collector,
                'language': language,
                'set_code': set_code,
                'lines': [t for t, _ in lines[:12]],
                'upside_down': upside_down,
                'ms': 0.0,
            }
        else:
            if result is None:
                collector = parse_collector(lines)
                if collector is None:
                    top = np.rot90(card_rgb[:int(round(0.16 * h)), :, ::-1], 2)
                    top_lines = self._ocr_lines(top)
                    collector = parse_collector(top_lines)
                    if collector is not None:
                        upside_down = True
                language, set_code = detect_language(lines)
                result = {
                    'collector': collector,
                    'language': language,
                    'set_code': set_code,
                    'lines': [t for t, _ in lines[:12]],
                    'upside_down': upside_down,
                    'ms': 0.0,
                }
        result['ms'] = round((time.perf_counter() - t0) * 1000, 1)
        return result
