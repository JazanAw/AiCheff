from __future__ import annotations

import json
from pathlib import Path

from aichef_offers.core import (
    RunConfig,
    download_bls,
    extract_allergens_from_off,
    map_allergen,
    parse_quantity,
    run_eval,
    run_pipeline,
)


def write_snapshot(path: Path, payload: dict) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def build_default_config(tmp_path: Path, input_dir: Path, out_dir: Path) -> RunConfig:
    return RunConfig(
        input_dir=input_dir,
        out_dir=out_dir,
        mode="overlap",
        as_of="2026-02-12",
        week_start="2026-02-09",
        week_window="calendar",
        week_end_day=None,
        include_locked=True,
        emit_visible=True,
        ollama_on=False,
        ollama_url="http://localhost:11434",
        ollama_model="llama3.1",
        ollama_timeout=8,
        ollama_max_consecutive_failures=0,
        national_on=True,
        national_threshold=0.8,
        min_rule_score=3.0,
        min_margin=1.5,
        embeddings_on=False,
        knn_k=5,
        knn_threshold=0.7,
        keywords_file=None,
        nutrition_on=True,
        nutrition_source="both",
        nutrition_ttl_days=30,
        max_off_req_per_min=200,
        bls_path=tmp_path / "bls",
        diet_on=True,
        halal_on=True,
        veg_implies_halal=True,
        dump_stats=True,
    )


def load_offers(path: Path) -> list[dict]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    return payload.get("offers", [])


def find_offer(offers: list[dict], name: str) -> dict:
    for offer in offers:
        title = offer.get("title") or offer.get("name") or ""
        if title == name:
            return offer
    raise AssertionError(f"offer not found: {name}")


