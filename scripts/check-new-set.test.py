import contextlib
import importlib.util
import io
import re
import unittest
import urllib.error
from unittest.mock import patch
from pathlib import Path

spec = importlib.util.spec_from_file_location('check_new_set', Path(__file__).with_name('check-new-set.py'))
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)

ROOT = Path(__file__).resolve().parents[1]


def single(card_id, name, image):
    return {'id': str(card_id), 'card_id': str(card_id), 'name': name, 'itemKind': 'single', 'productType': 'card',
            'imageUrl': image, 'homepageImageUrl': image.replace('.jpg', '_homepage.webp')}


def pokemon_fake(overrides=None, rail_set='Delta Reign'):
    overrides = overrides or {}

    def fake(url, json_body=True):
        for needle, value in overrides.items():
            if needle in url:
                if isinstance(value, Exception):
                    raise value
                return value
        if not json_body:
            return True
        if 'expansion-page' in url:
            return {'expansion': {'name': 'Delta Reign', 'cardCount': 1, 'symbolImageUrl': 'https://cdn.example/s.png'},
                    'cards': [single(2, 'Pikachu', '/card-images/1_pikachu.jpg')]}
        if 'version-set' in url:
            return {'version': 'v1'}
        if 'q=Pikachu' in url:
            return {'groups': [{'printings': [{'id': '2'}]}]}
        if 'suggest' in url:
            return {'groups': [{'printings': [{'id': '2'}]}]}
        return {'cards': [{'set': rail_set}]}
    return fake


def satellite_fake(game='one_piece', overrides=None):
    overrides = overrides or {}
    prefix = check.GAMES[game][0]

    def fake(url, json_body=True):
        for needle, value in overrides.items():
            if needle in url:
                if isinstance(value, Exception):
                    raise value
                return value
        assert f'game={game}' in url or not json_body, url
        if not json_body:
            return True
        if 'expansion-page' in url and 'slug=' not in url:
            return {'expansions': [{'name': 'EB-05', 'slug': 'eb-05'}, {'name': 'Other', 'slug': 'other'}]}
        if 'expansion-page' in url:
            return {'expansion': {'name': 'EB-05', 'cardCount': 2},
                    'cards': [{'id': '9', 'name': 'Box', 'itemKind': 'sealed', 'productType': 'box'},
                              single(10, 'Nojiko', f'/card-images/{prefix}/5_nojiko.jpg')]}
        if 'version-set' in url:
            return {'version': 'name:nojiko', 'printings': [{'card_id': '10'}]}
        return {'groups': [{'printings': [{'id': '10'}]}]}
    return fake


def run_check(fake, name, game, webp=(480, 672)):
    out = io.StringIO()
    with patch.object(check, 'request', side_effect=fake), patch.object(check, 'webp_size', return_value=webp), contextlib.redirect_stdout(out):
        code = check.run(name, game)
    return code, out.getvalue()


