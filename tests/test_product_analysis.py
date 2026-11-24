"""Strukturelle Testmatrix fuer ProductAnalysisV2 (Phase 2.0).

Reine Engine-Tests ohne IO. Konkrete Produktnamen leben AUSSCHLIESSLICH hier als
Fixtures — der Produktivcode kennt keine Produkt-/Marken-Allowlist.
"""

from __future__ import annotations

import copy

from aichef_offers.product_analysis import (
    EU14_KEYS,
    RULES_VERSION,
    build_product_analysis,
    legacy_allergens,
    legacy_diet_flags,
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
# Ernaehrungsstatus (vegan / vegetarisch / halal)
# ===========================================================================
def test_plain_plant_with_vegan_claim_is_vegan_and_vegetarian():
    a = analyze("Linsen Bolognese", off={"ingredients_analysis_tags": ["en:vegan"], "ingredients_text": "Linsen, Tomaten"})
    assert a["vegan"]["status"] == "yes"
    assert a["vegetarian"]["status"] == "yes"
    # Pflanzlich ist NICHT automatisch halal.
    assert a["halal"]["status"] == "unknown"


def test_bare_plant_name_without_claim_is_unknown_not_vegan():
    # Fehlender Tierbegriff bedeutet NICHT vegan/vegetarisch.
    a = analyze("Basmati Reis")
    assert a["vegan"]["status"] == "unknown"
    assert a["vegetarian"]["status"] == "unknown"


def test_milk_product_is_vegetarian_not_vegan():
    a = analyze("Frische Vollmilch", category="Milchprodukte & Eier")
    assert a["vegan"]["status"] == "no"
    assert a["vegetarian"]["status"] == "yes"
    assert a["halal"]["status"] == "unknown"


def test_plant_milk_is_not_treated_as_dairy():
    a = analyze("Hafermilch Barista")
    assert a["vegan"]["status"] != "no"  # darf nicht faelschlich als Tierprodukt gelten
    assert a["vegetarian"]["status"] != "no"


def test_egg_product_is_vegetarian_not_vegan():
    a = analyze("Eier aus Freilandhaltung")
    assert a["vegan"]["status"] == "no"
    assert a["vegetarian"]["status"] == "yes"


def test_honey_is_vegetarian_not_vegan():
    a = analyze("Bluetenhonig")
    assert a["vegan"]["status"] == "no"
    assert a["vegetarian"]["status"] == "yes"


def test_fish_is_not_vegetarian():
    a = analyze("Lachsfilet natur")
    assert a["vegetarian"]["status"] == "no"
    assert a["vegan"]["status"] == "no"
    # Niemals allein aus der Tierart positiv halal.
    assert a["halal"]["status"] != "halal"


def test_poultry_without_cert_is_doubtful_halal():
    a = analyze("Haehnchenbrustfilet")
    assert a["vegetarian"]["status"] == "no"
    assert a["halal"]["status"] == "doubtful"
    assert a["reviewNeeded"] is True
    assert "meat:no_halal_proof" in a["reviewReasons"]


def test_beef_without_cert_is_doubtful_halal():
    a = analyze("Rindergulasch")
    assert a["vegetarian"]["status"] == "no"
    assert a["halal"]["status"] == "doubtful"


def test_certified_halal_meat_is_halal():
    a = analyze("Haehnchen Schenkel", off={"labels_tags": ["en:halal"]})
    assert a["halal"]["status"] == "halal"
    assert a["vegetarian"]["status"] == "no"


def test_pork_meat_is_not_halal():
    a = analyze("Schweineschnitzel paniert")
    assert a["halal"]["status"] == "not_halal"
    assert a["vegetarian"]["status"] == "no"
    assert a["vegan"]["status"] == "no"


def test_pork_gelatin_is_not_halal():
    a = analyze("Fruchtgummi", off={"ingredients_text": "Zucker, Schweinegelatine"})
    assert a["halal"]["status"] == "not_halal"
    assert a["gelatin"]["source"] == "pork"
    assert a["vegan"]["status"] == "no"


def test_unknown_gelatin_is_doubtful_and_review():
    a = analyze("Fruchtgummi Classic")
    assert a["gelatin"]["present"] is True
    assert a["gelatin"]["source"] == "unknown"
    assert a["halal"]["status"] == "doubtful"
    assert a["vegetarian"]["status"] == "unknown"
    assert "gelatin:unknown_origin" in a["reviewReasons"]


def test_animal_rennet_unknown_origin_is_review():
    a = analyze("Bergkaese", off={"ingredients_text": "Milch, tierisches Lab, Salz"})
    assert a["vegetarian"]["status"] == "unknown"
    assert a["vegan"]["status"] == "no"
    assert "rennet:unknown_origin" in a["reviewReasons"]


def test_vegan_substitute_with_meat_word_stays_vegetarian():
    # Veganes Ersatzprodukt mit Fleischbegriff darf NICHT vegetarian=no ausloesen.
    a = analyze("Veganes Schnitzel", off={"ingredients_analysis_tags": ["en:vegan"], "ingredients_text": "Weizeneiweiss"})
    assert a["vegan"]["status"] == "yes"
    assert a["vegetarian"]["status"] == "yes"
    assert a["halal"]["status"] == "unknown"  # kein Schwein, kein Alkohol


def test_vegan_alcoholic_drink_is_not_halal():
    # Alkohol ueberstimmt jeden positiven/veganen Status. Fixture bewusst ohne
    # "alkoholfrei"-Token (das wuerde die Getraenkeklasse korrekt entschaerfen).
    a = analyze("Veganes Pils Bier", off={"ingredients_analysis_tags": ["en:vegan"]})
    assert a["vegan"]["status"] == "yes"
    assert a["halal"]["status"] == "not_halal"
    assert any("alcohol" in r for r in a["halal"]["reasons"])


def test_vegan_never_implies_halal():
    # Kernbugfix: kein veg_implies_halal.
    a = analyze("Gemuesepfanne", off={"ingredients_analysis_tags": ["en:vegan"]})
    assert a["vegan"]["status"] == "yes"
    assert a["halal"]["status"] == "unknown"
    assert all("veg_implies_halal" not in r for r in a["halal"]["reasons"])


def test_non_halal_label_overrides_vegan():
    a = analyze("Veganer Fruchtgummi", off={"ingredients_analysis_tags": ["en:vegan"], "labels_tags": ["en:non-halal"]})
    assert a["vegan"]["status"] == "yes"
    assert a["halal"]["status"] == "not_halal"


# ===========================================================================
# Allergene (EU-14)
# ===========================================================================
def test_allergen_keys_are_exactly_eu14():
    a = analyze("Irgendwas")
    assert set(a["allergens"].keys()) == set(EU14_KEYS)
    assert len(EU14_KEYS) == 14


def test_each_eu14_allergen_from_off_tags():
    tag_for = {
        "gluten_cereals": "en:gluten", "crustaceans": "en:crustaceans", "eggs": "en:eggs",
        "fish": "en:fish", "peanuts": "en:peanuts", "soybeans": "en:soybeans",
        "milk": "en:milk", "nuts": "en:nuts", "celery": "en:celery", "mustard": "en:mustard",
        "sesame": "en:sesame-seeds", "sulphites": "en:sulphur-dioxide-and-sulphites",
        "lupin": "en:lupin", "molluscs": "en:molluscs",
    }
    for code, tag in tag_for.items():
        a = analyze("Testprodukt", off={"allergens_tags": [tag]})
        assert a["allergens"][code]["status"] == "contains", code


def test_multiple_allergens_separate():
    a = analyze("Mix", off={"allergens_tags": ["en:milk", "en:gluten", "en:nuts"]})
    assert a["allergens"]["milk"]["status"] == "contains"
    assert a["allergens"]["gluten_cereals"]["status"] == "contains"
    assert a["allergens"]["nuts"]["status"] == "contains"
    assert a["allergens"]["fish"]["status"] == "unknown"


def test_traces_are_may_contain_not_contains():
    a = analyze("Keks", off={"traces_tags": ["en:nuts"]})
    assert a["allergens"]["nuts"]["status"] == "may_contain"


def test_free_from_claim_is_claim_only():
    a = analyze("Glutenfrei Brot", off={"labels_tags": ["en:gluten-free"]})
    assert a["allergens"]["gluten_cereals"]["status"] == "free_from_claim"


def test_missing_info_is_unknown_not_free():
    a = analyze("Schokoriegel")
    # Fehlende Erwaehnung bedeutet NIEMALS allergenfrei.
    assert a["allergens"]["milk"]["status"] in {"unknown", "contains"}
    assert a["allergens"]["peanuts"]["status"] == "unknown"


def test_peanuts_and_nuts_are_separate():
    a = analyze("Snack", off={"allergens_tags": ["en:peanuts"]})
    assert a["allergens"]["peanuts"]["status"] == "contains"
    assert a["allergens"]["nuts"]["status"] == "unknown"


def test_crustaceans_and_molluscs_are_separate():
    a = analyze("Meeresmix", off={"allergens_tags": ["en:crustaceans"]})
    assert a["allergens"]["crustaceans"]["status"] == "contains"
    assert a["allergens"]["molluscs"]["status"] == "unknown"


def test_lactose_free_is_not_milk_free_claim():
    # Milchallergie != Laktoseintoleranz.
    a = analyze("Laktosefreie Milch", off={"labels_tags": ["en:lactose-free"]})
    assert a["allergens"]["milk"]["status"] != "free_from_claim"


def test_contains_beats_may_contain_conflict():
    a = analyze("X", off={"allergens_tags": ["en:milk"], "traces_tags": ["en:milk"]})
    assert a["allergens"]["milk"]["status"] == "contains"


# ===========================================================================
# Naehrwerte + Plausibilitaet
# ===========================================================================
def _nutri(per100, source="openfoodfacts", confidence=0.9):
    return {"source": source, "per_100g": per100, "confidence": confidence}


def test_full_per_100g_nutrition_quality_barcode():
    n = _nutri({"kcal": 250, "protein_g": 8, "carbs_g": 30, "fat_g": 10, "sugars_g": 5, "salt_g": 1, "fiber_g": 2})
    a = build_product_analysis({"name": "Muesli"}, {"nutriments": {}}, n)
    nut = a["nutrition"]
    assert nut["quality"] == "barcode_database"
    assert nut["values"]["energy_kcal"] == 250
    assert nut["values"]["energy_kj"] is not None
    assert nut["plausibility"]["ok"] is True


def test_per_100ml_basis_detected():
    n = _nutri({"kcal": 42, "protein_g": 0, "carbs_g": 10, "fat_g": 0, "sugars_g": 10, "salt_g": 0, "fiber_g": None})
    a = build_product_analysis({"name": "Limonade", "size": "1 l"}, None, n, basis="ml")
    assert a["nutrition"]["basis"] == "per_100ml"


def test_serving_basis_from_off():
    n = _nutri({"kcal": 100, "protein_g": 2, "carbs_g": 20, "fat_g": 1, "sugars_g": 2, "salt_g": 0, "fiber_g": 1})
    a = build_product_analysis({"name": "Snack"}, {"nutrition_data_per": "serving", "serving_size": "30 g"}, n)
    assert a["nutrition"]["basis"] == "per_serving"


def test_negative_value_flagged():
    n = _nutri({"kcal": 100, "protein_g": -2, "carbs_g": 20, "fat_g": 1, "sugars_g": 2, "salt_g": 0, "fiber_g": None})
    a = build_product_analysis({"name": "X"}, None, n)
    assert a["nutrition"]["plausibility"]["ok"] is False
    assert any(v.startswith("negative:") for v in a["nutrition"]["plausibility"]["violations"])
    assert "nutrition:implausible" in a["reviewReasons"]


def test_sugars_gt_carbs_flagged():
    n = _nutri({"kcal": 100, "protein_g": 2, "carbs_g": 5, "fat_g": 1, "sugars_g": 50, "salt_g": 0, "fiber_g": None})
    a = build_product_analysis({"name": "X"}, None, n)
    assert "sugars_gt_carbs" in a["nutrition"]["plausibility"]["violations"]


def test_saturated_gt_fat_flagged():
    n = _nutri({"kcal": 100, "protein_g": 2, "carbs_g": 5, "fat_g": 1, "sugars_g": 2, "salt_g": 0, "fiber_g": None})
    a = build_product_analysis({"name": "X"}, {"nutriments": {"saturated-fat_100g": 9}}, n)
    assert "saturated_gt_fat" in a["nutrition"]["plausibility"]["violations"]


def test_inconsistent_kj_kcal_flagged():
    n = _nutri({"kcal": 100, "protein_g": 2, "carbs_g": 5, "fat_g": 1, "sugars_g": 2, "salt_g": 0, "fiber_g": None})
    a = build_product_analysis({"name": "X"}, {"nutriments": {"energy-kj_100g": 9999}}, n)
    assert "energy_kj_kcal_mismatch" in a["nutrition"]["plausibility"]["violations"]


def test_decimal_comma_parsed():
    n = _nutri({"kcal": "64,5", "protein_g": "1,2", "carbs_g": "10,0", "fat_g": "0,5", "sugars_g": "9,0", "salt_g": "0,1", "fiber_g": None})
    a = build_product_analysis({"name": "X"}, None, n)
    assert a["nutrition"]["values"]["energy_kcal"] == 64.5
    assert a["nutrition"]["values"]["sugars_g"] == 9.0


def test_ocr_digit_swap_caught_by_plausibility():
    # OCR-Zahlendreher: Zucker 50 statt 5 bei Carbs 5 -> sugars>carbs -> Review.
    n = _nutri({"kcal": 200, "protein_g": 3, "carbs_g": 5, "fat_g": 2, "sugars_g": 50, "salt_g": 0, "fiber_g": None}, source="ocr")
    a = build_product_analysis({"name": "X"}, None, n)
    assert a["nutrition"]["quality"] == "ocr_extracted"
    assert a["nutrition"]["plausibility"]["ok"] is False


def test_bls_reference_is_estimated_not_verified():
    n = _nutri({"kcal": 52, "protein_g": 0.3, "carbs_g": 14, "fat_g": 0.2, "sugars_g": 10, "salt_g": 0, "fiber_g": 2}, source="bls", confidence=0.6)
    a = build_product_analysis({"name": "Apfel"}, None, n)
    assert a["nutrition"]["quality"] == "estimated"
    assert a["nutrition"]["estimated"] is True


def test_none_nutrition_is_unknown_quality():
    a = analyze("Sortiment verschiedene Sorten")
    assert a["nutrition"]["quality"] == "unknown"
    assert a["nutrition"]["estimated"] is True


# ===========================================================================
# Pipeline / Modell-Invarianten
# ===========================================================================
def test_analysis_carries_version_and_fingerprint():
    a = analyze("X")
    assert a["analysisVersion"] == RULES_VERSION
    assert a["rulesVersion"] == RULES_VERSION
    assert a["sourceFingerprint"].startswith("sf5:")


def test_idempotent_same_input_same_output():
    offer = {"name": "Schweineschnitzel"}
    a1 = build_product_analysis(copy.deepcopy(offer), None, _none_nutrition(), now="t")
    a2 = build_product_analysis(copy.deepcopy(offer), None, _none_nutrition(), now="t")
    assert a1 == a2


def test_fingerprint_changes_when_off_evidence_changes():
    base = {"name": "Keks", "barcode": "111"}
    fp1 = source_fingerprint(base, {"ingredients_text": "Mehl, Zucker"})
    fp2 = source_fingerprint(base, {"ingredients_text": "Mehl, Zucker, Ei"})
    assert fp1 != fp2


def test_higher_evidence_off_beats_name_rule():
    # OFF sagt explizit non-vegan -> ueberschreibt einen schwachen Namens-Claim.
    a = analyze("Vegan Style Burger", off={"ingredients_analysis_tags": ["en:non-vegan"]})
    assert a["vegan"]["status"] == "no"


def test_legacy_diet_flags_derivation():
    a = analyze("Schweineschnitzel")
    legacy = legacy_diet_flags(a)
    assert legacy["vegan"] is False
    assert legacy["halal"]["status"] == "no"  # not_halal -> legacy "no"
    assert legacy["halal"]["statusV2"] == "not_halal"


def test_legacy_doubtful_maps_to_unknown():
    a = analyze("Rindergulasch")
    legacy = legacy_diet_flags(a)
    assert legacy["halal"]["status"] == "unknown"
    assert legacy["halal"]["statusV2"] == "doubtful"


def test_legacy_allergens_derivation():
    a = analyze("Mix", off={"allergens_tags": ["en:milk"], "traces_tags": ["en:nuts"]})
    legacy = legacy_allergens(a)
    assert "milk" in legacy["contains"]
    assert "nuts" in legacy["may_contain"]
    assert legacy["source"] == "openfoodfacts"


def test_unknown_is_acceptable_result():
    a = analyze("Produkt ohne jede Info")
    assert a["vegan"]["status"] == "unknown"
    assert a["vegetarian"]["status"] == "unknown"
    assert a["halal"]["status"] == "unknown"
