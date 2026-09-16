#!/usr/bin/env python3
import io
import unittest
from contextlib import redirect_stderr
from datetime import datetime, timezone
from importlib.machinery import SourceFileLoader
from pathlib import Path

rails = SourceFileLoader(
    "sync_marketplace_rails",
    str(Path(__file__).with_name("sync-marketplace-rails.py")),
).load_module()


def card(card_id, name, number, set_name="Storm Emeralda"):
    return {
        "id": str(card_id),
        "card_id": str(card_id),
        "name": name,
        "number": number,
        "card_number": number,
        "set": set_name,
        "set_name": set_name,
    }


class CuratedNewCardsTests(unittest.TestCase):
    def test_curated_list_is_twenty_and_keeps_duplicate_names(self):
        names = [spec["name"] for spec in rails.NEW_CARDS_CURATED]
        self.assertEqual(len(rails.NEW_CARDS_CURATED), 20)
        self.assertEqual(len(rails.NEW_CARDS_CURATED), rails.NEW_CARDS_LIMIT)
        self.assertGreater(names.count("Mega Rayquaza ex"), 1)
        self.assertGreater(names.count("Raikou ex"), 1)
        self.assertGreater(names.count("Zinnia's Trust"), 1)
        self.assertGreater(names.count("Aarune"), 1)

    def test_order_survives_database_sort_and_keeps_name_variants(self):
        pool = [
            card(20, "Azurill", "Illustration Rare | 086/076"),
            card(1, "Mega Rayquaza ex", "Gold Secret Rare | 113/076"),
            card(4, "Mega Rayquaza ex", "Full-Art | 095/076"),
            card(2, "Mega Rayquaza ex", "Special Illustration Rare | 110/076"),
            card(3, "Raikou ex", "Special Illustration Rare | 108/076"),
            card(99, "Combee", "006/076"),
            card(5, "Zinnia's Trust", "Special Illustration Rare | 112/076"),
        ]
        matched, missing = rails.pick_curated_cards(
            pool,
            rails.NEW_CARDS_CURATED[:5],
            set_aliases=rails.NEW_CARDS_SET_ALIASES,
            set_needles=rails.NEW_CARDS_SET_NEEDLES,
        )
        self.assertEqual(
            [item["id"] for item in matched],
            ["1", "2", "3", "4", "5"],
        )
        self.assertEqual([item["name"] for item in matched[:4]], [
            "Mega Rayquaza ex",
            "Mega Rayquaza ex",
            "Raikou ex",
            "Mega Rayquaza ex",
        ])
        self.assertFalse(any(item["name"] == "Combee" for item in matched))
        self.assertEqual(missing, [])

    def test_set_aliases_and_padded_collector_numbers(self):
        pool = [
            card(8, "Growlithe", "78/76", "M6"),
            card(1, "Mega Rayquaza ex", "113 / 076", "Japanese Storm Emeralda"),
        ]
        matched, missing = rails.pick_curated_cards(
            pool,
            (
                {"name": "Mega Rayquaza ex", "number": "113/076"},
                {"name": "Growlithe", "number": "078/076"},
            ),
            set_aliases=rails.NEW_CARDS_SET_ALIASES,
            set_needles=rails.NEW_CARDS_SET_NEEDLES,
        )
        self.assertEqual([item["id"] for item in matched], ["1", "8"])
        self.assertEqual(missing, [])

    def test_missing_spec_is_reported_and_not_substituted(self):
        pool = [
            card(2, "Mega Rayquaza ex", "Special Illustration Rare | 110/076"),
            card(110, "Wrong Name", "Gold Secret Rare | 113/076"),
        ]
        buf = io.StringIO()
        with redirect_stderr(buf):
            matched, missing = rails.pick_curated_cards(
                pool,
                rails.NEW_CARDS_CURATED[:2],
                set_aliases=rails.NEW_CARDS_SET_ALIASES,
                set_needles=rails.NEW_CARDS_SET_NEEDLES,
            )
        self.assertEqual([item["id"] for item in matched], ["2"])
        self.assertEqual(missing[0]["number"], "113/076")
        log = buf.getvalue()
        self.assertIn("Mega Rayquaza ex — 113/076", log)
        self.assertIn("not substituted", log)
        self.assertNotIn("110", [item["id"] for item in matched if item["name"] == "Wrong Name"])


class FeaturedThirtiethTests(unittest.TestCase):
    def test_limit_is_thirty(self):
        self.assertEqual(rails.FEATURED_LIMIT, 30)

    def test_daily_seed_is_utc_calendar_day(self):
        self.assertEqual(
            rails.featured_day_seed(datetime(2026, 9, 13, 23, 0, tzinfo=timezone.utc)),
            "2026-09-13",
        )

    def test_same_seed_keeps_order_and_duplicate_names(self):
        pool = [
            card(1, "Pikachu", "001/103", "30th Celebration JP"),
            card(2, "Pikachu", "041/103", "30th Celebration JP"),
            card(3, "Umbreon", "091/128", "30th Celebration"),
            card(4, "Mudkip", "009/30th-P", "30th Anniversary Celebration: First Partner Illustration Collection"),
            card(5, "Basic Fire Energy", "412506", "30th Celebration JP"),
            card(6, "30th Celebration JP Display Frame", "", "30th Celebration JP"),
            card(7, "Combee", "006/076", "Storm Emeralda"),
            card(8, "Magnetic Display frame", "First Partner Special Illustration Card Set Vol. 1", "30th Anniversary Celebration: First Partner Illustration Collection"),
        ]
        first = rails.pick_featured_cards(pool, 30, seed="2026-09-13")
        second = rails.pick_featured_cards(pool, 30, seed="2026-09-13")
        self.assertEqual([item["id"] for item in first], [item["id"] for item in second])
        self.assertEqual(len(first), 4)
        self.assertEqual({item["id"] for item in first}, {"1", "2", "3", "4"})
        self.assertEqual([item["name"] for item in first].count("Pikachu"), 2)

    def test_tile_sql_copies_candidate_artist(self):
        self.assertIn("coalesce(c.artist, '') AS artist", rails.TILE_SQL)
        self.assertIn("coalesce(c.illustrator, '') AS illustrator", rails.TILE_SQL)
        self.assertNotIn("marketplace_blueprint_artists", rails.TILE_SQL)

    def test_different_days_can_reshuffle(self):
        pool = [card(i, f"Card {i}", f"{i:03d}/103", "30th Celebration JP") for i in range(1, 21)]
        a = [item["id"] for item in rails.pick_featured_cards(pool, 30, seed="2026-09-13")]
        b = [item["id"] for item in rails.pick_featured_cards(pool, 30, seed="2026-09-14")]
        self.assertNotEqual(a, b)


if __name__ == "__main__":
    unittest.main()