def test_pipeline_core_logic(monkeypatch, tmp_path: Path) -> None:
    # Die Pipeline legt ihren Naehrwert-Cache relativ zum Arbeitsverzeichnis an
    # (cache/nutrition_cache.sqlite). Ohne chdir las der Test den lokalen
    # Entwickler-Cache mit und lief nur dort gruen, in einem frischen Klon nicht.
    monkeypatch.chdir(tmp_path)
    input_dir = tmp_path / "data"
    out_dir = tmp_path / "out"
    input_dir.mkdir(parents=True, exist_ok=True)
    download_bls(tmp_path / "bls")

    common_offer = {
        "chain": "REWE",
        "name": "Apfel rot",
        "category": "Obst",
        "validityStart": "2026-02-09",
        "validityEnd": "2026-02-15",
        "price": "1,99",
        "size": "1 kg",
    }

    write_snapshot(
        input_dir / "snapshot_10115.json",
        {
            "snapshotId": "10115",
            "offers": [
                {
                    "chain": "Lidl",
                    "name": "Rinderhack 500g",
                    "category": "Fleisch",
                    "validityStart": "2026-02-09T00:00:00Z",
                    "validityEnd": "2026-02-15T23:59:59Z",
                    "price": "4,99",
                    "size": "500 g",
                },
                {
                    "chain": "Lidl",
                    "name": "Floralys Küchentücher XXL",
                    "category": "Haushalt",
                    "validityStart": "2026-02-09",
                    "validityEnd": "2026-02-15",
                    "price": "1,99",
                    "size": "1 Stk",
                },
                {
                    "chain": "Kaufland",
                    "name": "Rumkugeln Pralinen Mix",
                    "category": "Alkohol",
                    "validityStart": "2026-02-09",
                    "validityEnd": "2026-02-15",
                    "price": "1,79",
                    "size": "200 g",
                },
                {
                    "chain": "PENNY",
                    "name": "Vodka Premium 37,5%",
                    "category": "Getränke",
                    "validityStart": "2026-02-09",
                    "validityEnd": "2026-02-15",
                    "price": "5,99",
                    "size": "0.7 l",
                },
                {
                    "chain": "Netto Marken-Discount",
                    "name": "Nivea Handcreme Sensitive",
                    "category": "Drogerie",
                    "validityStart": "2026-02-09",
                    "validityEnd": "2026-02-15",
                    "price": "2,99",
                    "size": "75 ml",
                    "barcode": "12345HC",
                },
                {
                    "chain": "ALDI NORD",
                    "name": "Not M*lk Drink",
                    "category": "Sonstiges",
                    "validityStart": "2026-02-09",
                    "validityEnd": "2026-02-15",
                    "price": "1,49",
                    "size": "1 l",
                },
                {
                    "chain": "ALDI NORD",
                    "name": "Alkoholfrei Weiss",
                    "category": "Sonstiges",
                    "validityStart": "2026-02-09",
                    "validityEnd": "2026-02-15",
                    "price": "2,99",
                    "size": "0,75 l",
                },
                {
                    "chain": "Lidl",
                    "name": "Cafe Royal Kuechenrolle Crema",
                    "category": "Sonstiges",
                    "validityStart": "2026-02-09",
                    "validityEnd": "2026-02-15",
                    "price": "2,99",
                    "size": "3 Rollen",
                },
                {
                    "chain": "ALDI NORD",
                    "name": "Tomaten-Ampel",
                    "category": "Obst & Gemuese",
                    "validityStart": "2026-02-09",
                    "validityEnd": "2026-02-15",
                    "price": "4,49",
                    "size": "pflanze",
                },
                {
                    "chain": "Kaufland",
                    "name": "SPICE&SOUL Thermoglaser fuer Tee",
                    "category": "Getraenke",
                    "validityStart": "2026-02-09",
                    "validityEnd": "2026-02-15",
                    "price": "4,99",
                    "size": "2 Stk",
                },
                {
                    "chain": "PENNY",
                    "name": "FINISH Klarspuler",
                    "category": "Sonstiges",
                    "validityStart": "2026-02-09",
                    "validityEnd": "2026-02-15",
                    "price": "3,99",
                    "size": "800 ml",
                },
                {
                    "chain": "ALDI NORD",
                    "name": "Kraft-Gel Universal",
                    "brand": "PERSIL",
                    "category": "Sonstiges",
                    "validityStart": "2026-02-09",
                    "validityEnd": "2026-02-15",
                    "price": "4,99",
                    "size": "900 ml",
                },
                {
                    "chain": "ALDI NORD",
                    "name": "Waschpulver Color",
                    "brand": "PERSIL",
                    "category": "Sonstiges",
                    "validityStart": "2026-02-09",
                    "validityEnd": "2026-02-15",
                    "price": "4,99",
                    "size": "1,26 kg",
                },
                {
                    "chain": "ALDI SUED",
                    "name": "Sonnencreme Ultra Sensitive LSF50 75ml",
                    "brand": "LACURA",
                    "category": "Sonstiges",
                    "validityStart": "2026-02-09",
                    "validityEnd": "2026-02-15",
                    "price": "2,49",
                    "size": "75 ml",
                },
                {
                    "chain": "Kaufland",
                    "name": "DOVE Duschcreme Advanced Care",
                    "category": "Sonstiges",
                    "validityStart": "2026-02-09",
                    "validityEnd": "2026-02-15",
                    "price": "2,49",
                    "size": "225 ml",
                },
                {
                    "chain": "Kaufland",
                    "name": "SILVERCREST Fruchtsaftkrug",
                    "category": "Sonstiges",
                    "validityStart": "2026-02-09",
                    "validityEnd": "2026-02-15",
                    "price": "6,99",
                    "size": "1 Stk",
                },
                {
                    "chain": "Kaufland",
                    "name": "LENOR Waescheparfuem",
                    "category": "Sonstiges",
                    "validityStart": "2026-02-09",
                    "validityEnd": "2026-02-15",
                    "price": "5,99",
                    "size": "280 g",
                },
                {
                    "chain": "Lidl",
                    "name": "Dundalgan Single Malt IPA Cask Finish Irish Whiskey 42% vol",
                    "category": "Alkohol",
                    "validityStart": "2026-02-09",
                    "validityEnd": "2026-02-15",
                    "price": "15,99",
                    "size": "1 Stk",
                },
                {
                    "chain": "EDEKA",
                    "name": "Weekend Deal Pasta",
                    "category": "Grundnahrungsmittel",
                    "validityStart": "2026-02-11",
                    "validityEnd": "2026-02-13",
                    "price": "1,11",
                    "size": "500 g",
                },
                common_offer,
            ],
        },
    )
    write_snapshot(input_dir / "snapshot_20095.json", {"snapshotId": "20095", "offers": [common_offer]})
    write_snapshot(input_dir / "snapshot_80331.json", {"snapshotId": "80331", "offers": [common_offer]})

    def mocked_off_fetch(self, barcode: str):  # type: ignore[no-untyped-def]
        if barcode == "12345HC":
            return {
                "nutriments": {
                    "energy-kcal_100g": 420,
                    "proteins_100g": 0.0,
                    "carbohydrates_100g": 18.0,
                    "fat_100g": 34.0,
                    "sugars_100g": 15.0,
                },
                "allergens_tags": [],
                "traces_tags": [],
                "ingredients_text": "Aqua, Gelatine (Schwein), Duftstoffe",
                "labels_tags": ["en:not-halal"],
                "ingredients_analysis_tags": [],
            }
        return None

    monkeypatch.setattr("aichef_offers.core.OFFClient.fetch", mocked_off_fetch)

    config = build_default_config(tmp_path, input_dir, out_dir)
    run_pipeline(config)

    all_week = load_offers(out_dir / "all_in_week.json")
    food_week = load_offers(out_dir / "food_in_week.json")
    visible_week = load_offers(out_dir / "visible_in_week.json")
    locked = load_offers(out_dir / "flagged_locked.json")
    nonfood = load_offers(out_dir / "flagged_nonfood.json")
    midweek = load_offers(out_dir / "flagged_midweek.json")
    debug_low = load_offers(out_dir / "debug_low_confidence.json")
    halal_no = load_offers(out_dir / "flagged_halal_no.json")
    gelatin_unknown = load_offers(out_dir / "flagged_gelatin_unknown.json")

    rinderhack = find_offer(all_week, "Rinderhack 500g")
    assert rinderhack["canonicalCategory"]["main"] == "Fleisch & Wurst"
    assert rinderhack["canonicalCategory"]["sub"] == "Hack"

    rumkugeln = find_offer(all_week, "Rumkugeln Pralinen Mix")
    assert rumkugeln["canonicalCategory"]["main"] == "Süßwaren & Snacks"

    vodka = find_offer(all_week, "Vodka Premium 37,5%")
    assert vodka["canonicalCategory"]["main"] == "Alkohol"

    kuechentuecher = find_offer(all_week, "Floralys Küchentücher XXL")
    assert kuechentuecher["foodFlag"] == "nonfood"
    assert kuechentuecher["canonicalCategory"]["main"] == "Non-Food"

    milk_alternative = find_offer(all_week, "Not M*lk Drink")
    alcohol_free_wine = find_offer(all_week, "Alkoholfrei Weiss")
    kitchen_roll = find_offer(all_week, "Cafe Royal Kuechenrolle Crema")
    tomato_plant = find_offer(all_week, "Tomaten-Ampel")
    tea_glasses = find_offer(all_week, "SPICE&SOUL Thermoglaser fuer Tee")
    rinse_aid = find_offer(all_week, "FINISH Klarspuler")
    detergent = find_offer(all_week, "Kraft-Gel Universal")
    washing_powder = find_offer(all_week, "Waschpulver Color")
    sunscreen = find_offer(all_week, "Sonnencreme Ultra Sensitive LSF50 75ml")
    dove = find_offer(all_week, "DOVE Duschcreme Advanced Care")
    kitchen_ware = find_offer(all_week, "SILVERCREST Fruchtsaftkrug")
    laundry_perfume = find_offer(all_week, "LENOR Waescheparfuem")
    whiskey = find_offer(all_week, "Dundalgan Single Malt IPA Cask Finish Irish Whiskey 42% vol")
    handcreme = find_offer(all_week, "Nivea Handcreme Sensitive")
    assert milk_alternative["foodFlag"] == "food"
    assert milk_alternative["canonicalCategory"]["main"] == "Milchprodukte & Eier"
    assert milk_alternative["canonicalCategory"]["sub"] == "Milch"

    assert alcohol_free_wine["foodFlag"] == "food"
    assert alcohol_free_wine["canonicalCategory"]["main"] == "Alkohol"
    assert alcohol_free_wine["canonicalCategory"]["sub"] == "Wein"

    assert kitchen_roll["foodFlag"] == "nonfood"
    assert kitchen_roll["offerAvailability"]["status"] == "locked"
    assert kitchen_roll["offerAvailability"]["lockedReason"] == "nonfood_blocked"

    assert tomato_plant["foodFlag"] == "nonfood"
    assert tea_glasses["foodFlag"] == "nonfood"
    assert rinse_aid["foodFlag"] == "nonfood"
    assert detergent["foodFlag"] == "nonfood"
    assert washing_powder["foodFlag"] == "nonfood"
    assert sunscreen["foodFlag"] == "nonfood"
    assert dove["foodFlag"] == "nonfood"
    assert kitchen_ware["foodFlag"] == "nonfood"
    assert laundry_perfume["foodFlag"] == "nonfood"
    assert whiskey["foodFlag"] == "food"
    assert whiskey["canonicalCategory"]["main"] == "Alkohol"

    assert handcreme["foodFlag"] == "nonfood"
    assert handcreme["dietFlags"]["gelatin"]["source"] == "pork"
    assert handcreme["dietFlags"]["halal"]["status"] == "no"
    assert handcreme["nutrition"]["source"] == "openfoodfacts"
    assert handcreme["nutrition"]["per_100g"]["sugars_g"] == 15.0

    weekend = find_offer(all_week, "Weekend Deal Pasta")
    assert weekend["weekFlags"]["startsMidweek"] is True
    assert weekend["weekFlags"]["endsMidweek"] is False
    assert weekend["weekFlags"]["endsBeforeWeekEnd"] is True
    assert weekend["weekFlags"]["partialWeek"] is True
    assert weekend["offerAvailability"]["status"] == "unlocked"

    apfel = find_offer(all_week, "Apfel rot")
    assert apfel["national"]["isNational"] is True
    assert apfel["nutrition"]["source"] == "bls"

    assert len(food_week) < len(all_week)
    assert len(visible_week) <= len(all_week)
    assert len(nonfood) >= 2
    assert len(locked) >= 0
    assert len(midweek) >= 1
    assert len(debug_low) >= 1
    assert len(halal_no) >= 1
    assert len(gelatin_unknown) == 0

    summary = (out_dir / "summary.md").read_text(encoding="utf-8")
    assert "Nutrition coverage" in summary
    assert "Halal" in summary
    stats = json.loads((out_dir / "stats.json").read_text(encoding="utf-8"))
    assert stats["all_in_week"] == len(all_week)


