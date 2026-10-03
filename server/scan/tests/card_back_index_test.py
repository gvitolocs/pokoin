import importlib.util
import sys
import unittest
from pathlib import Path

import numpy as np

WORKERS = [Path(__file__).resolve().parents[1] / 'app.py',
           Path(__file__).resolve().parents[1] / 'worker' / 'app.py']


def load(path):
    sys.path.insert(0, str(path.parent))
    spec = importlib.util.spec_from_file_location(f'scan_app_{path.parent.name}', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def reference(module, scores, cards):
    """The per-search loop the index replaced."""
    best_i, best_score = -1, -1.0
    for i, card in enumerate(cards):
        if module._is_card_back_hit(card) and float(scores[i]) > best_score:
            best_score, best_i = float(scores[i]), i
    return best_score, best_i


def catalog(rng, n=2000, backs=(7, 512, 1999)):
    cards = [{'name': f'Card {i}', 'item_kind': 'single'} for i in range(n)]
    cards[backs[0]] = {'name': 'Pokémon Card Back', 'item_kind': 'single'}
    cards[backs[1]] = {'name': 'back', 'item_kind': 'card_back'}
    cards[backs[2]] = {'name': 'Card back', 'item_kind': 'single'}
    return cards


class CardBackIndexTest(unittest.TestCase):
    def test_matches_reference_loop(self):
        rng = np.random.default_rng(3)
        for path in WORKERS:
            module = load(path)
            cards = catalog(rng)
            for _ in range(200):
                scores = rng.uniform(-1, 1, len(cards)).astype(np.float32)
                self.assertEqual(module._best_card_back_score(scores, cards, 'pokemon_generic'),
                                 reference(module, scores, cards), path)

    def test_no_backs_and_reloaded_catalog(self):
        rng = np.random.default_rng(4)
        for path in WORKERS:
            module = load(path)
            plain = [{'name': f'Card {i}'} for i in range(50)]
            scores = rng.uniform(-1, 1, 50).astype(np.float32)
            self.assertEqual(module._best_card_back_score(scores, plain, 'x'), (-1.0, -1))
            # Same catalog id, new list object (cache eviction + reload): rebuild.
            reloaded = catalog(rng, n=50, backs=(1, 2, 3))
            self.assertEqual(module._best_card_back_score(scores, reloaded, 'x'),
                             reference(module, scores, reloaded), path)


if __name__ == '__main__':
    unittest.main()
