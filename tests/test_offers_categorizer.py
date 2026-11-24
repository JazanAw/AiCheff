from __future__ import annotations

import json
import shutil
from datetime import datetime
from pathlib import Path

from offers_categorizer.core import BERLIN_TZ, run_pipeline


FIXTURE_DIR = Path(__file__).parent / "fixtures_categorizer"
GOLDEN_FIXTURE_DIR = Path(__file__).parent / "fixtures_categorizer_golden"


def copy_fixtures(target_dir: Path) -> None:
    for path in FIXTURE_DIR.glob("*.json"):
        shutil.copy(path, target_dir / path.name)


def copy_golden_fixtures(target_dir: Path) -> None:
    for path in GOLDEN_FIXTURE_DIR.glob("*.json"):
        shutil.copy(path, target_dir / path.name)


def load_output(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def offers_by_name(payload: dict) -> dict[str, dict]:
    result: dict[str, dict] = {}
    for offer in payload.get("offers", []):
        name = offer.get("title") or offer.get("name") or ""
        if name:
            result[name] = offer
    return result


def test_rule_classification_and_nonfood_detection(tmp_path: Path) -> None:
    input_dir = tmp_path / "data"
    out_dir = tmp_path / "out"
    input_dir.mkdir()
    copy_fixtures(input_dir)

    run_pipeline(
        input_dir=input_dir,
        out_dir=out_dir,
        mode="overlap",
        ollama_mode="off",
        model="llama3.1",
        ollama_host="http://localhost:11434",
        week_start_iso="2026-02-09",
        week_window_mode="calendar",
        week_end_day=None,
        min_rule_score=3.0,
        use_llm_threshold=0.72,
        dump_stats=True,
        now=datetime(2026, 2, 11, 10, 0, tzinfo=BERLIN_TZ),
    )

    payload = load_output(out_dir / "categorized_offers.json")
    offers = offers_by_name(payload)

    assert offers["Rinderhack 500g"]["canonicalCategory"]["main"] == "Fleisch & Wurst"
    assert offers["Rinderhack 500g"]["canonicalCategory"]["sub"] == "Hack"

    assert offers["Gouda jung"]["canonicalCategory"]["main"] == "Milchprodukte & Eier"
    assert offers["Gouda jung"]["canonicalCategory"]["sub"] == "Käse"

    assert offers["Floralys Küchenrolle XXL"]["canonicalCategory"]["main"] == "Non-Food"
    assert offers["Floralys Küchenrolle XXL"]["canonicalCategory"]["isNonFood"] is True

    assert offers["Nivea Handcreme Sensitive"]["canonicalCategory"]["main"] == "Non-Food"
    assert offers["Nivea Handcreme Sensitive"]["canonicalCategory"]["sub"] == "Körperpflege"

    assert offers["Rumkugeln Pralinen Mix"]["canonicalCategory"]["main"] == "Süßwaren & Snacks"
    assert offers["Rumkugeln Pralinen Mix"]["canonicalCategory"]["sub"] == "Schokolade & Pralinen"

    assert offers["Vodka Premium 37,5%"]["canonicalCategory"]["main"] == "Alkohol"
    assert offers["Vodka Premium 37,5%"]["canonicalCategory"]["sub"] == "Spirituosen"


def test_current_live_nonfood_leaks_are_blocked(tmp_path: Path) -> None:
    input_dir = tmp_path / "data"
    out_dir = tmp_path / "out"
    input_dir.mkdir()
    payload = {
        "snapshotId": "10115",
        "offers": [
            {"chain": "ALDI NORD", "name": "Tomaten-Ampel", "category": "Obst & Gemuese", "validityStart": "2026-02-09", "validityEnd": "2026-02-15", "price": "4,49", "size": "pflanze"},
            {"chain": "ALDI NORD", "name": "Torffreie Erde", "category": "Sonstiges", "validityStart": "2026-02-09", "validityEnd": "2026-02-15", "price": "1,99", "size": "16 l"},
            {"chain": "ALDI SUED", "name": "Unterwasser Handstaubsauger", "category": "Sonstiges", "validityStart": "2026-02-09", "validityEnd": "2026-02-15", "price": "34,99", "size": "1 Stk"},
            {"chain": "Kaufland", "name": "SILVERCREST Nudelmaschine", "category": "Trockenware", "validityStart": "2026-02-09", "validityEnd": "2026-02-15", "price": "9,99", "size": "1 Stk"},
            {"chain": "Kaufland", "name": "SPICE&SOUL Thermoglaser fuer Tee", "category": "Getraenke", "validityStart": "2026-02-09", "validityEnd": "2026-02-15", "price": "4,99", "size": "2 Stk"},
            {"chain": "PENNY", "name": "FINISH Klarspuler", "category": "Sonstiges", "validityStart": "2026-02-09", "validityEnd": "2026-02-15", "price": "3,99", "size": "800 ml"},
            {"chain": "ALDI NORD", "name": "Kraft-Gel Universal", "brand": "PERSIL", "category": "Sonstiges", "validityStart": "2026-02-09", "validityEnd": "2026-02-15", "price": "4,99", "size": "900 ml"},
            {"chain": "ALDI NORD", "name": "Waschpulver Color", "brand": "PERSIL", "category": "Sonstiges", "validityStart": "2026-02-09", "validityEnd": "2026-02-15", "price": "4,99", "size": "1,26 kg"},
            {"chain": "ALDI SUED", "name": "Sonnencreme Ultra Sensitive LSF50 75ml", "brand": "LACURA", "category": "Sonstiges", "validityStart": "2026-02-09", "validityEnd": "2026-02-15", "price": "2,49", "size": "75 ml"},
            {"chain": "Kaufland", "name": "DOVE Duschcreme Advanced Care", "category": "Sonstiges", "validityStart": "2026-02-09", "validityEnd": "2026-02-15", "price": "2,49", "size": "225 ml"},
            {"chain": "Kaufland", "name": "SILVERCREST Fruchtsaftkrug", "category": "Sonstiges", "validityStart": "2026-02-09", "validityEnd": "2026-02-15", "price": "6,99", "size": "1 Stk"},
            {"chain": "Kaufland", "name": "LENOR Waescheparfuem", "category": "Sonstiges", "validityStart": "2026-02-09", "validityEnd": "2026-02-15", "price": "5,99", "size": "280 g"},
            {"chain": "Lidl", "name": "Dundalgan Single Malt IPA Cask Finish Irish Whiskey 42% vol", "category": "Alkohol", "validityStart": "2026-02-09", "validityEnd": "2026-02-15", "price": "15,99", "size": "1 Stk"},
        ],
    }
    (input_dir / "snapshot.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    run_pipeline(
        input_dir=input_dir,
        out_dir=out_dir,
        mode="overlap",
        ollama_mode="off",
        model="llama3.1",
        ollama_host="http://localhost:11434",
        week_start_iso="2026-02-09",
        week_window_mode="calendar",
        week_end_day=None,
        min_rule_score=3.0,
        use_llm_threshold=0.72,
        dump_stats=False,
    )

    offers = offers_by_name(load_output(out_dir / "categorized_offers.json"))
    for name in [
        "Tomaten-Ampel",
        "Torffreie Erde",
        "Unterwasser Handstaubsauger",
        "SILVERCREST Nudelmaschine",
        "SPICE&SOUL Thermoglaser fuer Tee",
        "FINISH Klarspuler",
        "Kraft-Gel Universal",
        "Waschpulver Color",
        "Sonnencreme Ultra Sensitive LSF50 75ml",
        "DOVE Duschcreme Advanced Care",
        "SILVERCREST Fruchtsaftkrug",
        "LENOR Waescheparfuem",
    ]:
        assert offers[name]["canonicalCategory"]["main"] == "Non-Food"
        assert offers[name]["canonicalCategory"]["isNonFood"] is True

    assert offers["Dundalgan Single Malt IPA Cask Finish Irish Whiskey 42% vol"]["canonicalCategory"]["main"] == "Alkohol"


def test_week_flags_overlap_and_starts_mode(tmp_path: Path) -> None:
    input_dir = tmp_path / "data"
    out_overlap = tmp_path / "out_overlap"
    out_starts = tmp_path / "out_starts"
    input_dir.mkdir()
    copy_fixtures(input_dir)

    run_pipeline(
        input_dir=input_dir,
        out_dir=out_overlap,
        mode="overlap",
        ollama_mode="off",
        model="llama3.1",
        ollama_host="http://localhost:11434",
        week_start_iso="2026-02-09",
        week_window_mode="calendar",
        week_end_day=None,
        min_rule_score=3.0,
        use_llm_threshold=0.72,
        dump_stats=False,
    )

    run_pipeline(
        input_dir=input_dir,
        out_dir=out_starts,
        mode="starts",
        ollama_mode="off",
        model="llama3.1",
        ollama_host="http://localhost:11434",
        week_start_iso="2026-02-09",
        week_window_mode="calendar",
        week_end_day=None,
        min_rule_score=3.0,
        use_llm_threshold=0.72,
        dump_stats=False,
    )

    overlap_offers = offers_by_name(load_output(out_overlap / "categorized_offers.json"))
    starts_offers = offers_by_name(load_output(out_starts / "categorized_offers.json"))

    weekend = overlap_offers["Weekend Deal Pasta"]["weekFlags"]
    assert weekend["inWeek"] is True
    assert weekend["startsMidweek"] is True
    assert weekend["endsMidweek"] is False
    assert weekend["endsBeforeWeekEnd"] is True
    assert weekend["partialWeek"] is True

    long_overlap = overlap_offers["Dauerangebot Olivenöl"]["weekFlags"]
    long_starts = starts_offers["Dauerangebot Olivenöl"]["weekFlags"]
    assert long_overlap["inWeek"] is True
    assert long_starts["inWeek"] is False


def test_summary_and_review_outputs_exist(tmp_path: Path) -> None:
    input_dir = tmp_path / "data"
    out_dir = tmp_path / "out"
    input_dir.mkdir()
    copy_fixtures(input_dir)

    run_pipeline(
        input_dir=input_dir,
        out_dir=out_dir,
        mode="overlap",
        ollama_mode="off",
        model="llama3.1",
        ollama_host="http://localhost:11434",
        week_start_iso="2026-02-09",
        week_window_mode="calendar",
        week_end_day=None,
        min_rule_score=3.0,
        use_llm_threshold=0.72,
        dump_stats=True,
    )

    summary = (out_dir / "summary.md").read_text(encoding="utf-8")
    assert "Counts by main" in summary
    assert "unknown_sub_percent" in summary

    review = load_output(out_dir / "review_needed.json")
    assert "offers" in review

    stats = load_output(out_dir / "stats.json")
    assert stats["input_files"] == 3
    assert stats["unique_offers"] >= 7


def test_week_window_calendar_vs_retail_and_end_flags(tmp_path: Path) -> None:
    input_dir = tmp_path / "data"
    out_calendar = tmp_path / "out_calendar"
    out_retail = tmp_path / "out_retail"
    out_override = tmp_path / "out_override"
    input_dir.mkdir()
    payload = {
        "snapshotId": "10115",
        "offers": [
            {
                "storeChain": "REWE",
                "name": "Samstagsdeal Tomaten",
                "category": "Obst & Gemüse",
                "validityStart": "2026-02-09",
                "validityEnd": "2026-02-14",
                "price": "1,99",
                "unit": "1kg",
            },
            {
                "storeChain": "REWE",
                "name": "Donnerstagsdeal Quark",
                "category": "Milchprodukte",
                "validityStart": "2026-02-09",
                "validityEnd": "2026-02-12",
                "price": "0,99",
                "unit": "250g",
            },
        ],
    }
    (input_dir / "snapshot.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    run_pipeline(
        input_dir=input_dir,
        out_dir=out_calendar,
        mode="overlap",
        ollama_mode="off",
        model="llama3.1",
        ollama_host="http://localhost:11434",
        week_start_iso="2026-02-09",
        week_window_mode="calendar",
        week_end_day=None,
        min_rule_score=3.0,
        use_llm_threshold=0.72,
        dump_stats=False,
    )
    run_pipeline(
        input_dir=input_dir,
        out_dir=out_retail,
        mode="overlap",
        ollama_mode="off",
        model="llama3.1",
        ollama_host="http://localhost:11434",
        week_start_iso="2026-02-09",
        week_window_mode="retail",
        week_end_day=None,
        min_rule_score=3.0,
        use_llm_threshold=0.72,
        dump_stats=False,
    )
    run_pipeline(
        input_dir=input_dir,
        out_dir=out_override,
        mode="overlap",
        ollama_mode="off",
        model="llama3.1",
        ollama_host="http://localhost:11434",
        week_start_iso="2026-02-09",
        week_window_mode="calendar",
        week_end_day="sat",
        min_rule_score=3.0,
        use_llm_threshold=0.72,
        dump_stats=False,
    )

    cal = offers_by_name(load_output(out_calendar / "categorized_offers.json"))
    ret = offers_by_name(load_output(out_retail / "categorized_offers.json"))
    over = offers_by_name(load_output(out_override / "categorized_offers.json"))

    sat_cal = cal["Samstagsdeal Tomaten"]["weekFlags"]
    sat_ret = ret["Samstagsdeal Tomaten"]["weekFlags"]
    thu_cal = cal["Donnerstagsdeal Quark"]["weekFlags"]

    assert sat_cal["endsMidweek"] is False
    assert sat_cal["endsBeforeWeekEnd"] is True
    assert sat_cal["partialWeek"] is True

    assert sat_ret["endsMidweek"] is False
    assert sat_ret["endsBeforeWeekEnd"] is False
    assert sat_ret["partialWeek"] is False
    assert over["Samstagsdeal Tomaten"]["weekFlags"]["endsBeforeWeekEnd"] is False

    assert thu_cal["endsMidweek"] is True
    assert thu_cal["endsBeforeWeekEnd"] is True
    assert thu_cal["partialWeek"] is True


def test_category_priority_and_halal_annotations(tmp_path: Path) -> None:
    input_dir = tmp_path / "data"
    out_dir = tmp_path / "out"
    input_dir.mkdir()
    payload = {
        "snapshotId": "10115",
        "offers": [
            {
                "storeChain": "REWE",
                "name": "Melitta BellaCrema La Crema",
                "category": "Getränke",
                "validityStart": "2026-02-09",
                "validityEnd": "2026-02-15",
                "price": "9,99",
                "unit": "1kg",
            },
            {
                "storeChain": "Lidl",
                "name": "Cucina Pasta-Sauce Napoli",
                "category": "Obst & Gemüse",
                "validityStart": "2026-02-09",
                "validityEnd": "2026-02-15",
                "price": "1,49",
                "unit": "500ml",
            },
            {
                "storeChain": "Kaufland",
                "name": "Knorr Salatkrönung Italienisch",
                "category": "Obst & Gemüse",
                "validityStart": "2026-02-09",
                "validityEnd": "2026-02-15",
                "price": "0,99",
                "unit": "5x8g",
            },
            {
                "storeChain": "PENNY",
                "name": "Premium Bier Dose",
                "category": "Getränke",
                "validityStart": "2026-02-09",
                "validityEnd": "2026-02-15",
                "price": "0,89",
                "unit": "500ml",
            },
            {
                "storeChain": "EDEKA",
                "name": "Veggie Aufstrich Mediterran",
                "category": "Feinkost",
                "tags": ["vegan"],
                "validityStart": "2026-02-09",
                "validityEnd": "2026-02-15",
                "price": "1,99",
                "unit": "180g",
            },
        ],
    }
    (input_dir / "snapshot.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    run_pipeline(
        input_dir=input_dir,
        out_dir=out_dir,
        mode="overlap",
        ollama_mode="off",
        model="llama3.1",
        ollama_host="http://localhost:11434",
        week_start_iso="2026-02-09",
        week_window_mode="calendar",
        week_end_day=None,
        min_rule_score=3.0,
        use_llm_threshold=0.72,
        dump_stats=False,
    )

    offers = offers_by_name(load_output(out_dir / "categorized_offers.json"))

    melitta = offers["Melitta BellaCrema La Crema"]["canonicalCategory"]
    assert melitta["main"] == "Grundnahrungsmittel"
    assert melitta["sub"] == "Kaffee & Tee"

    cucina = offers["Cucina Pasta-Sauce Napoli"]["canonicalCategory"]
    assert cucina["main"] == "Gewürze/Saucen/Aufstriche"
    assert cucina["sub"] == "Saucen & Dressings"

    knorr = offers["Knorr Salatkrönung Italienisch"]["canonicalCategory"]
    assert knorr["main"] == "Gewürze/Saucen/Aufstriche"
    assert knorr["sub"] == "Saucen & Dressings"

    bier = offers["Premium Bier Dose"]["canonicalCategory"]
    assert bier["halal"]["status"] == "not_halal"

    vegan = offers["Veggie Aufstrich Mediterran"]["canonicalCategory"]
    assert vegan["halal"]["status"] == "likely_halal"
    assert "user_rule: vegan/vegetarisch => likely_halal" in vegan["halal"]["reasons"]


def test_sonstiges_food_rescue_rules(tmp_path: Path) -> None:
    input_dir = tmp_path / "data"
    out_dir = tmp_path / "out"
    input_dir.mkdir()
    payload = {
        "snapshotId": "10115",
        "offers": [
            {
                "storeChain": "REWE",
                "name": "Mio Mio Mate",
                "category": "Sonstiges",
                "validityStart": "2026-02-09",
                "validityEnd": "2026-02-15",
                "price": "1,29",
                "unit": "0.5 l",
            },
            {
                "storeChain": "Lidl",
                "name": "Gönrgy Energy Drink",
                "category": "Sonstiges",
                "validityStart": "2026-02-09",
                "validityEnd": "2026-02-15",
                "price": "0,89",
                "unit": "500 ml",
            },
            {
                "storeChain": "Kaufland",
                "name": "Lorenz Saltletts",
                "category": "Sonstiges",
                "validityStart": "2026-02-09",
                "validityEnd": "2026-02-15",
                "price": "1,99",
                "unit": "200 g",
            },
            {
                "storeChain": "Netto Marken-Discount",
                "name": "Dreistern Asiatische Spezialität",
                "category": "Sonstiges",
                "validityStart": "2026-02-09",
                "validityEnd": "2026-02-15",
                "price": "2,49",
                "unit": "400 g",
            },
            {
                "storeChain": "ALDI NORD",
                "name": "Not M*lk Drink",
                "category": "Sonstiges",
                "validityStart": "2026-02-09",
                "validityEnd": "2026-02-15",
                "price": "1,49",
                "unit": "1 l",
            },
            {
                "storeChain": "ALDI NORD",
                "name": "Alkoholfrei Weiss",
                "category": "Sonstiges",
                "validityStart": "2026-02-09",
                "validityEnd": "2026-02-15",
                "price": "2,99",
                "unit": "0,75 l",
            },
            {
                "storeChain": "Lidl",
                "name": "Cafe Royal Kuechenrolle Crema",
                "category": "Sonstiges",
                "validityStart": "2026-02-09",
                "validityEnd": "2026-02-15",
                "price": "2,99",
                "unit": "3 Rollen",
            },
            {
                "storeChain": "EDEKA",
                "name": "Nivea Handcreme Sensitive",
                "category": "Drogerie",
                "validityStart": "2026-02-09",
                "validityEnd": "2026-02-15",
                "price": "2,99",
                "unit": "75 ml",
            },
        ],
    }
    (input_dir / "snapshot.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    run_pipeline(
        input_dir=input_dir,
        out_dir=out_dir,
        mode="overlap",
        ollama_mode="off",
        model="llama3.1",
        ollama_host="http://localhost:11434",
        week_start_iso="2026-02-09",
        week_window_mode="calendar",
        week_end_day=None,
        min_rule_score=3.0,
        use_llm_threshold=0.72,
        dump_stats=False,
    )

    offers = offers_by_name(load_output(out_dir / "categorized_offers.json"))
    mio = offers["Mio Mio Mate"]["canonicalCategory"]
    gonrgy = offers["Gönrgy Energy Drink"]["canonicalCategory"]
    saltletts = offers["Lorenz Saltletts"]["canonicalCategory"]
    asian = offers["Dreistern Asiatische Spezialität"]["canonicalCategory"]
    milk_alternative = offers["Not M*lk Drink"]["canonicalCategory"]
    alcohol_free_wine = offers["Alkoholfrei Weiss"]["canonicalCategory"]
    kitchen_roll = offers["Cafe Royal Kuechenrolle Crema"]["canonicalCategory"]
    handcreme = offers["Nivea Handcreme Sensitive"]["canonicalCategory"]

    assert mio["main"] == "Getränke alkoholfrei"
    assert mio["sub"] == "Mate"
    assert mio["isNonFood"] is False

    assert gonrgy["main"] == "Getränke alkoholfrei"
    assert gonrgy["sub"] == "Energy"
    assert gonrgy["isNonFood"] is False

    assert saltletts["main"] == "Süßwaren & Snacks"
    assert saltletts["sub"] == "Cracker & Salzgebäck"
    assert saltletts["isNonFood"] is False

    assert asian["main"] == "Konserven & Fertiggerichte"
    assert asian["sub"] == "Fertiggerichte"
    assert asian["isNonFood"] is False

    assert milk_alternative["main"] == "Milchprodukte & Eier"
    assert milk_alternative["sub"] == "Milchalternativen"
    assert milk_alternative["isNonFood"] is False

    assert alcohol_free_wine["main"] == "Alkohol"
    assert alcohol_free_wine["sub"] == "Wein"
    assert alcohol_free_wine["isNonFood"] is False

    assert kitchen_roll["main"] == "Non-Food"
    assert kitchen_roll["isNonFood"] is True

    assert handcreme["main"] == "Non-Food"
    assert handcreme["isNonFood"] is True


def test_review_logic_for_unknown_low_confidence_and_rule_conflict(tmp_path: Path) -> None:
    input_dir = tmp_path / "data"
    out_dir = tmp_path / "out"
    input_dir.mkdir()
    payload = {
        "snapshotId": "10115",
        "offers": [
            {
                "storeChain": "REWE",
                "name": "Mystery Spezial Mix",
                "category": "Sonstiges",
                "validityStart": "2026-02-09",
                "validityEnd": "2026-02-15",
                "price": "2,49",
                "unit": "1 stk",
            },
            {
                "storeChain": "Lidl",
                "name": "Tomaten Salat Pasta Sauce Dressing",
                "category": "Obst & Gemüse",
                "validityStart": "2026-02-09",
                "validityEnd": "2026-02-15",
                "price": "1,29",
                "unit": "250 ml",
            },
        ],
    }
    (input_dir / "snapshot.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    run_pipeline(
        input_dir=input_dir,
        out_dir=out_dir,
        mode="overlap",
        ollama_mode="off",
        model="llama3.1",
        ollama_host="http://localhost:11434",
        week_start_iso="2026-02-09",
        week_window_mode="calendar",
        week_end_day=None,
        min_rule_score=3.0,
        use_llm_threshold=0.72,
        dump_stats=False,
    )

    offers = offers_by_name(load_output(out_dir / "categorized_offers.json"))
    mystery = offers["Mystery Spezial Mix"]
    assert mystery["reviewNeeded"] is True
    assert "unknown_sub" in mystery["reviewReason"]
    assert "low_confidence" in mystery["reviewReason"]

    conflict_offer = offers["Tomaten Salat Pasta Sauce Dressing"]
    assert conflict_offer["reviewNeeded"] is True
    assert "rule_conflict" in conflict_offer["reviewReason"]
    assert any(str(item).startswith("suspect:") for item in conflict_offer.get("categorySuspects", []))


def test_meat_keyword_classification_and_mismatch_review(tmp_path: Path) -> None:
    input_dir = tmp_path / "data"
    out_dir = tmp_path / "out"
    input_dir.mkdir()
    payload = {
        "snapshotId": "10115",
        "offers": [
            {
                "storeChain": "REWE",
                "name": "Südtiroler Speck",
                "category": "Sonstiges",
                "validityStart": "2026-02-09",
                "validityEnd": "2026-02-15",
                "price": "2,99",
                "unit": "120g",
            },
            {
                "storeChain": "REWE",
                "name": "Südtiroler Speck Wein Paket",
                "category": "Getränke",
                "validityStart": "2026-02-09",
                "validityEnd": "2026-02-15",
                "price": "1,99",
                "unit": "200g",
            },
        ],
    }
    (input_dir / "snapshot.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    run_pipeline(
        input_dir=input_dir,
        out_dir=out_dir,
        mode="overlap",
        ollama_mode="off",
        model="llama3.1",
        ollama_host="http://localhost:11434",
        week_start_iso="2026-02-09",
        week_window_mode="calendar",
        week_end_day=None,
        min_rule_score=3.0,
        use_llm_threshold=0.72,
        dump_stats=False,
    )

    offers = offers_by_name(load_output(out_dir / "categorized_offers.json"))
    speck = offers["Südtiroler Speck"]
    assert speck["canonicalCategory"]["main"] == "Fleisch & Wurst"
    assert speck["canonicalCategory"]["sub"] != "Mehl & Zucker"

    mismatch = offers["Südtiroler Speck Wein Paket"]
    assert mismatch["reviewNeeded"] is True
    assert "keyword_mismatch_meat" in mismatch["reviewReason"]
    assert "suspect:meat_keyword_mismatch" in (mismatch.get("categorySuspects") or [])


def test_kitchen_devices_are_hard_nonfood(tmp_path: Path) -> None:
    input_dir = tmp_path / "data"
    out_dir = tmp_path / "out"
    input_dir.mkdir()
    payload = {
        "snapshotId": "10115",
        "offers": [
            {
                "storeChain": "ALDI NORD",
                "name": "Genius Obst-Gemüseschneider-Set Nicer Dicer Plus",
                "category": "Haushalt",
                "validityStart": "2026-02-09",
                "validityEnd": "2026-02-15",
                "price": "24,99",
                "unit": "1 Stk",
            },
            {
                "storeChain": "Lidl",
                "name": "Switch On Smoothie Maker SSMK 300",
                "category": "Elektro",
                "validityStart": "2026-02-09",
                "validityEnd": "2026-02-15",
                "price": "14,99",
                "unit": "1 Stk",
            },
        ],
    }
    (input_dir / "snapshot.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    run_pipeline(
        input_dir=input_dir,
        out_dir=out_dir,
        mode="overlap",
        ollama_mode="off",
        model="llama3.1",
        ollama_host="http://localhost:11434",
        week_start_iso="2026-02-09",
        week_window_mode="calendar",
        week_end_day=None,
        min_rule_score=3.0,
        use_llm_threshold=0.72,
        dump_stats=False,
    )

    offers = offers_by_name(load_output(out_dir / "categorized_offers.json"))
    dicer = offers["Genius Obst-Gemüseschneider-Set Nicer Dicer Plus"]["canonicalCategory"]
    smoothie_maker = offers["Switch On Smoothie Maker SSMK 300"]["canonicalCategory"]

    assert dicer["main"] == "Non-Food"
    assert dicer["isNonFood"] is True
    assert dicer["sub"] == "Küche & Geräte"

    assert smoothie_maker["main"] == "Non-Food"
    assert smoothie_maker["isNonFood"] is True
    assert smoothie_maker["sub"] == "Küche & Geräte"


def test_golden_category_regression_snapshot(tmp_path: Path) -> None:
    input_dir = tmp_path / "data"
    out_dir = tmp_path / "out"
    input_dir.mkdir()
    copy_golden_fixtures(input_dir)

    run_pipeline(
        input_dir=input_dir,
        out_dir=out_dir,
        mode="overlap",
        ollama_mode="off",
        model="llama3.1",
        ollama_host="http://localhost:11434",
        week_start_iso="2026-02-09",
        week_window_mode="calendar",
        week_end_day=None,
        min_rule_score=3.0,
        use_llm_threshold=0.72,
        dump_stats=False,
    )

    offers = offers_by_name(load_output(out_dir / "categorized_offers.json"))
    assert offers["Mandarinen"]["canonicalCategory"]["main"] == "Obst & Gemüse"
    assert offers["Mandarinen"]["canonicalCategory"]["sub"] == "Obst"
    assert offers["Gouda"]["canonicalCategory"]["main"] == "Milchprodukte & Eier"
    assert offers["Gouda"]["canonicalCategory"]["sub"] == "Käse"
    assert offers["Pizza Salami TK"]["canonicalCategory"]["main"] == "Tiefkühl"
    assert offers["Pizza Salami TK"]["canonicalCategory"]["sub"] == "TK Fertiggerichte"
    assert offers["Rumkugeln"]["canonicalCategory"]["main"] == "Süßwaren & Snacks"
    assert offers["Vodka Premium"]["canonicalCategory"]["main"] == "Alkohol"
