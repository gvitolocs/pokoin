import importlib.util
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("qwen-artwork-figures.py")
SPEC = importlib.util.spec_from_file_location("qwen_artwork_figures", SCRIPT)
MOD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MOD)


class ArtworkFiguresTest(unittest.TestCase):
    def test_parse_clamps_and_keeps_multiple_figures(self):
        figures = MOD.parse_figures(
            '```json\n{"figures":[{"label":"Pikachu","box":[-2,10,900,1001]},'
            '{"label":"Trainer","box":[700,20,990,800]}]}\n```'
        )
        self.assertEqual(figures[0]["box"], [0, 10, 900, 1000])
        self.assertEqual(MOD.union_box(figures), [0, 10, 990, 1000])

    def test_empty_figures_have_no_union(self):
        self.assertEqual(MOD.parse_figures('{"figures":[]}'), [])
        self.assertIsNone(MOD.union_box([]))

    def test_parser_ignores_trailing_repeated_object(self):
        text = '{"figures":[]}\n{"figures":[{"label":"wrong","box":[1,2,3,4]}]}'
        self.assertEqual(MOD.parse_figures(text), [])

    def test_parser_recovers_complete_boxes_from_truncated_array(self):
        text = (
            '{"figures":[{"label":"Gloom","box":[217,171,750,473]},'
            '{"label":"Gloom","box":[217,171,750,473]},'
            '{"label":"Oddish","box":[75,88'
        )
        self.assertEqual(
            MOD.parse_figures(text),
            [{"label": "Gloom", "box": [217, 171, 750, 473]}],
        )

    def test_parse_requires_figures_list(self):
        with self.assertRaisesRegex(ValueError, "figures list"):
            MOD.parse_figures('{"result":[]}')

    def test_failed_rows_are_not_considered_done(self):
        with tempfile.TemporaryDirectory() as tmp:
            progress = Path(tmp) / "progress.jsonl"
            progress.write_text(
                '{"version":"ok","figures":[]}\n'
                '{"version":"retry","error":"GPU unavailable"}\n'
            )
            self.assertEqual(set(MOD.load_done(progress)), {"ok"})
            self.assertEqual(MOD.load_failure_counts(progress)["retry"], 1)

    def test_only_infrastructure_errors_trip_global_guard(self):
        self.assertTrue(MOD.is_infrastructure_error("RuntimeError: Ollama error: device lost"))
        self.assertTrue(MOD.is_infrastructure_error("TimeoutError: timed out"))
        self.assertFalse(MOD.is_infrastructure_error("JSONDecodeError: truncated card reply"))

    def test_local_path_falls_back_to_ct_id(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            wanted = root / "123_pikachu.jpg"
            wanted.write_bytes(b"jpeg")
            index = MOD.object_index(root)
            row = {"ct_id": 123, "image": "https://cdn.invalid/wrong.jpg"}
            self.assertEqual(MOD.local_path(row, root, index), wanted)


if __name__ == "__main__":
    unittest.main()
