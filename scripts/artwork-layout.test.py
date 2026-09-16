#!/usr/bin/env python3
"""Artwork layout: leftover OCR + pixels, not CLIP inherit or Secret Rare."""
from __future__ import annotations

import unittest
from pathlib import Path

from PIL import Image, ImageDraw

from importlib.machinery import SourceFileLoader

MOD = SourceFileLoader(
    "artwork_layout",
    str(Path(__file__).resolve().parent / "artwork-layout.py"),
).load_module()

NVME_LEFTOVERS = Path("/home/nez/data/pokoin-leftovers/objects")
NVME = Path("/home/nez/Projects/pokoin/PokoinTest/index/cdn_images")
OBJECTS = Path("/home/nez/mnt/mybook/pokoin-pi-card-images/objects")


def leftover_roots() -> tuple[Path, ...]:
    return (
        NVME_LEFTOVERS,
        NVME,
        NVME.parent / "cdn_images_delta",
        Path("/home/nez/data/pokoin-artwork-layout-objects"),
    )


def leftover(*names: str) -> Path | None:
    for root in leftover_roots():
        for name in names:
            path = root / name
            if path.is_file():
                return path
    return None


def leftover_ct(ct_id: int | str) -> Path | None:
    prefix = f"{int(ct_id)}_"
    for root in leftover_roots():
        if not root.is_dir():
            continue
        hits = sorted(
            path
            for path in root.glob(f"{prefix}*")
            if path.suffix.lower() in {".jpg", ".jpeg"}
        )
        if hits:
            return hits[0]
    return None


def paint_window_card():
    im = Image.new("RGB", (500, 700), (30, 34, 48))
    draw = ImageDraw.Draw(im)
    draw.rectangle((0, 0, 499, 90), fill=(18, 20, 28))
    draw.rectangle((40, 100, 460, 330), fill=(70, 140, 90))
    draw.rectangle((40, 360, 460, 640), fill=(236, 210, 90))
    return im


def paint_bleed_card():
    im = Image.new("RGB", (500, 700), (90, 130, 190))
    draw = ImageDraw.Draw(im)
    draw.ellipse((40, 40, 460, 620), fill=(160, 90, 200))
    return im


def paint_type_panel_card():
    im = Image.new("RGB", (500, 700), (200, 210, 220))
    draw = ImageDraw.Draw(im)
    draw.rectangle((40, 90, 460, 330), fill=(70, 140, 90))
    draw.rectangle((40, 360, 460, 640), fill=(121, 187, 230))
    return im