def test_veg_priority_and_unknown_gelatin(monkeypatch, tmp_path: Path) -> None:
    input_dir = tmp_path / "data"
    out_dir = tmp_path / "out"
    input_dir.mkdir(parents=True, exist_ok=True)
    download_bls(tmp_path / "bls")
    write_snapshot(
        input_dir / "snapshot.json",
        {
            "snapshotId": "10115",
            "offers": [
                {
                    "chain": "REWE",
                    "name": "Veganer Fruchtgummi Mix",
                    "category": "Süßwaren",
                    "validityStart": "2026-02-09",
                    "validityEnd": "2026-02-15",
                    "price": "1,99",
                    "size": "200 g",
                    "barcode": "VEGAN1",
                },
                {
                    "chain": "REWE",
                    "name": "Fruchtgummi Classic",
                    "category": "Süßwaren",
                    "validityStart": "2026-02-09",
                    "validityEnd": "2026-02-15",
                    "price": "1,49",
                    "size": "200 g",
                },
            ],
        },
    )

    def mocked_off_fetch(self, barcode: str):  # type: ignore[no-untyped-def]
        if barcode == "VEGAN1":
            return {
                "nutriments": {"energy-kcal_100g": 320},
                "ingredients_analysis_tags": ["en:vegan"],
                "labels_tags": ["en:non-halal"],
                "ingredients_text": "Agar-Agar, Zucker",
                "allergens_tags": [],
                "traces_tags": [],
            }
        return None

    monkeypatch.setattr("aichef_offers.core.OFFClient.fetch", mocked_off_fetch)

    config = build_default_config(tmp_path, input_dir, out_dir)
    run_pipeline(config)
    all_week = load_offers(out_dir / "all_in_week.json")
    vegan = find_offer(all_week, "Veganer Fruchtgummi Mix")
    classic = find_offer(all_week, "Fruchtgummi Classic")

    assert vegan["dietFlags"]["vegan"] is True
    assert vegan["dietFlags"]["gelatin"]["present"] is False
    # Phase 2.0 Bugfix: vegan impliziert NICHT halal. Das en:non-halal-Label ist
    # ein Ausschlussgrund und ueberstimmt jeden Veg-Status (kein veg_implies_halal).
    assert vegan["dietFlags"]["halal"]["status"] == "no"
    assert vegan["dietFlags"]["halal"]["statusV2"] == "not_halal"
    assert "off:label_non_halal" in vegan["dietFlags"]["halal"]["reasons"]
    assert vegan["productAnalysis"]["halal"]["status"] == "not_halal"

    assert classic["dietFlags"]["gelatin"]["present"] is True
    assert classic["dietFlags"]["gelatin"]["source"] == "unknown"
    assert classic["dietFlags"]["halal"]["status"] == "unknown"

    flagged_unknown = load_offers(out_dir / "flagged_gelatin_unknown.json")
    assert find_offer(flagged_unknown, "Fruchtgummi Classic")


def test_quantity_parser() -> None:
    amount, basis, conf = parse_quantity("6x330 ml")
    assert amount == 1980
    assert basis == "ml"
    assert conf > 0.9


def test_allergen_codes_contract() -> None:
    # The backend (dealFields.ts ALLERGEN_ALIASES) maps these EU-14 codes onto
    # the app's 8 allergen slugs. Lock the codes the pipeline actually emits so
    # the two layers cannot silently drift apart.
    assert map_allergen("en:milk") == "milk"
    assert map_allergen("en:gluten") == "gluten_cereals"
    assert map_allergen("en:soybeans") == "soybeans"
    assert map_allergen("en:peanuts") == "peanuts"
    assert map_allergen("en:crustaceans") == "crustaceans"
    assert map_allergen("en:molluscs") == "molluscs"
    assert map_allergen("en:sesame-seeds") == "sesame"
    assert map_allergen("en:eggs") == "eggs"
    assert map_allergen("en:fish") == "fish"
    # Codes outside the supported set still produce a canonical EU-14 key.
    assert map_allergen("en:celery") == "celery"
    # Unknown tokens never fabricate an allergen.
    assert map_allergen("en:totally-unknown") is None


def test_extract_allergens_from_off_splits_contains_and_traces() -> None:
    product = {
        "allergens_tags": ["en:milk", "en:gluten"],
        "traces_tags": ["en:nuts"],
    }
    contains, may = extract_allergens_from_off(product)
    assert contains == ["gluten_cereals", "milk"]
    assert may == ["nuts"]


REPO_BLS_PATH = Path(__file__).resolve().parent.parent / "data" / "bls" / "bls_foods.json"


def _bls_match_id(title: str, main: str, tmp_path: Path) -> str | None:
    from aichef_offers.core import NutritionCache, load_bls, match_bls

    entries = load_bls(REPO_BLS_PATH)
    cache = NutritionCache(tmp_path / "bls_cache.sqlite")
    offer = {"title": title, "canonicalCategory": {"main": main}, "id": title}
    entry, _conf = match_bls(offer, entries, cache, title)
    return str(entry.get("id")) if entry else None


