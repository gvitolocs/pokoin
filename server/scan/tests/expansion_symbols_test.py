import sys
import unittest
from pathlib import Path
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'worker'))
from expansion_symbols import ExpansionSymbols


class FakeSession:
    def __init__(self, logits):
        self.logits = np.array([logits], dtype=np.float32); self.calls = 0
    def run(self, *_):
        self.calls += 1; return [self.logits]


class SymbolRulesTest(unittest.TestCase):
    def setUp(self):
        self.model = ExpansionSymbols.__new__(ExpansionSymbols)
        self.model.labels = ['scr','pre','pal']
        self.model.meta = {'sets': {c:{'official_id':'sv7'} for c in self.model.labels}}
        self.model.mapping = {'1': {'group':'art','set':'Stellar Crown','code':'scr'},
                              '2': {'group':'art','set':'Prismatic Evolutions','code':'pre'},
                              '3': {'group':'different','set':'Paldea Evolved','code':'pal'}}
        self.model.index = {}; self.model.session = FakeSession([0,9,0])
        self.cards = [{'public_id':str(n),'name':'Crispin'} for n in (1,2,3)]
        self.hits = [dict(self.cards[0],score=.92),dict(self.cards[1],score=.70)]
        self.crop = np.zeros((640,458,3),np.uint8)

    def test_single_expansion_never_runs_model_even_with_multiple_foil_versions(self):
        self.model.mapping['2']['set']='Stellar Crown';self.model.mapping['2']['code']='scr'
        hits, detail = self.model.resolve(self.crop,self.hits,'pokemon_generic',self.cards)
        self.assertEqual(detail['reason'],'single_expansion');self.assertEqual(self.model.session.calls,0)
        self.assertEqual(hits,self.hits)

    def test_symbol_promotes_only_an_artwork_sibling_and_preserves_other_hits(self):
        hits, detail = self.model.resolve(self.crop,self.hits,'pokemon_generic',self.cards)
        self.assertEqual(detail['state'],'matched');self.assertEqual(hits[0]['public_id'],'2')
        self.assertEqual(hits[0]['score'],.92);self.assertEqual({h['public_id'] for h in hits},{'1','2'})
        # The rebuilt selected row still carries the artwork group for the phone gate.
        self.assertEqual({h.get('artwork') for h in hits},{'art'})

    def test_unknown_symbol_never_selects_a_different_artwork(self):
        self.model.session = FakeSession([0,0,9])
        hits, detail = self.model.resolve(self.crop,self.hits,'pokemon_generic',self.cards)
        self.assertEqual(detail['state'],'rejected');self.assertEqual(hits,self.hits)

    def test_unclear_symbol_preserves_recognition(self):
        self.model.session = FakeSession([0,0,0])
        hits, detail = self.model.resolve(self.crop,self.hits,'pokemon_generic',self.cards)
        self.assertEqual(detail['state'],'rejected');self.assertEqual(hits,self.hits)

    def test_ambiguous_artwork_and_non_pokemon_never_run_symbols(self):
        for catalog,hits in [('one_piece_generic',self.hits),('pokemon_generic',self.hits+[dict(self.cards[2],score=.89)])]:
            self.model.resolve(self.crop,hits,catalog,self.cards)
        self.assertEqual(self.model.session.calls,0)


if __name__=='__main__':unittest.main()
