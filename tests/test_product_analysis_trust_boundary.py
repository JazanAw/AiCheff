"""P1/P2 — Trust-Boundary fuer Evidenzquellen.

Reproduzierte Luecken (vor dem Fix):

* P1 — Frei an ein Offer angehaengte ``evidenceInputs`` konnten eine
  privilegierte Quelle (``manufacturer_label``/``retailer_structured``/
  ``ocr_extracted``/``ai``) SELBST behaupten und so die Vertrauenspruefung des
  verifizierten ``manufacturerEvidence``-Pfads umgehen. Untrusted Offer-Daten
  duerfen keine privilegierte Quelle erschleichen.
* P2 — ``source=unknown`` (oder eine fehlende Quelle) ist KEINE
  entscheidungsfaehige Evidenzquelle und darf niemals einen Status setzen.

Vertrauenswuerdige Evidenz wird ausschliesslich ueber getrennte Funktions-
parameter / einen ``TrustedEvidenceContext`` aus der Pipeline uebergeben — nie
durch ein frei vom externen Payload setzbares Feld.

Konkrete Produktnamen leben AUSSCHLIESSLICH hier als Fixtures.
"""

from __future__ import annotations

from aichef_offers.product_analysis import (
    SOURCE_AI,
    SOURCE_MANUFACTURER,
    SOURCE_OCR,
    SOURCE_RETAILER,
    TrustedEvidenceContext,
    build_product_analysis,
    collect_evidence_inputs,
    validate_evidence_input,
)


def _none_nutrition() -> dict:
    return {
        "source": "none",
        "per_100g": {"kcal": None, "protein_g": None, "carbs_g": None, "fat_g": None, "sugars_g": None, "salt_g": None, "fiber_g": None},
        "confidence": 0.0,
    }


def _rejected(a, needle: str) -> bool:
    return any(r.startswith("evidence:rejected") and needle in r for r in a["reviewReasons"])


# ===========================================================================
# P1 — Angeheftete evidenceInputs duerfen keine Quelle erschleichen
# ===========================================================================
def test_attached_manufacturer_label_without_verification_is_rejected():
    # Genau der reproduzierte Exploit: ein angehaengter evidenceInput behauptet
    # manufacturer_label ohne verifizierten Herstellerpfad.
    offer = {
        "name": "Wurst",
        "evidenceInputs": [
            {"claim": "vegan", "status": "yes", "source": SOURCE_MANUFACTURER, "confidence": 1},
        ],
    }
    a = build_product_analysis(offer, None, _none_nutrition())
    assert a["vegan"]["status"] != "yes"
    assert a["vegan"]["source"] != SOURCE_MANUFACTURER
    assert _rejected(a, "untrusted_privileged_source")


def test_attached_retailer_structured_cannot_claim_its_source():
    offer = {
        "name": "Pfanne",
        "evidenceInputs": [
            {"claim": "vegetarian", "status": "no", "source": SOURCE_RETAILER, "confidence": 0.95},
        ],
    }
    a = build_product_analysis(offer, None, _none_nutrition())
    assert a["vegetarian"]["source"] != SOURCE_RETAILER
    assert _rejected(a, "untrusted_privileged_source")


def test_attached_ocr_without_real_ocr_context_is_rejected():
    offer = {
        "name": "Keks",
        "evidenceInputs": [
            {"claim": "allergen", "code": "nuts", "status": "contains", "source": SOURCE_OCR, "confidence": 0.6},
        ],
    }
    a = build_product_analysis(offer, None, _none_nutrition())
    assert a["allergens"]["nuts"]["source"] != SOURCE_OCR
    assert _rejected(a, "untrusted_privileged_source")


def test_attached_ai_without_internal_ai_context_is_rejected():
    offer = {
        "name": "Aufstrich",
        "evidenceInputs": [
            {"claim": "vegan", "status": "no", "source": SOURCE_AI, "modelVersion": "qwen3:14b", "confidence": 0.7},
        ],
    }
    a = build_product_analysis(offer, None, _none_nutrition())
    assert a["vegan"]["source"] != SOURCE_AI
    assert a["modelVersion"] is None
    assert _rejected(a, "untrusted_privileged_source")


def test_external_fields_cannot_fake_trust_marker():
    # Ein gefaelschter interner Trust-Marker auf dem externen Payload darf NICHT
    # greifen — die Quelle bleibt untrusted und privilegierte Quellen werden
    # abgelehnt.
    offer = {
        "name": "Wurst",
        "evidenceInputs": [
            {"claim": "halal", "status": "halal", "source": SOURCE_MANUFACTURER, "confidence": 1,
             "_trusted": True, "__trusted__": True, "trusted": True},
        ],
    }
    a = build_product_analysis(offer, None, _none_nutrition())
    assert a["halal"]["source"] != SOURCE_MANUFACTURER
    assert _rejected(a, "untrusted_privileged_source")