def test_bls_matches_safe_german_staples(tmp_path: Path) -> None:
    # Plain, unambiguous staples must get an estimated BLS match. Names are taken
    # from the real snapshot (brand prefixes, sizes, plurals included).
    cases = [
        ("Bio Bananen 1kg", "Obst & Gemüse", "BLS-BANANA-001"),
        ("Cocktail-Rispentomaten", "Obst & Gemüse", "BLS-TOMATO-001"),
        ("Speisekartoffeln festkochend", "Obst & Gemüse", "BLS-POTATO-001"),
        ("Frische Vollmilch 3,5%", "Milchprodukte & Eier", "BLS-MILK-001"),
        ("Naturjoghurt", "Milchprodukte & Eier", "BLS-YOGURT-001"),
        ("Gouda jung", "Milchprodukte & Eier", "BLS-CHEESE-001"),
        ("MÜHLENHOF Frische Hähnchen-Brustfilets", "Fleisch & Wurst", "BLS-CHICKENBREAST-001"),
        ("Lachsfilet", "Fisch & Meeresfrüchte", "BLS-SALMON-001"),
        ("Basmatireis", "Grundnahrungsmittel", "BLS-RICE-001"),
        ("Spaghetti", "Grundnahrungsmittel", "BLS-PASTA-001"),
        ("Vollkornbrot", "Backwaren", "BLS-BREAD-001"),
    ]
    for title, main, expected_id in cases:
        assert _bls_match_id(title, main, tmp_path) == expected_id, title


def test_bls_skips_unsafe_or_complex_products(tmp_path: Path) -> None:
    # Brands / sweets / composites / variety bundles must stay unknown — better
    # no value than a fabricated one.
    nomatch = [
        ("Haribo Goldbären", "Süßwaren & Snacks"),
        ("Milka Alpenmilch Schokolade", "Süßwaren & Snacks"),
        ("Pringles Original", "Süßwaren & Snacks"),
        ("Fruchtjoghurt 500 g, Erdbeere", "Milchprodukte & Eier"),
        ("COCA-COLA oder FANTA", "Getränke alkoholfrei"),
        ("COMET Sirup Cola Zero", "Getränke alkoholfrei"),
        ("Tortelloni Big Pack 500 g, Ricotta-Spinat", "Grundnahrungsmittel"),
        ("Backfisch XXL 560 g", "Fisch & Meeresfrüchte"),
        ("Käse-Sortiment verschiedene Sorten", "Milchprodukte & Eier"),
    ]
    for title, main in nomatch:
        assert _bls_match_id(title, main, tmp_path) is None, title


def test_bls_category_gate_prevents_cross_category_matches(tmp_path: Path) -> None:
    # The category gate is the key safety net: "Apfelsaft" is a drink, NOT the
    # apple produce entry. A real apple in produce DOES match.
    assert _bls_match_id("Apfelsaft naturtrüb 1,0l", "Getränke alkoholfrei", tmp_path) != "BLS-APPLE-001"
    assert _bls_match_id("Frische Äpfel", "Obst & Gemüse", tmp_path) == "BLS-APPLE-001"
    # A juice still gets an honest *juice* estimate (Saft -> estimated).
    assert _bls_match_id("Apfelsaft naturtrüb 1,0l", "Getränke alkoholfrei", tmp_path) == "BLS-JUICE-001"
    # "MEGGLE Kräuter Butter" is mis-categorized as produce -> no butter match.
    assert _bls_match_id("MEGGLE Kräuter Butter", "Obst & Gemüse", tmp_path) is None


def test_bls_matched_entry_yields_estimated_nutrition_source(tmp_path: Path) -> None:
    # A BLS match always carries real per_100g values and feeds nutrition.source
    # = "bls" (which the backend maps to nutritionStatus "estimated", never
    # "verified" — that is reserved for OpenFoodFacts/barcode data).
    from aichef_offers.core import NutritionCache, load_bls, match_bls

    entries = load_bls(REPO_BLS_PATH)
    cache = NutritionCache(tmp_path / "c.sqlite")
    offer = {"title": "Frische Vollmilch 3,5%", "canonicalCategory": {"main": "Milchprodukte & Eier"}, "id": "m1"}
    entry, conf = match_bls(offer, entries, cache, "m1")
    assert entry is not None
    assert conf > 0.0
    assert entry["per_100g"]["kcal"] == 64
    # No entry in the reference table may claim to be an OpenFoodFacts source.
    assert all(e.get("source", "bls") != "openfoodfacts" for e in entries)


def test_eval_command_outputs(tmp_path: Path) -> None:
    input_dir = tmp_path / "data"
    out_dir = tmp_path / "out_eval"
    input_dir.mkdir(parents=True, exist_ok=True)
    download_bls(tmp_path / "bls")
    write_snapshot(
        input_dir / "snapshot.json",
        {
            "snapshotId": "10115",
            "offers": [
                {
                    "chain": "REWE",
                    "name": "Mandarinen",
                    "category": "Obst",
                    "validityStart": "2026-02-09",
                    "validityEnd": "2026-02-15",
                    "price": "1,99",
                    "size": "1 kg",
                },
                {
                    "chain": "PENNY",
                    "name": "Vodka Premium",
                    "category": "Getränke",
                    "validityStart": "2026-02-09",
                    "validityEnd": "2026-02-12",
                    "price": "5,99",
                    "size": "0.7 l",
                },
            ],
        },
    )
    config = build_default_config(tmp_path, input_dir, out_dir)
    run_eval(config)
    summary = (out_dir / "summary.md").read_text(encoding="utf-8")
    assert "WeekFlags distribution" in summary
    assert "Top 50 suspicious offers" in summary
    suspects = load_offers(out_dir / "category_suspects.json")
    assert isinstance(suspects, list)


def test_offer_availability_lock_and_unlock(tmp_path: Path) -> None:
    input_dir = tmp_path / "data"
    out_dir_locked = tmp_path / "out_locked"
    out_dir_locked_hidden = tmp_path / "out_locked_hidden"
    out_dir_unlocked = tmp_path / "out_unlocked"
    input_dir.mkdir(parents=True, exist_ok=True)
    download_bls(tmp_path / "bls")
    write_snapshot(
        input_dir / "snapshot.json",
        {
            "snapshotId": "10115",
            "offers": [
                {
                    "chain": "REWE",
                    "name": "Future Deal Joghurt",
                    "category": "Milchprodukte",
                    "validityStart": "2026-02-13T00:00:00Z",
                    "validityEnd": "2026-02-15T23:59:59Z",
                    "price": "1,29",
                    "size": "500 g",
                }
            ],
        },
    )

    locked_config = build_default_config(tmp_path, input_dir, out_dir_locked)
    locked_config.as_of = "2026-02-12"
    run_pipeline(locked_config)

    locked_all = load_offers(out_dir_locked / "all_in_week.json")
    locked_offer = find_offer(locked_all, "Future Deal Joghurt")
    assert locked_offer["offerAvailability"]["startDateLocal"] == "2026-02-13"
    assert locked_offer["offerAvailability"]["unlockDateLocal"] == "2026-02-13"
    assert locked_offer["offerAvailability"]["asOfDateLocal"] == "2026-02-12"
    assert locked_offer["offerAvailability"]["status"] == "locked"
    assert locked_offer["offerAvailability"]["lockedReason"] == "starts_in_future"

    visible_when_locked = load_offers(out_dir_locked / "visible_in_week.json")
    assert not any((offer.get("title") or offer.get("name")) == "Future Deal Joghurt" for offer in visible_when_locked)

    hidden_config = build_default_config(tmp_path, input_dir, out_dir_locked_hidden)
    hidden_config.as_of = "2026-02-12"
    hidden_config.include_locked = False
    run_pipeline(hidden_config)
    hidden_all = load_offers(out_dir_locked_hidden / "all_in_week.json")
    assert not any((offer.get("title") or offer.get("name")) == "Future Deal Joghurt" for offer in hidden_all)
    hidden_locked = load_offers(out_dir_locked_hidden / "flagged_locked.json")
    assert any((offer.get("title") or offer.get("name")) == "Future Deal Joghurt" for offer in hidden_locked)

    unlocked_config = build_default_config(tmp_path, input_dir, out_dir_unlocked)
    unlocked_config.as_of = "2026-02-13"
    run_pipeline(unlocked_config)
    unlocked_all = load_offers(out_dir_unlocked / "all_in_week.json")
    unlocked_offer = find_offer(unlocked_all, "Future Deal Joghurt")
    assert unlocked_offer["offerAvailability"]["status"] == "unlocked"
    assert unlocked_offer["offerAvailability"]["lockedReason"] is None


