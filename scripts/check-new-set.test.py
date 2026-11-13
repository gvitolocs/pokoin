import contextlib
import importlib.util
import io
import unittest
from unittest.mock import patch
from pathlib import Path

spec = importlib.util.spec_from_file_location('check_new_set', Path(__file__).with_name('check-new-set.py'))
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)


class CheckNewSetTests(unittest.TestCase):
    def test_slug_and_suggest_ids(self):
        self.assertEqual(check.slugify('Pokémon & Friends'), 'pokemon-and-friends')
        self.assertEqual(check.suggest_ids({'groups': [{'printings': [{'id': 4}, {'card_id': '5'}]}]}), {'4', '5'})

    def test_missing_set_suggest_and_old_rail_fail(self):
        def fake(url, json_body=True):
            if not json_body:
                return True
            if 'expansion-page' in url:
                return {'expansion': {'name': 'Delta Reign', 'cardCount': 1, 'symbolImageUrl': 'https://cdn.example/s.png'}, 'cards': [{'id': '1', 'name': 'Pikachu', 'imageUrl': '/card-images/1.jpg'}]}
            if 'version-set' in url:
                return {'version': 'v1'}
            if 'q=Pikachu' in url:
                return {'groups': [{'printings': [{'id': '1'}]}]}
            if 'suggest' in url:
                return {'groups': []}
            return {'cards': [{'set': 'Storm Emeralda'}]}
        with patch.object(check, 'request', side_effect=fake), contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(check.run('Delta Reign'), 1)
        self.assertIn('MISSING/UNVERIFIED: set-name suggest', output.getvalue())
        self.assertIn('MISSING/UNVERIFIED: new-cards rail', output.getvalue())


if __name__ == '__main__':
    unittest.main()