# ===========================================================================
# P1 — Vertrauenswuerdige Evidenz ueber TrustedEvidenceContext funktioniert
# ===========================================================================
def test_trusted_manufacturer_evidence_works_via_context():
    trusted = TrustedEvidenceContext(
        manufacturer=[{"claim": "vegan", "status": "yes", "confidence": 0.99}],
        manufacturer_verified=True,
    )
    a = build_product_analysis({"name": "Datteln"}, None, _none_nutrition(), trusted=trusted)
    assert a["vegan"]["status"] == "yes"
    assert a["vegan"]["source"] == SOURCE_MANUFACTURER


def test_trusted_manufacturer_requires_verified_flag():
    trusted = TrustedEvidenceContext(
        manufacturer=[{"claim": "vegan", "status": "yes", "confidence": 0.99}],
        manufacturer_verified=False,
    )
    items = collect_evidence_inputs({"name": "X"}, trusted=trusted)
    assert not any(i["source"] == SOURCE_MANUFACTURER for i in items)


def test_trusted_retailer_evidence_works_via_context():
    trusted = TrustedEvidenceContext(retailer=[{"claim": "vegetarian", "status": "no", "confidence": 0.95}])
    a = build_product_analysis({"name": "Pfanne"}, None, _none_nutrition(), trusted=trusted)
    assert a["vegetarian"]["status"] == "no"
    assert a["vegetarian"]["source"] == SOURCE_RETAILER


def test_trusted_ocr_keeps_source_and_version():
    trusted = TrustedEvidenceContext(
        ocr=[{"claim": "allergen", "code": "nuts", "status": "contains", "confidence": 0.6}],
        ocr_version="rewe-ocr-2",
    )
    items = collect_evidence_inputs({"name": "Keks"}, trusted=trusted)
    ocr = [i for i in items if i["source"] == SOURCE_OCR]
    assert ocr and ocr[0]["extractorVersion"] == "rewe-ocr-2"


def test_trusted_ai_keeps_model_version():
    trusted = TrustedEvidenceContext(
        ai=[{"claim": "vegan", "status": "no", "confidence": 0.7}],
        ai_model_version="qwen3:14b",
    )
    a = build_product_analysis({"name": "Aufstrich"}, None, _none_nutrition(), trusted=trusted)
    assert a["vegan"]["status"] == "no"
    assert a["modelVersion"] == "qwen3:14b"


# ===========================================================================
# P2 — source=unknown / fehlende Quelle setzt niemals einen Status
# ===========================================================================
def test_unknown_source_vegan_yes_is_rejected():
    ok, reason, _ = validate_evidence_input({"claim": "vegan", "status": "yes", "source": "unknown", "confidence": 1})
    assert ok is False
    assert "non_authoritative_source" in reason


def test_unknown_source_halal_is_rejected():
    ok, reason, _ = validate_evidence_input({"claim": "halal", "status": "halal", "source": "unknown", "confidence": 1})
    assert ok is False
    assert "non_authoritative_source" in reason


def test_unknown_source_allergen_is_rejected():
    ok, reason, _ = validate_evidence_input({"claim": "allergen", "code": "milk", "status": "contains", "source": "unknown", "confidence": 1})
    assert ok is False
    assert "non_authoritative_source" in reason


def test_missing_source_is_rejected():
    ok, reason, _ = validate_evidence_input({"claim": "vegan", "status": "yes", "confidence": 1})
    assert ok is False
    assert "non_authoritative_source" in reason


def test_unknown_source_leaves_status_unchanged():
    # source=unknown darf eine belegte vegane Aussage NICHT auf yes ziehen und
    # NICHT die Regelentscheidung veraendern.
    ev = [{"claim": "vegan", "status": "yes", "source": "unknown", "confidence": 1}]
    a = build_product_analysis({"name": "Mix"}, None, _none_nutrition(), evidence_inputs=ev)
    assert a["vegan"]["status"] == "unknown"
    assert _rejected(a, "non_authoritative_source")


def test_unknown_source_rejection_is_deterministic():
    ev = [{"claim": "vegan", "status": "yes", "source": "unknown", "confidence": 1}]
    a1 = build_product_analysis({"name": "Mix", "barcode": "1"}, None, _none_nutrition(), evidence_inputs=list(ev), now="t")
    a2 = build_product_analysis({"name": "Mix", "barcode": "1"}, None, _none_nutrition(), evidence_inputs=list(ev), now="t")
    assert a1 == a2
    assert a1["sourceFingerprint"] == a2["sourceFingerprint"]
