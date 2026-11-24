"""P2/P3-Tests: verdrahtete Quellenhierarchie + vollstaendiger Fingerprint.

Konkrete Produktnamen leben AUSSCHLIESSLICH hier als Fixtures. Der Produktivcode
kennt keine Produkt-/Marken-Allowlist und keine kalenderwochenabhaengige Logik.
"""

from __future__ import annotations

import copy

from aichef_offers.product_analysis import (
    SOURCE_AI,
    SOURCE_BARCODE_DB,
    SOURCE_MANUFACTURER,
    SOURCE_OCR,
    SOURCE_RETAILER,
    build_product_analysis,
    source_fingerprint,
)


def _none_nutrition() -> dict:
    return {
        "source": "none",
        "per_100g": {"kcal": None, "protein_g": None, "carbs_g": None, "fat_g": None, "sugars_g": None, "salt_g": None, "fiber_g": None},
        "confidence": 0.0,
    }


def analyze(name, *, off=None, category=None, evidence=None, model_version=None, brand="", barcode=""):
    offer = {"name": name, "brand": brand}
    if barcode:
        offer["barcode"] = barcode
    if category:
        offer["canonicalCategory"] = {"main": category}
    return build_product_analysis(
        offer, off, _none_nutrition(), evidence_inputs=evidence, model_version=model_version
    )


# ===========================================================================
# P2 — Quellenhierarchie tatsaechlich verdrahtet
# ===========================================================================
def test_manufacturer_overrides_weaker_name_heuristic():
    # Name "vegetarisch" -> Namensregel vegetarian=yes (schwach). Herstellerangabe
    # vegetarian=no ist staerker und gewinnt; der Widerspruch loest Review aus.
    ev = [{"claim": "vegetarian", "status": "no", "source": SOURCE_MANUFACTURER, "confidence": 0.95, "reason": "manufacturer:contains_meat"}]
    a = analyze("Vegetarische Pfanne", evidence=ev)
    assert a["vegetarian"]["status"] == "no"
    assert a["vegetarian"]["source"] == SOURCE_MANUFACTURER
    assert any("conflict" in r for r in a["reviewReasons"])


def test_retailer_overrides_ai_inference():
    # Haendlerangabe (Rang 2) schlaegt KI-Inferenz (Rang 6) bei Konflikt.
    ev = [
        {"claim": "vegan", "status": "yes", "source": SOURCE_AI, "confidence": 0.7, "modelVersion": "qwen3:14b", "reason": "ai:guess"},
        {"claim": "vegan", "status": "no", "source": SOURCE_RETAILER, "confidence": 0.9, "reason": "retailer:contains_milk"},
    ]
    a = analyze("Aufstrich", evidence=ev)
    assert a["vegan"]["status"] == "no"
    assert a["vegan"]["source"] == SOURCE_RETAILER


def test_ingredient_evidence_overrides_conflicting_vegan_claim():
    # Belastbarer Zutatenbeleg (Hersteller) widerlegt einen Vegan-Claim aus OFF.
    off = {"ingredients_analysis_tags": ["en:vegan"]}
    ev = [{"claim": "vegan", "status": "no", "source": SOURCE_MANUFACTURER, "confidence": 0.95, "reason": "manufacturer:ingredient_milk"}]
    a = analyze("Veganer Aufstrich", off=off, evidence=ev)
    assert a["vegan"]["status"] == "no"
    assert a["reviewNeeded"] is True
    assert any("conflict" in r for r in a["reviewReasons"])


def test_ocr_allergen_hint_keeps_source_ocr_extracted():
    ev = [{"claim": "allergen", "code": "nuts", "status": "contains", "source": SOURCE_OCR, "confidence": 0.55, "reason": "ocr:kann_schalenfruechte"}]
    a = analyze("Keks lose", evidence=ev)
    assert a["allergens"]["nuts"]["status"] == "contains"
    assert a["allergens"]["nuts"]["source"] == SOURCE_OCR


def test_ai_conflict_triggers_review():
    # KI mit Modellversion widerspricht der Regelentscheidung -> Review,
    # aber KI (Rang 6) ueberstimmt die staerkere Regel NICHT.
    off = {"ingredients_analysis_tags": ["en:vegan"]}
    ev = [{"claim": "vegan", "status": "no", "source": SOURCE_AI, "confidence": 0.6, "modelVersion": "qwen3:14b", "reason": "ai:maybe_animal"}]
    a = analyze("Gemuesepfanne", off=off, evidence=ev)
    assert a["vegan"]["status"] == "yes"  # OFF-Claim (Rang 3) bleibt
    assert any("conflict" in r for r in a["reviewReasons"])
    assert a["modelVersion"] == "qwen3:14b"  # KI war beteiligt


def test_ai_without_model_version_is_not_reliable_evidence():
    off = {"ingredients_analysis_tags": ["en:vegan"]}
    ev = [{"claim": "vegan", "status": "no", "source": SOURCE_AI, "confidence": 0.9, "reason": "ai:no_version"}]
    a = analyze("Gemuesepfanne", off=off, evidence=ev)
    assert a["vegan"]["status"] == "yes"  # KI-Evidenz ignoriert
    assert a["modelVersion"] is None
    assert any("no_model_version" in r for r in a["reviewReasons"])