class CheckNewSetTests(unittest.TestCase):
    def test_slug_and_suggest_ids(self):
        self.assertEqual(check.slugify('Pokémon & Friends'), 'pokemon-and-friends')
        self.assertEqual(check.suggest_ids({'groups': [{'printings': [{'id': 4}, {'card_id': '5'}]}]}), {'4', '5'})

    def test_game_table_matches_the_spa_registry(self):
        source = (ROOT / 'market/src/game.js').read_text()
        spa = dict(re.findall(r"id: '([a-z_]+)', apiGame: '[a-z_]+', slug: '([a-z-]*)'", source))
        spa['pokemon'] = ''
        self.assertEqual({k: v[0] for k, v in check.GAMES.items()}, spa)

    def test_game_names_normalize(self):
        self.assertEqual(check.normalize_game(None), 'pokemon')
        self.assertEqual(check.normalize_game('one-piece'), 'one_piece')
        self.assertEqual(check.normalize_game('Flesh_And_Blood'), 'flesh_and_blood')
        self.assertIsNone(check.normalize_game('hearthstone'))

    def test_unknown_game_exits_nonzero_without_requests(self):
        with patch.object(check, 'request', side_effect=AssertionError('no network')), contextlib.redirect_stderr(io.StringIO()) as err:
            self.assertEqual(check.main(['--game', 'hearthstone', 'Set']), 2)
            self.assertEqual(check.run('Set', 'hearthstone'), 2)
        self.assertIn('unknown game', err.getvalue())

    def test_missing_set_suggest_and_old_rail_fail(self):
        fake = pokemon_fake({'q=Delta': {'groups': []}}, rail_set='Storm Emeralda')
        code, text = run_check(fake, 'Delta Reign', 'pokemon')
        self.assertEqual(code, 1)
        self.assertIn('MISSING: set-name suggest', text)
        self.assertIn('MISSING: new-cards rail', text)

    def test_pokemon_runs_every_step_and_can_be_ready(self):
        code, text = run_check(pokemon_fake(), 'Delta Reign', 'pokemon')
        self.assertNotIn('SKIPPED', text)
        self.assertNotIn('MISSING', text)
        self.assertEqual(code, 0, text)
        for label in ('catalog', 'singles', 'thumbnail', 'version set', 'search index', 'local suggest set catalog',
                      'symbol HTTP', 'featured set override', 'new-cards rail'):
            self.assertIn(f'OK: {label}', text)

    def test_pokemon_thumbnail_must_be_480_wide(self):
        code, text = run_check(pokemon_fake(), 'Delta Reign', 'pokemon', webp=(240, 336))
        self.assertEqual(code, 1)
        self.assertIn('MISSING: thumbnail', text)

    def test_satellite_routes_by_game_and_skips_pokemon_only_steps(self):
        code, text = run_check(satellite_fake(), 'EB-05', 'one_piece')
        self.assertEqual(code, 0, text)
        self.assertIn('OK: singles: 1 singles of 2 sampled', text)
        self.assertIn('OK: image key matches card id: /card-images/one-piece/5_nojiko.jpg', text)
        self.assertIn('OK: version set (name groups)', text)
        for label in ('local suggest set catalog', 'featured set override', 'new-cards rail'):
            self.assertIn(f'SKIPPED: {label}:', text)
        self.assertNotIn('MISSING', text)

    def test_satellite_symbol_404_is_skipped_but_other_errors_are_missing(self):
        gone = urllib.error.HTTPError('u', 404, 'Not Found', {}, None)
        code, text = run_check(satellite_fake(overrides={'/expansions/symbols/': gone}), 'EB-05', 'one_piece')
        self.assertEqual(code, 0, text)
        self.assertIn('SKIPPED: symbol:', text)
        broken = urllib.error.HTTPError('u', 502, 'Bad Gateway', {}, None)
        code, text = run_check(satellite_fake(overrides={'/expansions/symbols/': broken}), 'EB-05', 'one_piece')
        self.assertEqual(code, 1)
        self.assertIn('MISSING: symbol HTTP', text)

    def test_cardmarket_game_uses_its_prefix_and_id(self):
        code, text = run_check(satellite_fake('battle_spirits_saga'), 'EB-05', 'battle_spirits_saga')
        self.assertEqual(code, 0, text)
        self.assertIn('/card-images/battle-spirits-saga/5_nojiko.jpg', text)

    def test_wrong_image_prefix_is_missing(self):
        fake = satellite_fake('magic', {'slug=': {'expansion': {'name': 'EB-05', 'cardCount': 1},
                                                  'cards': [single(10, 'Nojiko', '/card-images/one-piece/5_nojiko.jpg')]}})
        code, text = run_check(fake, 'EB-05', 'magic')
        self.assertEqual(code, 1)
        self.assertIn('MISSING: image key matches card id', text)

    def test_set_not_in_satellite_index_is_missing(self):
        code, text = run_check(satellite_fake(), 'No Such Set', 'one_piece')
        self.assertEqual(code, 1)
        self.assertIn('MISSING: catalog (set index)', text)

    def test_set_with_no_singles_is_missing(self):
        sealed = {'expansion': {'name': 'EB-05', 'cardCount': 1}, 'cards': [{'id': '9', 'itemKind': 'sealed', 'productType': 'box'}]}
        code, text = run_check(satellite_fake(overrides={'slug=': sealed}), 'EB-05', 'one_piece')
        self.assertEqual(code, 1)
        self.assertIn('MISSING: singles: 0 singles of 1', text)

    def test_failed_public_request_is_reported_not_swallowed(self):
        bad = urllib.error.HTTPError('u', 500, 'err', {}, io.BytesIO(b'relation does not exist'))
        code, text = run_check(satellite_fake(overrides={'slug=': bad}), 'EB-05', 'one_piece')
        self.assertEqual(code, 1)
        self.assertIn('MISSING: catalog: HTTP 500 relation does not exist', text)
        code, text = run_check(pokemon_fake({'q=Pikachu': OSError('timed out')}), 'Delta Reign', 'pokemon')
        self.assertEqual(code, 1)
        self.assertIn('MISSING: search index: request failed: timed out', text)

    def test_prize_pack_uses_bundled_symbol(self):
        expansion = {'expansion': {'name': 'Play! Pokémon Prize Pack Series One', 'cardCount': 1}, 'cards': [single(2, 'Pikachu', '/card-images/1_pikachu.jpg')]}
        fake = pokemon_fake({'expansion-page': expansion})
        out = io.StringIO()
        with patch.object(check, 'request', side_effect=fake), patch.object(check, 'webp_size', return_value=(480, 1)), \
                patch.object(check, 'slugify', return_value='play-pokemon-prize-pack-series-one'), contextlib.redirect_stdout(out):
            check.run('Play! Pokémon Prize Pack Series One', 'pokemon')
        self.assertIn('OK: symbol (bundled Prize Pack mark): market/public/expansion-symbols/play-pokemon-prize-pack.png', out.getvalue())

    def test_webp_header_sizes(self):
        def webp(kind, payload):
            return b'RIFF' + b'\0' * 4 + b'WEBP' + kind + b'\0' * 4 + payload

        lossy = webp(b'VP8 ', b'\0' * 3 + b'\x9d\x01\x2a' + (480).to_bytes(2, 'little') + (672).to_bytes(2, 'little'))
        lossless = webp(b'VP8L', b'\x2f' + ((479) | (671 << 14)).to_bytes(4, 'little'))
        extended = webp(b'VP8X', b'\0' * 4 + (479).to_bytes(3, 'little') + (671).to_bytes(3, 'little'))

        class Response:
            def __init__(self, body):
                self.body = body

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self, n):
                return self.body[:n]

        for body, size in ((lossy, (480, 672)), (lossless, (480, 672)), (extended, (480, 672)), (b'GIF89a' + b'\0' * 60, None)):
            with patch.object(check.urllib.request, 'urlopen', return_value=Response(body)):
                self.assertEqual(check.webp_size('https://cdn.example/x.webp'), size)


if __name__ == '__main__':
    unittest.main()
