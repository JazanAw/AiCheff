"""P4 — strikte Evidenzschema-Validierung.

Ungueltige Evidenz wird vor der Anwendung abgelehnt, veraendert keinen Status und
erzeugt einen maschinenlesbaren Diagnose-/Review-Grund. Kein stilles Coercing.

Konkrete Produktnamen leben AUSSCHLIESSLICH hier als Fixtures.
"""

from __future__ import annotations

import math

from aichef_offers.product_analysis import (
    SOURCE_AI,
    SOURCE_MANUFACTURER,
    build_product_analysis,
    validate_evidence_input,
)


def _none_nutrition() -> dict:
    return {
        "source": "none",
        "per_100g": {"kcal": None, "protein_g": None, "carbs_g": None, "fat_g": None, "sugars_g": None, "salt_g": None, "fiber_g": None},
        "confidence": 0.0,
    }


def analyze(name, *, off=None, evidence=None):
    return build_product_analysis({"name": name}, off, _none_nutrition(), evidence_inputs=evidence)


def _rejected(a) -> bool:
    return any(r.startswith("evidence:rejected") for r in a["reviewReasons"])


# ===========================================================================
# validate_evidence_input — Einzelpruefungen
# ===========================================================================
def test_vegan_maybe_is_rejected_not_coerced():
    ok, reason, norm = validate_evidence_input({"claim": "vegan", "status": "maybe", "source": SOURCE_MANUFACTURER})
    assert ok is False
    assert norm is None
    assert "invalid_status" in reason


def test_unknown_claim_is_rejected():
    ok, reason, _ = validate_evidence_input({"claim": "kosher", "status": "yes", "source": SOURCE_MANUFACTURER})
    assert ok is False
    assert "unknown_claim" in reason


def test_unknown_source_is_rejected():
    ok, reason, _ = validate_evidence_input({"claim": "vegan", "status": "no", "source": "wikipedia"})
    assert ok is False
    assert "unknown_source" in reason


def test_unknown_eu14_code_is_rejected():
    ok, reason, _ = validate_evidence_input({"claim": "allergen", "code": "coconut", "status": "contains", "source": SOURCE_MANUFACTURER})
    assert ok is False
    assert "allergen_code" in reason


def test_confidence_below_zero_is_rejected():
    ok, reason, _ = validate_evidence_input({"claim": "vegan", "status": "no", "source": SOURCE_MANUFACTURER, "confidence": -0.1})
    assert ok is False
    assert "confidence" in reason


def test_confidence_above_one_is_rejected():
    ok, reason, _ = validate_evidence_input({"claim": "vegan", "status": "no", "source": SOURCE_MANUFACTURER, "confidence": 1.5})
    assert ok is False
    assert "confidence" in reason


def test_nan_confidence_is_rejected():
    ok, reason, _ = validate_evidence_input({"claim": "vegan", "status": "no", "source": SOURCE_MANUFACTURER, "confidence": math.nan})
    assert ok is False
    assert "confidence" in reason


def test_infinity_confidence_is_rejected():
    ok, reason, _ = validate_evidence_input({"claim": "vegan", "status": "no", "source": SOURCE_MANUFACTURER, "confidence": math.inf})
    assert ok is False
    assert "confidence" in reason


def test_ai_without_model_version_is_rejected():
    ok, reason, _ = validate_evidence_input({"claim": "vegan", "status": "no", "source": SOURCE_AI, "confidence": 0.7})
    assert ok is False
    assert "no_model_version" in reason


def test_valid_ai_with_model_version_is_accepted():
    ok, reason, norm = validate_evidence_input(
        {"claim": "vegan", "status": "no", "source": SOURCE_AI, "confidence": 0.7, "modelVersion": "qwen3:14b"}
    )
    assert ok is True
    assert reason is None
    assert norm["model_version"] == "qwen3:14b"
    assert norm["is_ai"] is True


def test_non_ai_model_version_does_not_make_it_ai():
    ok, _, norm = validate_evidence_input(
        {"claim": "vegan", "status": "no", "source": SOURCE_MANUFACTURER, "confidence": 0.9, "modelVersion": "qwen3:14b"}
    )
    assert ok is True
    assert norm["is_ai"] is False
    assert norm["model_version"] is None


# ===========================================================================
# Integration in build_product_analysis
# ===========================================================================
def test_direct_model_version_without_ai_evidence_keeps_model_version_null():
    a = build_product_analysis({"name": "Apfel"}, None, _none_nutrition(), model_version="qwen3:14b")
    assert a["modelVersion"] is None


def test_valid_ai_evidence_sets_model_version():
    ev = [{"claim": "vegan", "status": "no", "source": SOURCE_AI, "confidence": 0.7, "modelVersion": "qwen3:14b"}]
    a = analyze("Aufstrich", evidence=ev)
    assert a["modelVersion"] == "qwen3:14b"


def test_invalid_evidence_does_not_change_status():
    # vegan=maybe (ungueltig) darf die Regelentscheidung (unknown) NICHT veraendern.
    ev = [{"claim": "vegan", "status": "maybe", "source": SOURCE_MANUFACTURER, "confidence": 0.9}]
    a = analyze("Mix", evidence=ev)
    assert a["vegan"]["status"] == "unknown"
    assert _rejected(a)


def test_mixed_valid_and_invalid_evidence():
    ev = [
        {"claim": "vegan", "status": "maybe", "source": SOURCE_MANUFACTURER, "confidence": 0.9},  # invalid
        {"claim": "vegetarian", "status": "no", "source": SOURCE_MANUFACTURER, "confidence": 0.9},  # valid
    ]
    a = analyze("Pfanne", evidence=ev)
    assert a["vegetarian"]["status"] == "no"  # valid applied
    assert a["vegan"]["status"] == "unknown"  # invalid ignored
    assert _rejected(a)


def test_unknown_source_does_not_override_decision():
    off = {"ingredients_analysis_tags": ["en:vegan"]}
    ev = [{"claim": "vegan", "status": "no", "source": "wikipedia", "confidence": 0.9}]
    a = analyze("Veganer Aufstrich", off=off, evidence=ev)
    assert a["vegan"]["status"] == "yes"
    assert _rejected(a)


def test_result_and_fingerprint_deterministic_with_invalid_evidence():
    ev = [{"claim": "vegan", "status": "maybe", "source": SOURCE_MANUFACTURER, "confidence": 0.9}]
    a1 = build_product_analysis({"name": "Mix", "barcode": "1"}, None, _none_nutrition(), evidence_inputs=list(ev), now="t")
    a2 = build_product_analysis({"name": "Mix", "barcode": "1"}, None, _none_nutrition(), evidence_inputs=list(ev), now="t")
    assert a1 == a2
