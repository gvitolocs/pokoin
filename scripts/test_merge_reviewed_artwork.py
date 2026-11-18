import importlib.util
import json
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('merges', Path(__file__).with_name('merge-reviewed-artwork.py'))
merges = importlib.util.module_from_spec(spec)
spec.loader.exec_module(merges)

class ReviewTests(unittest.TestCase):
    def test_reviewed_families_preserve_legend_halves(self):
        review = json.loads((Path(__file__).parents[1] / 'docs/artwork-reviews/20261012.json').read_text())
        aliases = merges.components(review)
        self.assertEqual(aliases['v824982'], 'v260108')
        self.assertEqual(aliases['v824984'], 'v260110')
        self.assertNotEqual(aliases['v824982'], aliases['v824984'])
        self.assertNotIn('v635300', aliases)
        self.assertEqual(len(aliases), 250)
        self.assertEqual(len(set(aliases.values())), 113)
    def test_unapproved_edges_do_not_join_transitive_families(self):
        edges = [{'a':'v8','b':'v4','decision':'approve'}, {'a':'v4','b':'v2','decision':'approve'},
                 {'a':'v2','b':'v1','decision':'reject'}]
        self.assertEqual(merges.components({'pairs':edges}), {'v2':'v2','v4':'v2','v8':'v2'})
        with self.assertRaisesRegex(ValueError, 'identity'):
            merges.components({'pairs':[{'a':"v1'","b":'v2','decision':'approve'}]})

if __name__ == '__main__':
    unittest.main()
