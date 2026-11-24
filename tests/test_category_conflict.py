"""Category plausibility/conflict validator + structured-output schema + cache
version. These guard the quality regression where a fallback-heavy run wrote
wrong categories (Grünländer cheese → Süßwaren, Kfz-Lack-Spray → food, Barilla
Pasta Sauce → Tiefkühl) and stamped them as KI."""
from __future__ import annotations

from pathlib import Path

from offers_categorizer.core import (
    CLASSIFIER_SCHEMA_VERSION,
    CanonicalCategory,
    OllamaCache,
    build_category_schema,
    category_suspects,
    detect_category_conflict,
    detect_food_rescue_category,
    load_taxonomy,
    text_normalize,
    DEFAULT_TAXONOMY_PATH,
)

TAX = load_taxonomy(DEFAULT_TAXONOMY_PATH)


class _Offer:
    def __init__(self, title: str, brand: str = "", scat: str = "", sdep: str = "") -> None:
        self.title_norm = text_normalize(title)
        self.brand_norm = text_normalize(brand)
        self.source_category_norm = text_normalize(scat)
        self.source_department_norm = text_normalize(sdep)


def _cc(main: str, sub: str = "unknown", non_food: bool = False) -> CanonicalCategory:
    return CanonicalCategory(
        main=main, sub=sub, secondary=[], is_non_food=non_food, confidence=0.9, reasons=["llm"]
    )


# --- The three reported misclassifications -----------------------------------

def test_cheese_grunlaender_not_sweets() -> None:
    c = detect_category_conflict(_cc("Süßwaren & Snacks"), _Offer("Grünländer mild & nussig", brand="Grünländer"))
    assert c is not None
    assert c["expected_main"] == "Milchprodukte & Eier"
    assert c["reason"] == "rule_conflict:cheese"


def test_kfz_lack_spray_is_non_food() -> None:
    c = detect_category_conflict(_cc("Grundnahrungsmittel"), _Offer("Kfz-Lack-Spray schwarz"))
    assert c is not None
    assert c["expected_main"] == "Non-Food"


def test_pasta_sauce_not_frozen() -> None:
    c = detect_category_conflict(_cc("Tiefkühl"), _Offer("Barilla Pasta Sauce Basilico", brand="Barilla"))
    assert c is not None
    assert c["expected_main"] == "Konserven & Fertiggerichte"


# --- No false positives ------------------------------------------------------

def test_cheese_already_dairy_no_conflict() -> None:
    assert detect_category_conflict(_cc("Milchprodukte & Eier", "Käse"), _Offer("Gouda jung")) is None


def test_leberkaese_is_meat_not_cheese() -> None:
    # "Leberkäse" contains "käse" but is meat — must not be flagged as cheese.
    assert detect_category_conflict(_cc("Fleisch & Wurst", "Wurst"), _Offer("Bayerischer Leberkäse")) is None


def test_frozen_fish_allowed() -> None:
    # Frozen fish legitimately lives in Tiefkühl — no conflict.
    assert detect_category_conflict(_cc("Tiefkühl", "TK Fisch"), _Offer("TK Lachsfilet")) is None


def test_frischkaese_compound_detected() -> None:
    c = detect_category_conflict(_cc("Süßwaren & Snacks"), _Offer("Philadelphia Frischkäse"))
    assert c is not None and c["expected_main"] == "Milchprodukte & Eier"


# --- Mini benchmark: known products → expected main category -----------------

BENCHMARK = [
    ("Grünländer mild & nussig", "Süßwaren & Snacks", "Milchprodukte & Eier"),
    ("Kfz-Lack-Spray schwarz", "Grundnahrungsmittel", "Non-Food"),
    ("Barilla Pasta Sauce Basilico", "Tiefkühl", "Konserven & Fertiggerichte"),
    ("Maschinenreiniger Zitrone", "Grundnahrungsmittel", "Non-Food"),
    ("Gouda jung am Stück", "Tiefkühl", "Milchprodukte & Eier"),
    ("Barilla Pesto Genovese", "Tiefkühl", "Konserven & Fertiggerichte"),
]


def test_mini_benchmark_corrects_wrong_categories() -> None:
    corrected = 0
    for title, wrong_main, expected_main in BENCHMARK:
        c = detect_category_conflict(_cc(wrong_main), _Offer(title))
        assert c is not None, f"no conflict detected for {title!r}"
        assert c["expected_main"] == expected_main, f"{title!r} → {c['expected_main']!r} != {expected_main!r}"
        corrected += 1
    assert corrected == len(BENCHMARK)