def test_ai_cannot_invent_halal_certification():
    ev = [{"claim": "halal", "status": "halal", "source": SOURCE_AI, "confidence": 0.99, "modelVersion": "qwen3:14b", "reason": "ai:looks_halal"}]
    a = analyze("Haehnchenbrust", evidence=ev)
    # KI darf kein Halal-Zertifikat erfinden -> bleibt doubtful (Fleisch ohne Nachweis).
    assert a["halal"]["status"] != "halal"
    assert any("halal_certification_ignored" in r for r in a["reviewReasons"])


def test_off_is_never_emitted_as_manufacturer_source():
    a = analyze("Mix", off={"allergens_tags": ["en:milk"], "nutriments": {}})
    assert a["allergens"]["milk"]["source"] == SOURCE_BARCODE_DB
    # Keine OFF-abgeleitete Aussage darf manufacturer_label sein.
    for grp in a["allergens"].values():
        assert grp["source"] != SOURCE_MANUFACTURER
    assert a["nutrition"]["source"] != SOURCE_MANUFACTURER


def test_no_ai_means_model_version_stays_null():
    a = analyze("Apfel")
    assert a["modelVersion"] is None


# ===========================================================================
# P3 — vollstaendiger Source-Fingerprint
# ===========================================================================
def test_fingerprint_changes_on_category():
    base = {"name": "X", "barcode": "1", "category": "Getraenke", "sourceCategory": "Bier"}
    other = {"name": "X", "barcode": "1", "category": "Drogerie", "sourceCategory": "Pflege"}
    assert source_fingerprint(base, None) != source_fingerprint(other, None)


def test_fingerprint_changes_on_canonical_category():
    base = {"name": "X", "barcode": "1", "canonicalCategory": {"main": "Getraenke", "sub": "Bier"}}
    other = {"name": "X", "barcode": "1", "canonicalCategory": {"main": "Getraenke", "sub": "Wein"}}
    assert source_fingerprint(base, None) != source_fingerprint(other, None)


def test_fingerprint_changes_on_source_category_raw():
    base = {"name": "X", "barcode": "1", "sourceCategoryRaw": "Bier & Radler"}
    other = {"name": "X", "barcode": "1", "sourceCategoryRaw": "Wein & Sekt"}
    assert source_fingerprint(base, None) != source_fingerprint(other, None)


def test_fingerprint_changes_on_ocr_text():
    base = {"name": "X", "barcode": "1", "ocrText": "Zutaten: Milch"}
    other = {"name": "X", "barcode": "1", "ocrText": "Zutaten: Soja"}
    assert source_fingerprint(base, None) != source_fingerprint(other, None)


def test_fingerprint_changes_on_model_version():
    base = {"name": "X", "barcode": "1"}
    assert source_fingerprint(base, None, model_version="m1") != source_fingerprint(base, None, model_version="m2")


def test_fingerprint_changes_on_ai_evidence():
    base = {"name": "X", "barcode": "1"}
    ev = [{"claim": "vegan", "status": "no", "source": SOURCE_AI, "modelVersion": "m", "confidence": 0.5}]
    assert source_fingerprint(base, None, evidence_inputs=ev) != source_fingerprint(base, None)


def test_fingerprint_independent_of_object_and_tag_order():
    base = {"name": "X", "barcode": "1", "canonicalCategory": {"main": "A", "sub": "B", "secondary": ["x", "y"]}}
    reordered = {"barcode": "1", "name": "X", "canonicalCategory": {"sub": "B", "secondary": ["y", "x"], "main": "A"}}
    off1 = {"allergens_tags": ["en:milk", "en:soy"], "traces_tags": ["en:nuts"]}
    off2 = {"traces_tags": ["en:nuts"], "allergens_tags": ["en:soy", "en:milk"]}
    assert source_fingerprint(base, off1) == source_fingerprint(reordered, off2)


def test_fingerprint_uses_new_prefix_and_invalidates_old():
    fp = source_fingerprint({"name": "X", "barcode": "1"}, None)
    assert fp.startswith("sf5:")


def test_idempotent_with_evidence_inputs():
    offer = {"name": "Aufstrich", "barcode": "9", "category": "Brotaufstrich"}
    off = {"ingredients_analysis_tags": ["en:vegan"]}
    ev = [{"claim": "vegan", "status": "no", "source": SOURCE_MANUFACTURER, "confidence": 0.9, "reason": "m"}]
    a1 = build_product_analysis(copy.deepcopy(offer), copy.deepcopy(off), _none_nutrition(), evidence_inputs=copy.deepcopy(ev), now="t")
    a2 = build_product_analysis(copy.deepcopy(offer), copy.deepcopy(off), _none_nutrition(), evidence_inputs=copy.deepcopy(ev), now="t")
    assert a1 == a2
