"""Strukturelle Reproduktions- und Regressionstests fuer ProductAnalysisV2.

Deckt die fuenf gemeldeten strukturellen Fehler (Phase 2.0) plus die in der
Aufgabe geforderten Zusatzfaelle ab. Konkrete Produktnamen leben AUSSCHLIESSLICH
hier als Fixtures — der Produktivcode kennt keine Produkt-/Marken-Allowlist und
keine kalenderwochenabhaengige Logik.
"""

from __future__ import annotations

import copy

from aichef_offers.product_analysis import (
    build_product_analysis,
    source_fingerprint,
)


def _none_nutrition() -> dict:
    return {
        "source": "none",
        "per_100g": {"kcal": None, "protein_g": None, "carbs_g": None, "fat_g": None, "sugars_g": None, "salt_g": None, "fiber_g": None},
        "confidence": 0.0,
    }


def analyze(name: str, *, off=None, category=None, nutrition=None, brand="", size="", barcode=""):
    offer = {"name": name, "brand": brand, "size": size}
    if barcode:
        offer["barcode"] = barcode
    if category:
        offer["canonicalCategory"] = {"main": category}
    return build_product_analysis(offer, off, nutrition or _none_nutrition())


# ===========================================================================
# Fall 1 — Alkoholfreies vs. tatsaechlich alkoholhaltiges Getraenk
# ===========================================================================
def test_alcohol_free_beer_is_not_not_halal_by_class():
    # Getraenkeklasse "Bier" allein darf ein alkoholfreies Getraenk NICHT als
    # alkoholisch/nicht-halal werten.
    a = analyze("Alkoholfreies Bier")
    assert a["halal"]["status"] != "not_halal"
    assert all("alcohol:bier" not in r for r in a["halal"]["reasons"])


def test_alcohol_free_wheat_beer_zero_percent_is_not_not_halal():
    a = analyze("Weizen alkoholfrei 0,0% vol")
    assert a["halal"]["status"] != "not_halal"


def test_real_beer_is_not_halal():
    a = analyze("Pils Bier 4,9% vol")
    assert a["halal"]["status"] == "not_halal"
    assert any("alcohol" in r for r in a["halal"]["reasons"])


def test_real_spirit_is_not_halal():
    a = analyze("Doppelkorn 38% vol")
    assert a["halal"]["status"] == "not_halal"


def test_alcohol_free_beer_half_percent_is_not_not_halal():
    # Root-Cause P1: "0,5% vol" wurde durch Komma->Space-Normalisierung als
    # "5% vol" gelesen. Gesetzlicher Restalkohol <= Grenzwert -> NICHT not_halal.
    a = analyze("Bier alkoholfrei 0,5% vol")
    assert a["halal"]["status"] != "not_halal"
    assert all(not r.startswith("evidence:alcohol:vol:5") for r in a["halal"]["reasons"])


def test_alcohol_free_wine_zero_three_percent_is_not_not_halal():
    a = analyze("Wein alkoholfrei 0,3% vol")
    assert a["halal"]["status"] != "not_halal"


def test_half_percent_abv_decimal_point_is_not_not_halal():
    # Dezimalpunkt + ABV-Schreibweise, exakt am Grenzwert.
    a = analyze("Radler 0.5 % ABV")
    assert a["halal"]["status"] != "not_halal"


def test_conflicting_alcohol_free_but_positive_percent_triggers_review():
    # "alkoholfrei 4,9% vol" ist widerspruechlich: echter Alkohol > Grenzwert
    # ueberstimmt -> not_halal, der Konflikt MUSS Review ausloesen (nicht still
    # als alkoholfrei gelten).
    a = analyze("Bier alkoholfrei 4,9% vol")
    assert a["halal"]["status"] == "not_halal"
    assert a["reviewNeeded"] is True
    assert any("alcohol" in r and "conflict" in r for r in a["reviewReasons"])


def test_vollmilch_is_no_alcohol_hit():
    # "vol" steckt in "Vollmilch" -> darf KEIN Alkoholtreffer sein.
    a = analyze("Frische Vollmilch", category="Milchprodukte & Eier")
    assert a["halal"]["status"] != "not_halal"
    assert all("alcohol" not in r for r in a["halal"]["reasons"])