def test_nonfood_offers_are_never_unlocked(tmp_path: Path) -> None:
    input_dir = tmp_path / "data"
    out_dir = tmp_path / "out"
    input_dir.mkdir(parents=True, exist_ok=True)
    download_bls(tmp_path / "bls")
    write_snapshot(
        input_dir / "snapshot.json",
        {
            "snapshotId": "10115",
            "offers": [
                {
                    "chain": "Lidl",
                    "name": "Genius Obst-Gemüseschneider-Set Nicer Dicer Plus",
                    "category": "Küche",
                    "validityStart": "2026-02-09",
                    "validityEnd": "2026-02-15",
                    "price": "29,99",
                    "size": "1 Stk",
                },
                {
                    "chain": "Kaufland",
                    "name": "Switch On Smoothie Maker SSMK 300",
                    "category": "Elektro",
                    "validityStart": "2026-02-09",
                    "validityEnd": "2026-02-15",
                    "price": "19,99",
                    "size": "1 Stk",
                },
                {
                    "chain": "Netto Marken-Discount",
                    "name": "Nivea Körper-Feuchtigkeitspflege",
                    "category": "Drogerie",
                    "validityStart": "2026-02-09",
                    "validityEnd": "2026-02-15",
                    "price": "3,49",
                    "size": "250 ml",
                },
                {
                    "chain": "Kaufland",
                    "name": "K-Classic Hundenahrung Multi-Kroketten",
                    "category": "Tiernahrung",
                    "validityStart": "2026-02-09",
                    "validityEnd": "2026-02-15",
                    "price": "4,99",
                    "size": "3 kg",
                },
                {
                    "chain": "Aldi Nord",
                    "name": "Choceur Katzenzungen",
                    "category": "Süßwaren",
                    "validityStart": "2026-02-09",
                    "validityEnd": "2026-02-15",
                    "price": "1,49",
                    "size": "125 g",
                },
            ],
        },
    )

    config = build_default_config(tmp_path, input_dir, out_dir)
    config.as_of = "2026-02-12"
    run_pipeline(config)

    all_week = load_offers(out_dir / "all_in_week.json")
    visible_week = load_offers(out_dir / "visible_in_week.json")
    flagged_nonfood = load_offers(out_dir / "flagged_nonfood.json")
    flagged_locked = load_offers(out_dir / "flagged_locked.json")

    expected_titles = {
        "Genius Obst-Gemüseschneider-Set Nicer Dicer Plus",
        "Switch On Smoothie Maker SSMK 300",
        "Nivea Körper-Feuchtigkeitspflege",
        "K-Classic Hundenahrung Multi-Kroketten",
        "Choceur Katzenzungen",
    }

    for title in expected_titles:
        offer = find_offer(all_week, title)
        assert offer["foodFlag"] == "nonfood"
        assert offer["offerAvailability"]["status"] == "locked"
        assert offer["offerAvailability"]["lockedReason"] == "nonfood_blocked"

    assert not any((offer.get("title") or offer.get("name")) in expected_titles for offer in visible_week)
    assert expected_titles.issubset({(offer.get("title") or offer.get("name")) for offer in flagged_nonfood})
    assert expected_titles.issubset({(offer.get("title") or offer.get("name")) for offer in flagged_locked})