class CatalogLayout(unittest.TestCase):
    def test_prize_pack_title_is_not_bleed(self):
        self.assertEqual(
            MOD.catalog_layout("Mega Eelektross ex", "Ultra Rare | 061/217"),
            "window",
        )
        self.assertEqual(
            MOD.catalog_layout("N's Zoroark ex", "098/159"),
            "window",
        )

    def test_paldean_fates_shiny_rare_is_window_hidden_fates_sv_is_bleed(self):
        self.assertEqual(
            MOD.catalog_layout("Dolliv", "Shiny Rare | 103/091"),
            "window",
        )
        self.assertEqual(
            MOD.catalog_layout("Diancie", "Shiny Rare | SV36/SV94"),
            "window",
        )
        layout, source = MOD.decide_layout(
            "window", "bleed", "no_chrome", "Shiny Rare | SV86/SV94", "Lady",
        )
        self.assertEqual(layout, "bleed")
        self.assertTrue(source.startswith("geometry:"))

    def test_radiant_overrides_timid_bleed_geometry(self):
        layout, source = MOD.decide_layout(
            "window",
            "bleed",
            "no_chrome",
            "Shiny Rare | 046/071",
            "Radiant Hisuian Sneasler",
        )
        self.assertEqual(layout, "window")
        self.assertEqual(source, "catalog_radiant")

    def test_reverse_foil_catalog_stays_window(self):
        self.assertEqual(
            MOD.catalog_layout("Quaxly", "CSV9C | Master Ball Reverse | 048/208"),
            "window",
        )
        self.assertEqual(
            MOD.catalog_layout("Hop's Cramorant", "Poké Ball Reverse Holo | 143/193"),
            "window",
        )

    def test_reverse_foil_overrides_timid_bleed_geometry(self):
        layout, source = MOD.decide_layout(
            "window", "bleed", "no_chrome", "Poké Ball Reverse Holo | 143/193",
        )
        self.assertEqual(layout, "window")
        self.assertEqual(source, "catalog_reverse")
        self.assertEqual(MOD.catalog_layout("Charmander", "MEP 038"), "bleed")
        self.assertEqual(MOD.catalog_layout("Chikorita", "Promo | MEP 046"), "bleed")
        self.assertEqual(MOD.catalog_layout("Quaxly", "MEP 063"), "bleed")
        self.assertEqual(MOD.catalog_layout("Mega Venusaur ex", "MEP 013"), "window")
        self.assertEqual(MOD.catalog_layout("Chikorita", "Cosmos Holo | MEP 069"), "window")
        self.assertEqual(MOD.catalog_layout("Chikorita", "104/M-P"), "bleed")
        self.assertEqual(MOD.catalog_layout("Sprigatito", "M-P 125"), "bleed")
        self.assertEqual(MOD.catalog_layout("Quaxly", "019/M-P"), "window")

    def test_secret_rare_token_is_not_a_layout(self):
        self.assertEqual(
            MOD.catalog_layout("Squirtle", "29/149"),
            "window",
        )
        self.assertEqual(
            MOD.catalog_layout("Cinderace VMAX", "Secret Rare | 194/192"),
            "bleed",
        )
        self.assertEqual(
            MOD.catalog_layout("Altaria", "Secret Rare | 152/149"),
            "window",
        )
        self.assertEqual(
            MOD.catalog_layout("Mysterious Treasure", "Secret Rare | 145/131"),
            "window",
        )

    def test_gold_secret_catalog_is_bleed(self):
        self.assertEqual(
            MOD.catalog_layout("Mysterious Treasure", "Gold Secret Rare | 145/131"),
            "bleed",
        )
        self.assertEqual(
            MOD.catalog_layout("Electrocharger", "Gold Secret Rare | 193/181"),
            "bleed",
        )
        self.assertEqual(
            MOD.catalog_layout("Electropower", "Gold Secret Rare | 232/214"),
            "bleed",
        )

    def test_break_name_is_landscape(self):
        self.assertEqual(MOD.catalog_layout("Greninja BREAK", "017/122"), "landscape")
        self.assertEqual(MOD.catalog_layout("Call of Legends", "1/95"), "window")