# ===========================================================================
# Fall 2 — Schinken: Schwein vs. Rind vs. Gefluegel
# ===========================================================================
def test_beef_ham_is_not_pork_not_not_halal():
    # "Rinderschinken": explizite Tierart Rind hat Vorrang; kein Schweinsignal.
    a = analyze("Rinderschinken")
    assert a["halal"]["status"] != "not_halal"
    assert a["vegetarian"]["status"] == "no"


def test_poultry_ham_is_not_pork():
    a = analyze("Putenschinken")
    assert a["halal"]["status"] != "not_halal"
    assert a["vegetarian"]["status"] == "no"


def test_bare_ham_is_not_automatically_not_halal():
    # Schinken allein beweist kein Schwein -> nicht automatisch not_halal.
    a = analyze("Kochschinken")
    assert a["halal"]["status"] != "not_halal"
    assert a["vegetarian"]["status"] == "no"


def test_explicit_pork_ham_is_not_halal():
    # Nur ein echtes Schweinefleischsignal loest direkt not_halal aus.
    a = analyze("Schweineschinken")
    assert a["halal"]["status"] == "not_halal"


# ===========================================================================
# Fall 3 — "Ei" als eigenes Wort vs. Wortbestandteil
# ===========================================================================
def test_glutenfree_bread_does_not_trigger_egg_or_milk():
    # Das Teilstueck "ei" in "glutenfrei" darf KEIN Ei-/Milchsignal ausloesen.
    a = analyze("Glutenfrei Brot")
    assert a["allergens"]["eggs"]["status"] == "unknown"
    assert a["allergens"]["milk"]["status"] == "unknown"


def test_egg_as_standalone_word_is_detected():
    a = analyze("Eier Freilandhaltung")
    assert a["vegan"]["status"] == "no"
    assert a["allergens"]["eggs"]["status"] == "contains"


def test_wheat_protein_is_not_egg():
    # "Weizeneiweiss" ist Weizenprotein, KEIN Ei.
    a = analyze("Seitan", off={"ingredients_text": "Wasser, Weizeneiweiss, Gewuerze"})
    assert a["allergens"]["eggs"]["status"] != "contains"


def test_substring_words_do_not_trigger_egg():
    for name in ["Dreierlei Pasta", "Frei Haus Brot", "Reis natur"]:
        a = analyze(name)
        assert a["allergens"]["eggs"]["status"] == "unknown", name


# ===========================================================================
# Fall 4 — coconut vs. echte EU-Schalenfruechte
# ===========================================================================
def test_coconut_off_tag_is_not_eu_tree_nut():
    a = analyze("Schokoriegel", off={"allergens_tags": ["en:coconut"]})
    assert a["allergens"]["nuts"]["status"] == "unknown"


def test_real_tree_nut_off_tag_is_nuts():
    a = analyze("Nussmischung", off={"allergens_tags": ["en:nuts"]})
    assert a["allergens"]["nuts"]["status"] == "contains"


def test_hazelnut_off_tag_is_nuts():
    a = analyze("Praline", off={"allergens_tags": ["en:hazelnut"]})
    assert a["allergens"]["nuts"]["status"] == "contains"


def test_coconut_milk_off_tag_is_not_dairy_milk():
    # "en:coconut" darf auch keine Milch sein; nur echtes Milch-Tag zaehlt.
    a = analyze("Kokosdrink", off={"allergens_tags": ["en:coconut"]})
    assert a["allergens"]["milk"]["status"] == "unknown"


# ===========================================================================
# Fall 5 — Vegan-Claim im Konflikt mit tierischen Zutaten
# ===========================================================================
def test_vegan_claim_conflicting_with_animal_ingredients_is_no_and_review():
    a = analyze(
        "Veganer Aufstrich",
        off={"ingredients_analysis_tags": ["en:vegan"], "ingredients_text": "Wasser, Milch, Ei, Salz"},
    )
    assert a["vegan"]["status"] == "no"
    # vegetarisch bleibt moeglich yes (kein Fleisch/Fisch).
    assert a["vegetarian"]["status"] == "yes"
    assert a["reviewNeeded"] is True
    assert any("vegan" in r and "conflict" in r for r in a["reviewReasons"])
    # Nachvollziehbare Evidenz: sowohl Claim als auch widersprechende Zutat.
    reasons = " ".join(a["vegan"]["reasons"])
    assert "conflict" in reasons