# --- P3: Kategorie-Priorität (Zutaten/Marketing vs. echte Produktsignale) ----

def _rescue(title: str, dep: str = "") -> tuple[str, str, list[str]] | None:
    body = text_normalize(f"{title} {dep}")
    return detect_food_rescue_category(body, set(body.split()))


def test_longdrink_in_spirits_department_is_alcohol_not_softdrink() -> None:
    # Alkoholischer Quellkontext (Wein und Spirituosen) + Getränketyp Longdrink
    # → Alkohol, nicht alkoholfrei.
    res = _rescue("Gorbatschow Premixed Longdrink", "Wein und Spirituosen")
    assert res is not None
    assert res[0] == "Alkohol"


def test_softdrink_without_alcohol_context_stays_soft() -> None:
    # Ohne Alkohol-Quellkontext bleibt eine echte Limo alkoholfrei.
    res = _rescue("Fanta Limonade", "Getränke")
    assert res is not None
    assert res[0] == "Getränke alkoholfrei"


def test_seasoning_paste_with_garlic_not_repaired_to_produce() -> None:
    # "Kochpaste Gerösteter Knoblauch" ist eine Würzpaste, kein frisches Gemüse —
    # das Zutatenwort Knoblauch darf die Hauptkategorie nicht zu Obst & Gemüse drehen.
    offer = _Offer("Knorr Kochpaste Gerösteter Knoblauch", scat="Frühstück")
    suspects = category_suspects(_cc("Gewürze/Saucen/Aufstriche", "Aufstriche"), offer, TAX)
    assert all(s["reason"] != "repair:produce_keyword" for s in suspects)


def test_raw_garlic_is_still_repaired_to_produce() -> None:
    # Gegenprobe: loser Knoblauch ohne Zubereitungswort bleibt Obst & Gemüse.
    offer = _Offer("Knoblauch lose", scat="Obst und Gemüse")
    suspects = category_suspects(_cc("Süßwaren & Snacks"), offer, TAX)
    assert any(s["reason"] == "repair:produce_keyword" for s in suspects)


# --- Structured-output schema ------------------------------------------------

def test_schema_enums_match_taxonomy() -> None:
    schema = build_category_schema(TAX)
    assert schema["properties"]["main"]["enum"] == TAX.main_categories
    assert "Käse" in schema["properties"]["sub"]["enum"]
    assert "unknown" in schema["properties"]["sub"]["enum"]
    # `reasons` ist Pflicht, damit die Grammatik hinter der Confidence weiter ein
    # Komma erzwingt — als optionales Feld haengt das Modell dort eine Ziffer an
    # und die Confidence steigt systematisch um +0,05.
    assert schema["required"] == ["main", "sub", "isNonFood", "confidence", "reasons"]
    assert schema["additionalProperties"] is False


# --- Cache version gating -----------------------------------------------------

def test_cache_ignores_unversioned_and_old_entries(tmp_path: Path) -> None:
    cache_path = tmp_path / "ollama_cache.jsonl"
    cache_path.write_text(
        '{"fingerprint":"old","result":{"main":"X"}}\n'  # no version → ignore
        '{"fingerprint":"v1","result":{"main":"Y"},"classifierSchemaVersion":"cat-schema-v1"}\n'  # old version → ignore
        f'{{"fingerprint":"cur","result":{{"main":"Z"}},"classifierSchemaVersion":"{CLASSIFIER_SCHEMA_VERSION}"}}\n',
        encoding="utf-8",
    )
    cache = OllamaCache(cache_path)
    assert cache.get("old") is None
    assert cache.get("v1") is None
    assert cache.get("cur") == {"main": "Z"}


def test_cache_set_writes_current_version(tmp_path: Path) -> None:
    cache_path = tmp_path / "ollama_cache.jsonl"
    cache = OllamaCache(cache_path)
    cache.set("fp", {"main": "Milchprodukte & Eier"})
    written = cache_path.read_text(encoding="utf-8")
    assert CLASSIFIER_SCHEMA_VERSION in written
    # A fresh cache re-reading the file trusts the just-written (versioned) entry.
    assert OllamaCache(cache_path).get("fp") == {"main": "Milchprodukte & Eier"}