def test_live_filter_split_sonstiges_food_rescue_and_midweek_lock(tmp_path: Path) -> None:
    input_dir = tmp_path / "data"
    out_dir = tmp_path / "out"
    input_dir.mkdir(parents=True, exist_ok=True)
    download_bls(tmp_path / "bls")
    write_snapshot(
        input_dir / "snapshot.json",
        {
            "snapshotId": "10115",
            "offers": [
                {
                    "chain": "REWE",
                    "name": "Mio Mio Mate",
                    "category": "Sonstiges",
                    "validityStart": "2026-02-13",
                    "validityEnd": "2026-02-15",
                    "price": "1,29",
                    "size": "0.5 l",
                },
                {
                    "chain": "Lidl",
                    "name": "Gönrgy Energy Drink",
                    "category": "Sonstiges",
                    "validityStart": "2026-02-09",
                    "validityEnd": "2026-02-15",
                    "price": "0,89",
                    "size": "500 ml",
                },
                {
                    "chain": "Kaufland",
                    "name": "Lorenz Saltletts",
                    "category": "Sonstiges",
                    "validityStart": "2026-02-09",
                    "validityEnd": "2026-02-15",
                    "price": "1,99",
                    "size": "200 g",
                },
                {
                    "chain": "ALDI NORD",
                    "name": "Not M*lk Drink",
                    "category": "Sonstiges",
                    "validityStart": "2026-02-09",
                    "validityEnd": "2026-02-15",
                    "price": "1,49",
                    "size": "1 l",
                },
                {
                    "chain": "ALDI NORD",
                    "name": "Alkoholfrei Weiss",
                    "category": "Sonstiges",
                    "validityStart": "2026-02-09",
                    "validityEnd": "2026-02-15",
                    "price": "2,99",
                    "size": "0,75 l",
                },
                {
                    "chain": "Lidl",
                    "name": "Cafe Royal Kuechenrolle Crema",
                    "category": "Sonstiges",
                    "validityStart": "2026-02-09",
                    "validityEnd": "2026-02-15",
                    "price": "2,99",
                    "size": "3 Rollen",
                },
                {
                    "chain": "Netto Marken-Discount",
                    "name": "Dreistern Asiatische Spezialität",
                    "category": "Sonstiges",
                    "validityStart": "2026-02-09",
                    "validityEnd": "2026-02-15",
                    "price": "2,49",
                    "size": "400 g",
                },
                {
                    "chain": "EDEKA",
                    "name": "Nivea Handcreme Sensitive",
                    "category": "Drogerie",
                    "validityStart": "2026-02-09",
                    "validityEnd": "2026-02-15",
                    "price": "2,99",
                    "size": "75 ml",
                },
            ],
        },
    )

    config = build_default_config(tmp_path, input_dir, out_dir)
    config.as_of = "2026-02-12"
    run_pipeline(config)

    all_week = load_offers(out_dir / "all_in_week.json")
    visible_week = load_offers(out_dir / "visible_in_week.json")
    flagged_nonfood = load_offers(out_dir / "flagged_nonfood.json")

    mio = find_offer(all_week, "Mio Mio Mate")
    milk_alternative = find_offer(all_week, "Not M*lk Drink")
    alcohol_free_wine = find_offer(all_week, "Alkoholfrei Weiss")
    kitchen_roll = find_offer(all_week, "Cafe Royal Kuechenrolle Crema")
    gonrgy = find_offer(all_week, "Gönrgy Energy Drink")
    saltletts = find_offer(all_week, "Lorenz Saltletts")
    asian = find_offer(all_week, "Dreistern Asiatische Spezialität")
    handcreme = find_offer(all_week, "Nivea Handcreme Sensitive")

    assert mio["foodFlag"] == "food"
    assert mio["canonicalCategory"]["main"] == "Getränke alkoholfrei"
    assert mio["canonicalCategory"]["sub"] == "Mate"
    assert mio["offerAvailability"]["status"] == "locked"
    assert mio["offerAvailability"]["lockedReason"] == "starts_in_future"

    assert milk_alternative["foodFlag"] == "food"
    assert milk_alternative["canonicalCategory"]["main"] == "Milchprodukte & Eier"
    assert milk_alternative["canonicalCategory"]["sub"] == "Milch"

    assert alcohol_free_wine["foodFlag"] == "food"
    assert alcohol_free_wine["canonicalCategory"]["main"] == "Alkohol"
    assert alcohol_free_wine["canonicalCategory"]["sub"] == "Wein"

    assert kitchen_roll["foodFlag"] == "nonfood"
    assert kitchen_roll["offerAvailability"]["status"] == "locked"
    assert kitchen_roll["offerAvailability"]["lockedReason"] == "nonfood_blocked"

    assert gonrgy["foodFlag"] == "food"
    assert gonrgy["canonicalCategory"]["main"] == "Getränke alkoholfrei"
    assert gonrgy["canonicalCategory"]["sub"] == "Energy"

    assert saltletts["foodFlag"] == "food"
    assert saltletts["canonicalCategory"]["main"] == "Süßwaren & Snacks"
    assert saltletts["canonicalCategory"]["sub"] == "Cracker & Salzgebäck"

    assert asian["foodFlag"] == "food"
    assert asian["canonicalCategory"]["main"] == "Konserven & Fertiggerichte"
    assert asian["canonicalCategory"]["sub"] == "Fertiggerichte"

    assert handcreme["foodFlag"] == "nonfood"
    assert handcreme["offerAvailability"]["status"] == "locked"
    assert handcreme["offerAvailability"]["lockedReason"] == "nonfood_blocked"

    flagged_titles = {(offer.get("title") or offer.get("name")) for offer in flagged_nonfood}
    assert "Nivea Handcreme Sensitive" in flagged_titles
    assert "Mio Mio Mate" not in flagged_titles
    assert "Gönrgy Energy Drink" not in flagged_titles
    assert "Lorenz Saltletts" not in flagged_titles
    assert "Dreistern Asiatische Spezialität" not in flagged_titles

    assert "Not M*lk Drink" not in flagged_titles
    assert "Alkoholfrei Weiss" not in flagged_titles
    assert "Cafe Royal Kuechenrolle Crema" in flagged_titles

    visible_titles = {(offer.get("title") or offer.get("name")) for offer in visible_week}
    assert "Mio Mio Mate" not in visible_titles


def test_requested_nonfood_titles_are_filtered(tmp_path: Path) -> None:
    input_dir = tmp_path / "data"
    out_dir = tmp_path / "out"
    input_dir.mkdir(parents=True, exist_ok=True)
    download_bls(tmp_path / "bls")
    write_snapshot(
        input_dir / "snapshot.json",
        {
            "snapshotId": "10115",
            "offers": [
                {
                    "chain": "PENNY",
                    "name": "Alpina Universal Wohnfarbe",
                    "category": "Sonstiges",
                    "validityStart": "2026-02-09",
                    "validityEnd": "2026-02-15",
                    "price": "9,99",
                    "size": "1 l",
                },
                {
                    "chain": "PENNY",
                    "name": "Sunil Das Beste",
                    "category": "Sonstiges",
                    "validityStart": "2026-02-09",
                    "validityEnd": "2026-02-15",
                    "price": "4,99",
                    "size": "20 WL",
                },
                {
                    "chain": "Lidl",
                    "name": "SilverCrest Wasserglaeser-Set",
                    "category": "Haushalt",
                    "validityStart": "2026-02-09",
                    "validityEnd": "2026-02-15",
                    "price": "7,99",
                    "size": "6 Stk",
                },
                {
                    "chain": "Lidl",
                    "name": "Bertolli Olivenoel-Spray",
                    "category": "Sonstiges",
                    "validityStart": "2026-02-09",
                    "validityEnd": "2026-02-15",
                    "price": "3,99",
                    "size": "200 ml",
                },
            ],
        },
    )

    config = build_default_config(tmp_path, input_dir, out_dir)
    config.as_of = "2026-02-12"
    run_pipeline(config)

    all_week = load_offers(out_dir / "all_in_week.json")
    visible_week = load_offers(out_dir / "visible_in_week.json")
    flagged_nonfood = load_offers(out_dir / "flagged_nonfood.json")

    expected_titles = {
        "Alpina Universal Wohnfarbe",
        "Sunil Das Beste",
        "SilverCrest Wasserglaeser-Set",
        "Bertolli Olivenoel-Spray",
    }

    for title in expected_titles:
        offer = find_offer(all_week, title)
        assert offer["foodFlag"] == "nonfood"
        assert offer["offerAvailability"]["status"] == "locked"
        assert offer["offerAvailability"]["lockedReason"] == "nonfood_blocked"

    visible_titles = {(offer.get("title") or offer.get("name")) for offer in visible_week}
    assert expected_titles.isdisjoint(visible_titles)
    flagged_titles = {(offer.get("title") or offer.get("name")) for offer in flagged_nonfood}
    assert expected_titles.issubset(flagged_titles)