def test_vegan_claim_without_conflict_stays_vegan():
    a = analyze("Veganer Aufstrich", off={"ingredients_analysis_tags": ["en:vegan"], "ingredients_text": "Wasser, Sonnenblumenoel, Salz"})
    assert a["vegan"]["status"] == "yes"
    assert a["reviewNeeded"] is False


def test_vegan_claim_conflicting_with_meat_ingredient_not_vegetarian():
    a = analyze("Vegan Burger", off={"ingredients_analysis_tags": ["en:vegan"], "ingredients_text": "Rindfleisch, Wasser"})
    assert a["vegan"]["status"] == "no"
    assert a["vegetarian"]["status"] == "no"
    assert a["reviewNeeded"] is True


# ===========================================================================
# Allergenfrei-Claim im Konflikt mit Zutaten
# ===========================================================================
def test_glutenfree_claim_conflicting_with_wheat_is_review():
    a = analyze(
        "Glutenfrei Brot",
        off={"labels_tags": ["en:gluten-free"], "ingredients_text": "Wasser, Weizenmehl, Hefe"},
    )
    # Claim bleibt sichtbar, aber der Konflikt loest Review aus.
    assert a["reviewNeeded"] is True
    assert any("gluten" in r and "conflict" in r for r in a["reviewReasons"])


def test_traces_claim_stays_may_contain():
    a = analyze("Keks", off={"traces_tags": ["en:nuts"]})
    assert a["allergens"]["nuts"]["status"] == "may_contain"


# ===========================================================================
# Fingerprint — alle entscheidungsrelevanten Eingaben
# ===========================================================================
def test_fingerprint_changes_on_traces_tags():
    base = {"name": "Keks", "barcode": "111"}
    fp1 = source_fingerprint(base, {"traces_tags": []})
    fp2 = source_fingerprint(base, {"traces_tags": ["en:nuts"]})
    assert fp1 != fp2


def test_fingerprint_changes_on_vegan_tags():
    base = {"name": "Aufstrich", "barcode": "222"}
    fp1 = source_fingerprint(base, {"ingredients_analysis_tags": []})
    fp2 = source_fingerprint(base, {"ingredients_analysis_tags": ["en:vegan"]})
    assert fp1 != fp2


def test_fingerprint_changes_on_nutrition():
    base = {"name": "Muesli", "barcode": "333"}
    n1 = {"source": "openfoodfacts", "per_100g": {"kcal": 200}, "confidence": 0.9}
    n2 = {"source": "openfoodfacts", "per_100g": {"kcal": 350}, "confidence": 0.9}
    fp1 = source_fingerprint(base, {"ingredients_text": "Hafer"}, n1)
    fp2 = source_fingerprint(base, {"ingredients_text": "Hafer"}, n2)
    assert fp1 != fp2


def test_fingerprint_stable_for_identical_evidence():
    base = {"name": "Muesli", "barcode": "333"}
    off = {"ingredients_text": "Hafer", "allergens_tags": ["en:gluten"]}
    n = {"source": "openfoodfacts", "per_100g": {"kcal": 200}, "confidence": 0.9}
    assert source_fingerprint(copy.deepcopy(base), copy.deepcopy(off), copy.deepcopy(n)) == source_fingerprint(
        copy.deepcopy(base), copy.deepcopy(off), copy.deepcopy(n)
    )


def test_repeated_analysis_is_idempotent():
    offer = {"name": "Rinderschinken", "barcode": "999"}
    off = {"ingredients_text": "Rindfleisch, Salz", "allergens_tags": []}
    a1 = build_product_analysis(copy.deepcopy(offer), copy.deepcopy(off), _none_nutrition(), now="t")
    a2 = build_product_analysis(copy.deepcopy(offer), copy.deepcopy(off), _none_nutrition(), now="t")
    assert a1 == a2
