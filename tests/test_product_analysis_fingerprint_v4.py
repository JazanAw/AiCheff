"""P3 — vollstaendiger, konsistenter Source-Fingerprint (pa-v6 / sf5).

Der Fingerprint enthaelt jetzt ALLE Eingaben, die das Analyseergebnis
beeinflussen: amount, basis, serving size/unit, Naehrwertbasis, Evidenzschema-
Version usw. ``source_fingerprint`` und ``build_product_analysis`` nutzen dieselben
entscheidungsrelevanten Eingaben. ``analyzedAt`` bleibt ausgeschlossen.
"""

from __future__ import annotations

import copy

from aichef_offers.product_analysis import (
    EVIDENCE_SCHEMA_VERSION,
    RULES_VERSION,
    SOURCE_AI,
    build_product_analysis,
    source_fingerprint,
)


def _none_nutrition() -> dict:
    return {
        "source": "none",
        "per_100g": {"kcal": None, "protein_g": None, "carbs_g": None, "fat_g": None, "sugars_g": None, "salt_g": None, "fiber_g": None},
        "confidence": 0.0,
    }


def test_version_is_pa_v7_and_prefix_sf5():
    assert RULES_VERSION == "pa-v7"
    fp = source_fingerprint({"name": "X", "barcode": "1"}, None)
    assert fp.startswith("sf5:")


def test_build_basis_g_vs_ml_changes_fingerprint():
    # Reproduzierter Fehler: basis='g' vs 'ml' lieferte denselben Fingerprint.
    n = {"source": "openfoodfacts", "per_100g": {"kcal": 100}, "confidence": 0.9}
    a_g = build_product_analysis({"name": "Drink", "barcode": "1"}, None, copy.deepcopy(n), amount=500, basis="g", now="t")
    a_ml = build_product_analysis({"name": "Drink", "barcode": "1"}, None, copy.deepcopy(n), amount=500, basis="ml", now="t")
    assert a_g["nutrition"]["basis"] != a_ml["nutrition"]["basis"]
    assert a_g["sourceFingerprint"] != a_ml["sourceFingerprint"]


def test_fingerprint_changes_on_amount():
    base = {"name": "X", "barcode": "1"}
    assert source_fingerprint(base, None, amount=250) != source_fingerprint(base, None, amount=500)


def test_fingerprint_changes_on_basis():
    base = {"name": "X", "barcode": "1"}
    assert source_fingerprint(base, None, basis="g") != source_fingerprint(base, None, basis="ml")


def test_fingerprint_changes_on_serving_unit():
    base = {"name": "X", "barcode": "1"}
    assert source_fingerprint(base, None, serving_unit="g") != source_fingerprint(base, None, serving_unit="ml")


def test_fingerprint_changes_on_nutrition_basis():
    base = {"name": "X", "barcode": "1"}
    assert source_fingerprint(base, None, nutrition_basis="per_100g") != source_fingerprint(base, None, nutrition_basis="per_serving")


def test_fingerprint_includes_evidence_schema_version():
    base = {"name": "X", "barcode": "1"}
    assert source_fingerprint(base, None, evidence_schema_version="ev-v1") != source_fingerprint(base, None, evidence_schema_version="ev-v2")
    # Standard verwendet die zentrale Konstante.
    assert EVIDENCE_SCHEMA_VERSION


def test_same_semantic_evidence_other_order_is_stable():
    base = {"name": "X", "barcode": "1"}
    ev1 = [
        {"claim": "vegan", "status": "no", "source": SOURCE_AI, "modelVersion": "m", "confidence": 0.5},
        {"claim": "vegetarian", "status": "no", "source": SOURCE_AI, "modelVersion": "m", "confidence": 0.5},
    ]
    ev2 = list(reversed(ev1))
    assert source_fingerprint(base, None, evidence_inputs=ev1) == source_fingerprint(base, None, evidence_inputs=ev2)


def test_new_identical_fingerprint_is_reused():
    offer = {"name": "Muesli", "barcode": "9"}
    off = {"ingredients_text": "Hafer", "allergens_tags": ["en:gluten"]}
    n = {"source": "openfoodfacts", "per_100g": {"kcal": 200}, "confidence": 0.9}
    a1 = build_product_analysis(copy.deepcopy(offer), copy.deepcopy(off), copy.deepcopy(n), amount=500, basis="g", now="t1")
    a2 = build_product_analysis(copy.deepcopy(offer), copy.deepcopy(off), copy.deepcopy(n), amount=500, basis="g", now="t2")
    # analyzedAt unterscheidet sich, der Fingerprint NICHT.
    assert a1["sourceFingerprint"] == a2["sourceFingerprint"]


def test_old_fingerprint_generation_is_not_current():
    fp = source_fingerprint({"name": "X", "barcode": "1"}, None)
    assert not fp.startswith("sf1:")
    assert not fp.startswith("sf2:")
    assert not fp.startswith("sf3:")
    assert not fp.startswith("sf4:")
