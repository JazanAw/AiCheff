"""P2 — Provenienz- und Extraktorversion bleiben erhalten und wirken im Fingerprint.

Reproduzierter Fehler (vor dem Fix): zwei ansonsten identische Analysen mit
OCR-Evidenz + ``ocr_version="ocr-v1"`` bzw. ``"ocr-v2"`` erzeugten denselben
``sourceFingerprint`` — die normalisierte akzeptierte Evidenz verwarf die
Extraktorversion. Jetzt traegt die akzeptierte Evidenz die volle Provenienz
(producer/producerVersion/extractorVersion/modelVersion/connector/originalField),
die in den Fingerprint eingeht. Abgelehnte/untrusted Evidenz aendert ihn nicht.

Vertrauenswuerdige Evidenz kommt ausschliesslich ueber den getrennten
``TrustedEvidenceContext`` (privilegierte Quellen werden von normalen Offer-Feldern
nicht akzeptiert). Konkrete Produktnamen leben AUSSCHLIESSLICH hier als Fixtures.
"""

from __future__ import annotations

from aichef_offers.product_analysis import (
    SOURCE_MANUFACTURER,
    TrustedEvidenceContext,
    build_product_analysis,
)


def _none_nutrition() -> dict:
    return {
        "source": "none",
        "per_100g": {"kcal": None, "protein_g": None, "carbs_g": None, "fat_g": None, "sugars_g": None, "salt_g": None, "fiber_g": None},
        "confidence": 0.0,
    }


def _fp(offer, trusted=None, evidence_inputs=None):
    return build_product_analysis(
        offer, None, _none_nutrition(), trusted=trusted, evidence_inputs=evidence_inputs, now="t",
    )["sourceFingerprint"]


# ===========================================================================
# Unterschiedliche Provenienzversionen -> unterschiedliche Fingerprints
# ===========================================================================
def test_ocr_extractor_version_changes_fingerprint():
    base = {"name": "Keks", "barcode": "1"}
    t1 = TrustedEvidenceContext(
        ocr=[{"claim": "allergen", "code": "nuts", "status": "contains", "confidence": 0.6}],
        ocr_version="ocr-v1",
    )
    t2 = TrustedEvidenceContext(
        ocr=[{"claim": "allergen", "code": "nuts", "status": "contains", "confidence": 0.6}],
        ocr_version="ocr-v2",
    )
    assert _fp(dict(base), trusted=t1) != _fp(dict(base), trusted=t2)


def test_ai_model_version_changes_fingerprint():
    base = {"name": "Aufstrich", "barcode": "1"}
    t1 = TrustedEvidenceContext(ai=[{"claim": "vegan", "status": "no", "confidence": 0.6}], ai_model_version="m-A")
    t2 = TrustedEvidenceContext(ai=[{"claim": "vegan", "status": "no", "confidence": 0.6}], ai_model_version="m-B")
    assert _fp(dict(base), trusted=t1) != _fp(dict(base), trusted=t2)


def test_connector_version_changes_fingerprint():
    base = {"name": "X", "barcode": "1"}
    t1 = TrustedEvidenceContext(retailer=[{"claim": "vegan", "status": "no", "confidence": 0.9, "connector": "rewe", "producerVersion": "1"}])
    t2 = TrustedEvidenceContext(retailer=[{"claim": "vegan", "status": "no", "confidence": 0.9, "connector": "rewe", "producerVersion": "2"}])
    assert _fp(dict(base), trusted=t1) != _fp(dict(base), trusted=t2)


# ===========================================================================
# Gleiche Provenienz, andere Reihenfolge -> gleicher Fingerprint
# ===========================================================================
def test_same_evidence_provenance_other_order_same_fingerprint():
    base = {"name": "X", "barcode": "1"}
    items = [
        {"claim": "vegan", "status": "no", "confidence": 0.6, "connector": "a", "producerVersion": "1"},
        {"claim": "vegetarian", "status": "no", "confidence": 0.6, "connector": "a", "producerVersion": "1"},
    ]
    t1 = TrustedEvidenceContext(retailer=[dict(i) for i in items])
    t2 = TrustedEvidenceContext(retailer=[dict(i) for i in reversed(items)])
    assert _fp(dict(base), trusted=t1) == _fp(dict(base), trusted=t2)


# ===========================================================================
# Abgelehnte/untrusted Evidenz aendert den Fingerprint NICHT
# ===========================================================================
def test_untrusted_spoof_does_not_change_fingerprint():
    base_fp = _fp({"name": "Wurst", "barcode": "1"})
    spoofed_fp = _fp({
        "name": "Wurst",
        "barcode": "1",
        "evidenceInputs": [{"claim": "vegan", "status": "yes", "source": SOURCE_MANUFACTURER, "confidence": 1}],
    })
    assert base_fp == spoofed_fp


# ===========================================================================
# Akzeptierte Evidenz-Ausgabe enthaelt Provenienz
# ===========================================================================
def test_accepted_evidence_output_contains_provenance():
    t = TrustedEvidenceContext(
        ocr=[{"claim": "allergen", "code": "nuts", "status": "contains", "confidence": 0.6}],
        ocr_version="ocr-v1",
    )
    a = build_product_analysis({"name": "Keks"}, None, _none_nutrition(), trusted=t, now="t")
    assert a["acceptedEvidence"]
    assert any(e.get("provenance", {}).get("extractorVersion") == "ocr-v1" for e in a["acceptedEvidence"])


def test_accepted_evidence_carries_model_version_provenance():
    t = TrustedEvidenceContext(ai=[{"claim": "vegan", "status": "no", "confidence": 0.6}], ai_model_version="qwen3:14b")
    a = build_product_analysis({"name": "Aufstrich"}, None, _none_nutrition(), trusted=t, now="t")
    assert any(e.get("provenance", {}).get("modelVersion") == "qwen3:14b" for e in a["acceptedEvidence"])