def test_coffee_and_tea_brand_offers_are_not_filtered_as_nonfood(tmp_path: Path) -> None:
    input_dir = tmp_path / "data"
    out_dir = tmp_path / "out"
    input_dir.mkdir(parents=True, exist_ok=True)
    download_bls(tmp_path / "bls")
    write_snapshot(
        input_dir / "snapshot.json",
        {
            "snapshotId": "10115",
            "offers": [
                {
                    "chain": "PENNY",
                    "name": "DALLMAYR Home Barista Caffe Crema",
                    "category": "Sonstiges",
                    "validityStart": "2026-02-09",
                    "validityEnd": "2026-02-15",
                    "price": "9,99",
                    "size": "1 kg",
                },
                {
                    "chain": "PENNY",
                    "name": "LAVAZZA Caffe Crema",
                    "category": "Sonstiges",
                    "validityStart": "2026-02-09",
                    "validityEnd": "2026-02-15",
                    "price": "8,99",
                    "size": "1 kg",
                },
                {
                    "chain": "PENNY",
                    "name": "LIPTON Sensations Tee",
                    "category": "Sonstiges",
                    "validityStart": "2026-02-09",
                    "validityEnd": "2026-02-15",
                    "price": "1,49",
                    "size": "20 Beutel",
                },
            ],
        },
    )

    config = build_default_config(tmp_path, input_dir, out_dir)
    config.as_of = "2026-02-12"
    run_pipeline(config)

    all_week = load_offers(out_dir / "all_in_week.json")
    visible_week = load_offers(out_dir / "visible_in_week.json")
    flagged_nonfood = load_offers(out_dir / "flagged_nonfood.json")

    names = {
        "DALLMAYR Home Barista Caffe Crema",
        "LAVAZZA Caffe Crema",
        "LIPTON Sensations Tee",
    }

    for name in names:
        offer = find_offer(all_week, name)
        assert offer["foodFlag"] == "food"
        assert offer["canonicalCategory"]["main"] == "Getr\u00e4nke alkoholfrei"
        assert offer["canonicalCategory"]["sub"] == "Kaffee & Tee"
        assert offer["offerAvailability"]["lockedReason"] != "nonfood_blocked"

    visible_titles = {(offer.get("title") or offer.get("name")) for offer in visible_week}
    assert names.issubset(visible_titles)

    flagged_titles = {(offer.get("title") or offer.get("name")) for offer in flagged_nonfood}
    assert names.isdisjoint(flagged_titles)


def test_smoker_box_is_nonfood_filtered(tmp_path: Path) -> None:
    input_dir = tmp_path / "data"
    out_dir = tmp_path / "out"
    input_dir.mkdir(parents=True, exist_ok=True)
    download_bls(tmp_path / "bls")
    write_snapshot(
        input_dir / "snapshot.json",
        {
            "snapshotId": "10115",
            "offers": [
                {
                    "id": "mg_smoker_box",
                    "chain": "Netto Marken-Discount",
                    "name": "thisisnobrand123 Smoker Box",
                    "category": "Fleisch",
                    "validityStart": "2026-02-09",
                    "validityEnd": "2026-02-15",
                    "price": "6,99",
                    "size": "4.5 kg",
                }
            ],
        },
    )

    config = build_default_config(tmp_path, input_dir, out_dir)
    config.as_of = "2026-02-12"
    run_pipeline(config)

    all_week = load_offers(out_dir / "all_in_week.json")
    visible_week = load_offers(out_dir / "visible_in_week.json")
    flagged_nonfood = load_offers(out_dir / "flagged_nonfood.json")
    smoker = find_offer(all_week, "thisisnobrand123 Smoker Box")

    assert smoker["foodFlag"] == "nonfood"
    assert smoker["offerAvailability"]["status"] == "locked"
    assert smoker["offerAvailability"]["lockedReason"] == "nonfood_blocked"
    assert not any((offer.get("title") or offer.get("name")) == "thisisnobrand123 Smoker Box" for offer in visible_week)
    assert any((offer.get("title") or offer.get("name")) == "thisisnobrand123 Smoker Box" for offer in flagged_nonfood)


def test_food_cremes_are_not_filtered_as_nonfood(tmp_path: Path) -> None:
    input_dir = tmp_path / "data"
    out_dir = tmp_path / "out"
    input_dir.mkdir(parents=True, exist_ok=True)
    download_bls(tmp_path / "bls")
    write_snapshot(
        input_dir / "snapshot.json",
        {
            "snapshotId": "10115",
            "offers": [
                {
                    "chain": "REWE",
                    "name": "Ferrero Nutella Nuss-Nougat-Creme XXL",
                    "category": "Sonstiges",
                    "validityStart": "2026-02-09",
                    "validityEnd": "2026-02-15",
                    "price": "4,99",
                    "size": "750 g",
                },
                {
                    "chain": "Lidl",
                    "name": "Milsani Creme Noblesse",
                    "category": "Sonstiges",
                    "validityStart": "2026-02-09",
                    "validityEnd": "2026-02-15",
                    "price": "1,49",
                    "size": "200 g",
                },
                {
                    "chain": "Lidl",
                    "name": "Cucina Süße Creme",
                    "category": "Sonstiges",
                    "validityStart": "2026-02-09",
                    "validityEnd": "2026-02-15",
                    "price": "1,29",
                    "size": "250 g",
                },
                {
                    "chain": "PENNY",
                    "name": "Dr. Oetker Paradies Creme",
                    "category": "Sonstiges",
                    "validityStart": "2026-02-09",
                    "validityEnd": "2026-02-15",
                    "price": "0,99",
                    "size": "57 g",
                },
            ],
        },
    )

    config = build_default_config(tmp_path, input_dir, out_dir)
    config.as_of = "2026-02-12"
    run_pipeline(config)

    all_week = load_offers(out_dir / "all_in_week.json")
    visible_week = load_offers(out_dir / "visible_in_week.json")
    flagged_nonfood = load_offers(out_dir / "flagged_nonfood.json")

    names = [
        "Ferrero Nutella Nuss-Nougat-Creme XXL",
        "Milsani Creme Noblesse",
        "Cucina Süße Creme",
        "Dr. Oetker Paradies Creme",
    ]
    for name in names:
        offer = find_offer(all_week, name)
        assert offer["foodFlag"] != "nonfood"
        assert offer["offerAvailability"]["lockedReason"] != "nonfood_blocked"

    flagged_titles = {(offer.get("title") or offer.get("name")) for offer in flagged_nonfood}
    for name in names:
        assert name not in flagged_titles
    visible_titles = {(offer.get("title") or offer.get("name")) for offer in visible_week}
    for name in names:
        assert name in visible_titles