class DecideLayout(unittest.TestCase):
    def test_xy_full_art_keeps_catalog_bleed_on_yellow_border(self):
        layout, source = MOD.decide_layout("bleed", "window", "era_border")
        self.assertEqual(layout, "bleed")
        self.assertEqual(source, "catalog_bleed")

    def test_rules_panel_overrides_catalog_bleed(self):
        layout, source = MOD.decide_layout("bleed", "window", "rules_panel")
        self.assertEqual(layout, "window")
        self.assertIn("rules_panel", source)

    def test_gold_secret_chrome_overrides_catalog_bleed(self):
        layout, source = MOD.decide_layout(
            "bleed", "window", "gold_rules", "Gold Secret Rare | 108/106",
        )
        self.assertEqual(layout, "window")
        self.assertIn("gold_rules", source)

    def test_sm_gold_trainer_era_border_stays_window_on_secret_rare(self):
        layout, source = MOD.decide_layout(
            "window", "window", "era_border", "Secret Rare | 145/131",
        )
        self.assertEqual(layout, "window")
        self.assertIn("era_border", source)

    def test_sm_gold_trainer_gold_secret_beats_era_border(self):
        layout, source = MOD.decide_layout(
            "bleed", "window", "era_border", "Gold Secret Rare | 145/131",
        )
        self.assertEqual(layout, "bleed")
        self.assertEqual(source, "catalog_bleed")

    def test_illustration_rare_gold_paint_stays_bleed(self):
        layout, source = MOD.decide_layout(
            "bleed", "window", "gold_rules", "Illustration Rare | 096/086",
        )
        self.assertEqual(layout, "bleed")
        self.assertEqual(source, "catalog_bleed")

    def test_shiny_rare_rules_panel_still_overrides(self):
        layout, source = MOD.decide_layout(
            "bleed", "window", "rules_panel", "Shiny Rare | SV6/SV94",
        )
        self.assertEqual(layout, "window")
        self.assertIn("rules_panel", source)

    def test_cream_paint_does_not_override_catalog_bleed(self):
        layout, source = MOD.decide_layout("bleed", "window", "cream_rules")
        self.assertEqual(layout, "bleed")
        self.assertEqual(source, "catalog_bleed")

    def test_name_bar_does_not_override_catalog_bleed(self):
        layout, source = MOD.decide_layout("bleed", "window", "name_bar")
        self.assertEqual(layout, "bleed")
        self.assertEqual(source, "catalog_bleed")

    def test_tag_team_gx_ultra_rare_is_bleed(self):
        layout, source = MOD.decide_layout(
            "bleed",
            "bleed",
            "no_chrome",
            "Ultra Rare | 171/181",
            "Eevee & Snorlax GX",
        )
        self.assertEqual(layout, "bleed")
        self.assertEqual(source, "agree:no_chrome")

    def test_vmax_secret_rare_full_art_stays_bleed(self):
        layout, source = MOD.decide_layout(
            "window",
            "bleed",
            "no_chrome",
            "Secret Rare | 194/192",
            "Cinderace VMAX",
        )
        self.assertEqual(layout, "bleed")
        self.assertEqual(source, "agree:no_chrome")

    def test_holo_rare_mega_ex_stays_window(self):
        layout, source = MOD.decide_layout(
            "window",
            "bleed",
            "no_art_box",
            "Holo Rare | 002/083",
            "M Venusaur ex",
        )
        self.assertEqual(layout, "window")
        self.assertEqual(source, "catalog_gx")

    def test_vmax_prize_pack_is_bleed(self):
        layout, source = MOD.decide_layout(
            "window",
            "bleed",
            "no_chrome",
            "030/203",
            "Vaporeon VMAX",
        )
        self.assertEqual(layout, "bleed")
        self.assertEqual(source, "agree:no_chrome")

    def test_mega_ex_bare_number_stays_window(self):
        layout, source = MOD.decide_layout(
            "window",
            "bleed",
            "no_art_box",
            "003/132",
            "Mega Venusaur ex",
        )
        self.assertEqual(layout, "window")
        self.assertEqual(source, "catalog_gx")

    def test_mega_ex_ultra_rare_full_art_stays_bleed(self):
        layout, source = MOD.decide_layout(
            "window",
            "bleed",
            "no_art_box",
            "Ultra Rare | 265/217",
            "Mega Froslass ex",
        )
        self.assertEqual(layout, "bleed")
        self.assertEqual(source, "geometry:no_art_box")

    def test_gx_holo_promo_stays_bleed(self):
        layout, source = MOD.decide_layout(
            "window",
            "bleed",
            "no_art_box",
            "Holo Promo | SM60",
            "Charizard GX",
        )
        self.assertEqual(layout, "bleed")
        self.assertEqual(source, "geometry:no_art_box")

    def test_stamp_ex_prefixed_collector_stays_window(self):
        layout, source = MOD.decide_layout(
            "window",
            "bleed",
            "no_chrome",
            "Stellar Crown Stamp | 030/142",
            "Blastoise ex",
        )
        self.assertEqual(layout, "window")
        self.assertEqual(source, "catalog_gx")

    def test_wcd_gx_is_bleed(self):
        layout, source = MOD.decide_layout(
            "bleed",
            "bleed",
            "no_art_box",
            "WCD 2019 | Haruki Miyamoto | 057/214",
            "Dedenne GX",
        )
        self.assertEqual(layout, "bleed")
        self.assertEqual(source, "agree:no_art_box")

    def test_regular_in_set_gx_is_bleed(self):
        for number, name in (
            ("Ultra Rare | 152/236", "Dragonite GX"),
            ("Full-Art | 036/068", "Onix GX"),
            ("Full-Art | 106/236", "Aerodactyl GX"),
            ("Full-Art | 157/236", "Aerodactyl GX"),
        ):
            layout, source = MOD.decide_layout(
                "bleed", "bleed", "no_chrome", number, name,
            )
            self.assertEqual(layout, "bleed", msg=f"{name} {number}")
            self.assertIn("no_chrome", source)

    def test_secret_slot_full_art_ex_stays_bleed(self):
        layout, source = MOD.decide_layout(
            "bleed",
            "bleed",
            "no_chrome",
            "Full-Art | 080/064",
            "Kingdra ex",
        )
        self.assertEqual(layout, "bleed")
        self.assertEqual(source, "agree:no_chrome")