def test_user_reported_live_nonfood_items_are_filtered(tmp_path: Path) -> None:
    input_dir = tmp_path / "data"
    out_dir = tmp_path / "out"
    input_dir.mkdir(parents=True, exist_ok=True)
    download_bls(tmp_path / "bls")
    write_snapshot(
        input_dir / "snapshot.json",
        {
            "snapshotId": "10115",
            "offers": [
                {
                    "id": "mg_21620211",
                    "chain": "Kaufland",
                    "name": "Good Boy Hundesnacks",
                    "category": "Sonstiges",
                    "validityStart": "2026-02-12",
                    "validityEnd": "2026-02-18",
                },
                {
                    "id": "mg_21620073",
                    "chain": "Kaufland",
                    "name": "Oral-B Zahncreme",
                    "category": "Sonstiges",
                    "validityStart": "2026-02-12",
                    "validityEnd": "2026-02-18",
                },
                {
                    "id": "mg_21625476",
                    "chain": "Kaufland",
                    "name": "Parkside Maler-Acryl Express",
                    "category": "Sonstiges",
                    "validityStart": "2026-02-12",
                    "validityEnd": "2026-02-18",
                },
                {
                    "id": "mg_21592335",
                    "chain": "nahkauf",
                    "name": "Die Thüringer Thüringer Stifte",
                    "category": "Sonstiges",
                    "validityStart": "2026-02-09",
                    "validityEnd": "2026-02-14",
                },
                {
                    "id": "mg_21621948",
                    "chain": "Netto Marken-Discount",
                    "name": "Garten Magie Hornspäne",
                    "category": "Sonstiges",
                    "validityStart": "2026-02-12",
                    "validityEnd": "2026-02-14",
                },
                {
                    "id": "mg_21605442",
                    "chain": "Netto Marken-Discount",
                    "name": "Softlan Weichspüler",
                    "category": "Sonstiges",
                    "validityStart": "2026-02-09",
                    "validityEnd": "2026-02-14",
                },
                {
                    "id": "mg_21686706",
                    "chain": "PENNY",
                    "name": "Sensodyne Zahncreme",
                    "category": "Sonstiges",
                    "validityStart": "2026-02-12",
                    "validityEnd": "2026-02-14",
                },
                {
                    "id": "mg_21609597",
                    "chain": "REWE",
                    "name": "Sensodyne Sensitiv Fluorid Zahncreme",
                    "category": "Sonstiges",
                    "validityStart": "2026-02-09",
                    "validityEnd": "2026-02-14",
                },
            ],
        },
    )

    config = build_default_config(tmp_path, input_dir, out_dir)
    config.as_of = "2026-02-12"
    run_pipeline(config)

    all_week = load_offers(out_dir / "all_in_week.json")
    visible_week = load_offers(out_dir / "visible_in_week.json")
    flagged_nonfood = load_offers(out_dir / "flagged_nonfood.json")

    expected_titles = {
        "Good Boy Hundesnacks",
        "Oral-B Zahncreme",
        "Parkside Maler-Acryl Express",
        "Die Thüringer Thüringer Stifte",
        "Garten Magie Hornspäne",
        "Softlan Weichspüler",
        "Sensodyne Zahncreme",
        "Sensodyne Sensitiv Fluorid Zahncreme",
    }

    for title in expected_titles:
        offer = find_offer(all_week, title)
        assert offer["foodFlag"] == "nonfood"
        assert offer["offerAvailability"]["status"] == "locked"
        assert offer["offerAvailability"]["lockedReason"] == "nonfood_blocked"

    visible_titles = {(offer.get("title") or offer.get("name")) for offer in visible_week}
    assert expected_titles.isdisjoint(visible_titles)

    flagged_titles = {(offer.get("title") or offer.get("name")) for offer in flagged_nonfood}
    assert expected_titles.issubset(flagged_titles)


def test_food_rescue_respects_word_boundaries() -> None:
    """REWE-Shop-Prompt: der Getränke-/Snack-Rescue darf NICHT auf
    Wortbestandteile innerhalb von Obst-/Gemüse-Namen feuern ('mate' in
    'Tomate', 'nektar' in 'Nektarine'), echte Getränke/Snacks aber weiter retten.
    """
    from aichef_offers.core import detect_food_rescue

    # Obst/Gemüse darf NICHT zum Getränk werden:
    assert detect_food_rescue({"title": "Rispentomaten", "category": "Obst und Gemüse"}) is None
    assert detect_food_rescue({"title": "Gelbfleischige Nektarinen", "category": "Obst und Gemüse"}) is None

    # Echte Getränke/Snacks werden weiter gerettet (Kompositum-Kopf + Flexion):
    apfelsaft = detect_food_rescue({"title": "Apfelsaft naturtrüb"})
    assert apfelsaft is not None and apfelsaft[0] == "Getränke alkoholfrei"

    nektar = detect_food_rescue({"title": "Pfirsich Nektar"})
    assert nektar is not None and nektar[0] == "Getränke alkoholfrei"

    haferdrink = detect_food_rescue({"title": "Oatly Haferdrink Barista"})
    assert haferdrink is not None and haferdrink[0] == "Milchprodukte & Eier"

    pralinen = detect_food_rescue({"title": "Lindt Pralinen"})
    assert pralinen is not None and pralinen[0] == "Süßwaren & Snacks"

    chips = detect_food_rescue({"title": "Kartoffelchips Paprika"})
    assert chips is not None and chips[0] == "Süßwaren & Snacks"


def test_detect_food_rescue_brand_alone_does_not_rescue_ambiguous_name() -> None:
    """Task P3: eine Kaffee-/Tee-MARKE allein darf einen mehrdeutigen Kurznamen
    ("Gold"/"Auslese"/"Sensations") NICHT als Food retten. Erst ein unabhängiger
    struktureller Beleg (Zubereitungs-Deskriptor ODER Kaffee-/Tee-Abteilung in
    Kategorie/Department) macht das Angebot zu Food."""
    from aichef_offers.core import detect_food_rescue

    # Marke allein, neutrale Quelle → KEIN Rescue:
    assert detect_food_rescue({"title": "Gold", "brand": "Jacobs", "category": "Sonstiges"}) is None
    assert (
        detect_food_rescue({"title": "Auslese", "brand": "Melitta", "category": "Sonstiges"}) is None
    )
    assert detect_food_rescue({"title": "Sensations", "brand": "Lipton"}) is None

    # Marke + konkreter Zubereitungs-Deskriptor → Rescue zu Kaffee & Tee:
    gemahlen = detect_food_rescue({"title": "Jacobs Gold gemahlen"})
    assert gemahlen is not None and gemahlen[:2] == ("Getränke alkoholfrei", "Kaffee & Tee")
    pads = detect_food_rescue({"title": "Melitta Auslese Pads"})
    assert pads is not None and pads[:2] == ("Getränke alkoholfrei", "Kaffee & Tee")

    # Marke + Kaffee-/Tee-Abteilung (Deskriptor in Kategorie) → Rescue:
    dept = detect_food_rescue({"title": "Jacobs Gold", "category": "Kaffee & Tee"})
    assert dept is not None and dept[:2] == ("Getränke alkoholfrei", "Kaffee & Tee")

    # Generische Deskriptoren ohne Marke retten weiterhin (Produktbeschreibung):
    crema = detect_food_rescue({"title": "Caffe Crema ganze Bohne"})
    assert crema is not None and crema[0] == "Getränke alkoholfrei"