class GeometryLayout(unittest.TestCase):
    def test_synthetic_window_and_bleed(self):
        layout, reason, _ = MOD.geometry_layout(paint_window_card())
        self.assertEqual(layout, "window")
        self.assertIn(reason, {"cream_rules", "name_bar"})
        layout, reason, _ = MOD.geometry_layout(paint_bleed_card())
        self.assertEqual(layout, "bleed")
        layout, reason, _ = MOD.geometry_layout(paint_type_panel_card())
        self.assertEqual(layout, "window")
        self.assertEqual(reason, "rules_panel")


class LeftoverScans(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        MOD._OCR_BY_CT = MOD.load_ocr_rows()

    def test_known_zoroark_window_and_full_art(self):
        window = leftover("314954_n-s-zoroark-ex-ultra-rare-061-100-battle-partners.jpg")
        bleed = leftover("326089_n-s-zoroark-ex-full-art-175-159-journey-together.jpg")
        prize = leftover("402440_mega-eelektross-ex.jpg")
        if window is None:
            self.skipTest("leftover replica missing")
        win = MOD.classify_scan(window, "N's Zoroark ex", "Ultra Rare | 061/100")
        fa = MOD.classify_scan(bleed, "N's Zoroark ex", "Full-Art | 175/159")
        mega = MOD.classify_scan(prize, "Mega Eelektross ex", "Ultra Rare | 061/217")
        self.assertEqual(win["layout"], "window")
        self.assertEqual(fa["layout"], "bleed")
        self.assertEqual(mega["layout"], "window")

    def test_gold_secret_mega_ex_is_window(self):
        path = leftover_ct(119311) or leftover(
            "119311_m-charizard-ex-full-v4.jpg",
            "119311_m-charizard-ex-full-v4.webp",
            "119311_m-charizard-ex-secret-rare-108-106-flashfire.jpg",
        )
        if path is None:
            self.skipTest("leftover replica missing")
        hit = MOD.classify_scan(path, "M Charizard ex", "Gold Secret Rare | 108/106")
        self.assertEqual(hit["layout"], "window")
        self.assertEqual(hit.get("geom_reason"), "gold_rules")

    def test_sm_gold_trainer_secret_rare_leftover_is_window(self):
        treasure = leftover_ct(119579)
        charger = leftover_ct(129862)
        if treasure is None or charger is None:
            self.skipTest("leftover replica missing")
        hit = MOD.classify_scan(
            treasure, "Mysterious Treasure", "Secret Rare | 145/131",
        )
        other = MOD.classify_scan(
            charger, "Electrocharger", "Secret Rare | 193/181",
        )
        self.assertEqual(hit["layout"], "window")
        self.assertEqual(hit.get("geom_reason"), "era_border")
        self.assertEqual(other["layout"], "window")
        self.assertEqual(other.get("geom_reason"), "era_border")

    def test_sm_gold_trainer_gold_secret_leftover_is_bleed(self):
        treasure = leftover_ct(119579)
        charger = leftover_ct(129862)
        electropower = leftover_ct(122697)
        if treasure is None or charger is None or electropower is None:
            self.skipTest("leftover replica missing")
        hit = MOD.classify_scan(
            treasure, "Mysterious Treasure", "Gold Secret Rare | 145/131",
        )
        other = MOD.classify_scan(
            charger, "Electrocharger", "Gold Secret Rare | 193/181",
        )
        ref = MOD.classify_scan(
            electropower, "Electropower", "Gold Secret Rare | 232/214",
        )
        self.assertEqual(hit["layout"], "bleed")
        self.assertTrue(str(hit["source"]).startswith("catalog_bleed"))
        self.assertEqual(hit.get("geom_reason"), "era_border")
        self.assertEqual(other["layout"], "bleed")
        self.assertTrue(str(other["source"]).startswith("catalog_bleed"))
        self.assertEqual(ref["layout"], "bleed")
        self.assertTrue(str(ref["source"]).startswith("catalog_bleed"))

    def test_sm_gold_energy_template_is_not_mega_rules_sheet(self):
        energy = leftover_ct(120578)
        mega = leftover_ct(119311)
        if energy is None or mega is None:
            self.skipTest("leftover replica missing")
        gold = MOD.classify_scan(
            energy, "Fighting Energy", "Gold Secret Rare | 169/145",
        )
        window = MOD.classify_scan(
            mega, "M Charizard ex", "Gold Secret Rare | 108/106",
        )
        self.assertEqual(window["layout"], "window")
        self.assertEqual(window.get("geom_reason"), "gold_rules")
        self.assertGreater(float((gold.get("stats") or {}).get("yellow_border") or 0), 0.40)
        self.assertLess(float((window.get("stats") or {}).get("yellow_border") or 0), 0.40)
        # Gold energy frame still trips gold_rules. A Gold Secret rename
        # would keep window; stamp leftover bleed like Electropower instead.
        self.assertEqual(gold.get("geom_reason"), "gold_rules")
        self.assertEqual(gold["layout"], "window")

    def test_hidden_fates_sv86_is_bleed(self):
        path = leftover("121458_lady-sv86-sv94-hidden-fates.jpg")
        if path is None:
            self.skipTest("leftover replica missing")
        hit = MOD.classify_scan(path, "Lady", "Shiny Rare | SV86/SV94")
        self.assertEqual(hit["layout"], "bleed")

    def test_boundaries_crossed_squirtle_is_window(self):
        path = leftover("111720_squirtle-29-149-boundaries-crossed.jpg")
        if path is None:
            self.skipTest("leftover replica missing")
        hit = MOD.classify_scan(path, "Squirtle", "29/149")
        self.assertEqual(hit["layout"], "window")
        self.assertIn(hit.get("geom_reason"), {"era_border", "rules_panel"})
        self.assertTrue(hit.get("ocr_chrome"))

    def test_mega_evolution_fearow_white_panel_is_window(self):
        path = leftover("351617_fearow.jpg")
        if path is None:
            self.skipTest("leftover replica missing")
        hit = MOD.classify_scan(path, "Fearow", "103/132")
        self.assertEqual(hit["layout"], "window")
        self.assertEqual(hit.get("geom_reason"), "white_rules")

    def test_stellar_crown_squirtle_ir_stays_bleed(self):
        path = leftover("299010_squirtle-illustration-rare-148-142-stellar-crown.jpg")
        if path is None:
            self.skipTest("leftover replica missing")
        hit = MOD.classify_scan(path, "Squirtle", "Illustration Rare | 148/142")
        self.assertEqual(hit["layout"], "bleed")
        self.assertNotEqual(hit.get("geom_reason"), "white_rules")

    def test_cinderace_secret_vmax_stays_bleed(self):
        path = leftover(
            "133167_cinderace-vmax-secret-rare-194-192-rebel-clash.jpg",
        )
        if path is None:
            self.skipTest("leftover replica missing")
        hit = MOD.classify_scan(path, "Cinderace VMAX", "Secret Rare | 194/192")
        self.assertEqual(hit["layout"], "bleed")
        self.assertIn(hit.get("geom_reason"), {"no_chrome", "no_art_box"})

    def test_mep_charmander_promo_is_full_art(self):
        path = leftover("380363_charmander.jpg")
        if path is None:
            self.skipTest("leftover replica missing")
        hit = MOD.classify_scan(path, "Charmander", "MEP 038")
        self.assertEqual(hit["layout"], "bleed")
        self.assertIn(hit.get("geom_reason"), {"no_art_box", "no_chrome"})

    def test_quagsire_svp156_type_panel_is_window(self):
        path = leftover("311313_quagsire-cosmos-holo-156-sv-black-star-promos.jpg")
        if path is None:
            self.skipTest("leftover replica missing")
        hit = MOD.classify_scan(path, "Quagsire", "Cosmos Holo | SVP 156")
        self.assertEqual(hit["layout"], "window")
        self.assertEqual(hit.get("geom_reason"), "rules_panel")

    def test_hidden_fates_sv6_charmander_leftover_is_window(self):
        path = leftover("121378_charmander-sv6-sv94-hidden-fates.jpg")
        if path is None:
            self.skipTest("leftover replica missing")
        hit = MOD.classify_scan(path, "Charmander", "Shiny Rare | SV6/SV94")
        self.assertEqual(hit["layout"], "window")
        self.assertEqual(hit.get("geom_reason"), "rules_panel")

    def test_xy_charizard_ex_full_art_is_bleed(self):
        path = leftover("119313_charizard-ex-full-v4.jpg")
        if path is None:
            self.skipTest("leftover replica missing")
        hit = MOD.classify_scan(path, "Charizard EX", "Sheen Holo | Battle Arena Deck 012/106")
        self.assertEqual(hit["layout"], "bleed")
        self.assertNotEqual(hit.get("geom_reason"), "gold_rules")

    def test_chikorita_mep046_illustration_is_bleed(self):
        path = leftover("389929_chikorita.jpg")
        if path is None:
            self.skipTest("leftover replica missing")
        hit = MOD.classify_scan(path, "Chikorita", "MEP 046")
        self.assertEqual(hit["layout"], "bleed")
        self.assertNotEqual(hit.get("geom_reason"), "gold_rules")

    def test_oshawott_mep051_illustration_is_bleed(self):
        path = leftover("389934_oshawott.jpg")
        if path is None:
            self.skipTest("leftover replica missing")
        hit = MOD.classify_scan(path, "Oshawott", "MEP 051")
        self.assertEqual(hit["layout"], "bleed")
        self.assertNotEqual(hit.get("geom_reason"), "name_bar")

    def test_excadrill_ir_is_bleed(self):
        path = leftover(
            "281175_excadrill-illustration-rare-174-162-temporal-forces.jpg",
        )
        if path is None:
            self.skipTest("leftover replica missing")
        hit = MOD.classify_scan(path, "Excadrill", "Illustration Rare | 174/162")
        self.assertEqual(hit["layout"], "bleed")

    def test_mega_froslass_ex_full_art_is_bleed(self):
        path = leftover("370903_mega-froslass-ex.jpg")
        if path is None:
            self.skipTest("leftover replica missing")
        hit = MOD.classify_scan(
            path, "Mega Froslass ex", "Ultra Rare | 265/217",
        )
        self.assertEqual(hit["layout"], "bleed")
        self.assertNotEqual(hit.get("geom_reason"), "art_box")

    def test_accelgor_ir_dark_forest_is_bleed(self):
        path = leftover("342874_accelgor.jpg")
        if path is None:
            self.skipTest("leftover replica missing")
        hit = MOD.classify_scan(path, "Accelgor", "Illustration Rare | 094/086")
        self.assertEqual(hit["layout"], "bleed")

    def test_tepig_ir_autumn_gold_is_bleed(self):
        path = leftover("342876_tepig.jpg")
        if path is None:
            self.skipTest("leftover replica missing")
        hit = MOD.classify_scan(path, "Tepig", "Illustration Rare | 096/086")
        self.assertEqual(hit["layout"], "bleed")

    def test_beautifly_ir_cream_paint_is_bleed(self):
        path = leftover("370857_beautifly.jpg")
        if path is None:
            self.skipTest("leftover replica missing")
        hit = MOD.classify_scan(path, "Beautifly", "Illustration Rare | 219/217")
        self.assertEqual(hit["layout"], "bleed")

    def test_chikorita_104_mp_illustration_is_bleed(self):
        path = leftover("395760_chikorita.jpg")
        if path is None:
            self.skipTest("leftover replica missing")
        hit = MOD.classify_scan(path, "Chikorita", "104/M-P")
        self.assertEqual(hit["layout"], "bleed")

    def test_plasma_freeze_vaporeon_uncommon_is_window(self):
        path = leftover("124960_vaporeon-20-116-plasma-freeze.jpg")
        if path is None:
            self.skipTest("leftover replica missing")
        hit = MOD.classify_scan(path, "Vaporeon", "20/116")
        self.assertEqual(hit["layout"], "window")
        self.assertEqual(hit.get("geom_reason"), "rules_panel")

    def test_tag_team_gx_ultra_rare_leftover_is_bleed(self):
        path = leftover(
            "129840_eevee-snorlax-gx-rare-ultra-171-181-team-up.jpg",
        )
        if path is None:
            self.skipTest("leftover replica missing")
        hit = MOD.classify_scan(
            path, "Eevee & Snorlax GX", "Ultra Rare | 171/181",
        )
        self.assertEqual(hit["layout"], "bleed")

    def test_holo_rare_mega_venusaur_ex_leftover_is_window(self):
        path = leftover("119911_m-venusaur-ex-full-v4.jpg")
        if path is None:
            self.skipTest("leftover replica missing")
        hit = MOD.classify_scan(path, "M Venusaur ex", "Holo Rare | 002/083")
        self.assertEqual(hit["layout"], "window")

    def test_vaporeon_vmax_prize_pack_leftover_is_bleed(self):
        path = leftover(
            "242241_vaporeon-vmax-030-203-play-pokemon-prize-pack.jpg",
        )
        if path is None:
            self.skipTest("leftover replica missing")
        hit = MOD.classify_scan(path, "Vaporeon VMAX", "030/203")
        self.assertEqual(hit["layout"], "bleed")

    def test_mcdonalds_quaxly_019_mp_is_window(self):
        path = leftover("345784_quaxly.jpg")
        if path is None:
            self.skipTest("leftover replica missing")
        hit = MOD.classify_scan(path, "Quaxly", "019/M-P")
        self.assertEqual(hit["layout"], "window")

    def test_quaxly_master_ball_reverse_is_window(self):
        path = leftover("390872_quaxly.jpg")
        if path is None:
            self.skipTest("leftover replica missing")
        hit = MOD.classify_scan(
            path, "Quaxly", "CSV9C | Master Ball Reverse | 048/208",
        )
        self.assertEqual(hit["layout"], "window")

    def test_cramorant_poke_ball_reverse_is_window(self):
        path = leftover("360216_hop-s-cramorant.jpg")
        if path is None:
            self.skipTest("leftover replica missing")
        hit = MOD.classify_scan(
            path, "Hop's Cramorant", "Poké Ball Reverse Holo | 143/193",
        )
        self.assertEqual(hit["layout"], "window")

    def test_wobbuffet_svp203_full_art_is_bleed(self):
        path = leftover("331757_team-rocket-s-wobbuffet.jpg")
        if path is None:
            self.skipTest("leftover replica missing")
        hit = MOD.classify_scan(path, "Team Rocket's Wobbuffet", "SVP 203")
        self.assertEqual(hit["layout"], "bleed")

    def test_totodile_mep048_illustration_is_bleed(self):
        path = leftover("389931_totodile.jpg")
        if path is None:
            self.skipTest("leftover replica missing")
        hit = MOD.classify_scan(path, "Totodile", "MEP 048")
        self.assertEqual(hit["layout"], "bleed")
        self.assertNotEqual(hit.get("geom_reason"), "gold_rules")

    def test_stellar_crown_stamp_blastoise_is_window(self):
        path = leftover("355275_blastoise-ex.jpg")
        if path is None:
            self.skipTest("leftover replica missing")
        hit = MOD.classify_scan(
            path, "Blastoise ex", "Stellar Crown Stamp | 030/142",
        )
        self.assertEqual(hit["layout"], "window")

    def test_dragonite_gx_unified_minds_is_bleed(self):
        path = leftover(
            "131294_dragonite-gx-152-236-unified-minds.jpg",
        )
        if path is None:
            self.skipTest("leftover replica missing")
        hit = MOD.classify_scan(
            path, "Dragonite GX", "Ultra Rare | 152/236",
        )
        self.assertEqual(hit["layout"], "bleed")


    def test_xy_ultra_rare_fa_ex_catalog_is_bleed(self):
        for name, number in (
            ("Pidgeot EX", "Ultra Rare | 104/108"),
            ("Dragonite EX", "Ultra Rare | 106/108"),
            ("Mewtwo EX", "Ultra Rare | 103/108"),
            ("Darkrai EX", "Ultra Rare | 118/122"),
            ("Altaria EX", "Ultra Rare | 123/124"),
            ("Thundurus EX", "Ultra Rare | 98/108"),
        ):
            self.assertEqual(MOD.catalog_layout(name, number), "bleed", msg=f"{name} {number}")
        # Mid-set Ultra Rare EX stays a framed window.
        self.assertEqual(
            MOD.catalog_layout("Mega Eelektross ex", "Ultra Rare | 061/217"),
            "window",
        )

    def test_xy_ultra_rare_fa_ex_leftovers_are_bleed(self):
        cases = (
            (118500, "Pidgeot EX", "Ultra Rare | 104/108"),
            (118502, "Dragonite EX", "Ultra Rare | 106/108"),
            (118499, "Mewtwo EX", "Ultra Rare | 103/108"),
            (110590, "Darkrai EX", "Ultra Rare | 118/122"),
            (119092, "Altaria EX", "Ultra Rare | 123/124"),
            (126712, "Thundurus EX", "Ultra Rare | 98/108"),
        )
        for ct, name, number in cases:
            path = leftover_ct(ct)
            if path is None:
                self.skipTest(f"leftover {ct} missing")
            hit = MOD.classify_scan(path, name, number)
            self.assertEqual(hit["layout"], "bleed", msg=f"{name} {hit}")


if __name__ == "__main__":
    unittest.main()
