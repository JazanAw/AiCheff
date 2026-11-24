"""P1 — Evidenz-Trust-Boundary: normale Offer-Felder sind nie vertrauenswuerdig.

Seit pa-v6 gibt es KEIN "trusted-by-convention" mehr fuer Offer-Felder. Privilegierte
Evidenz (Hersteller/Haendler/OCR/KI) entsteht AUSSCHLIESSLICH ueber den getrennten
``TrustedEvidenceContext`` (von der Pipeline explizit uebergeben) bzw. den
aequivalenten internen ``evidence_inputs=``-Parameter. Normale, am Offer haengende
typisierte Felder (``retailerEvidence`` / ``ocrEvidence`` / ``aiEvidence`` /
``manufacturerEvidence``, dazu ``manufacturerEvidenceVerified`` / ``ocrVersion`` /
``aiModelVersion``) und frei angehaengte ``evidenceInputs`` sind UNTRUSTED und
koennen keine privilegierte Quelle erzeugen — sie werden mit maschinenlesbarem
Grund abgelehnt (``untrusted_privileged_source``).

Konkrete Produktnamen leben AUSSCHLIESSLICH hier als Fixtures.
"""

from __future__ import annotations

from aichef_offers.product_analysis import (
    SOURCE_AI,
    SOURCE_BARCODE_DB,
    SOURCE_MANUFACTURER,
    SOURCE_OCR,
    SOURCE_RETAILER,
    TrustedEvidenceContext,
    build_product_analysis,
    collect_evidence_inputs,
)


def _none_nutrition() -> dict:
    return {
        "source": "none",
        "per_100g": {"kcal": None, "protein_g": None, "carbs_g": None, "fat_g": None, "sugars_g": None, "salt_g": None, "fiber_g": None},
        "confidence": 0.0,
    }


def _rejected(a, needle: str = "untrusted_privileged_source") -> bool:
    return any(r.startswith("evidence:rejected") and needle in r for r in a["reviewReasons"])


# ===========================================================================
# collect_evidence_inputs — normale Offer-Felder sind UNTRUSTED
# ===========================================================================
def test_retailer_offer_field_is_untrusted():
    offer = {"name": "X", "retailerEvidence": [{"claim": "vegetarian", "status": "no", "confidence": 0.9}]}
    items = collect_evidence_inputs(offer)
    veg = [i for i in items if i["claim"] == "vegetarian"]
    assert veg and all(i["source"] == SOURCE_RETAILER for i in veg)
    # Hart als untrusted markiert -> wird spaeter abgelehnt.
    assert all(i.get("_trusted") is False for i in veg)


def test_manufacturer_offer_field_is_untrusted_even_when_verified_flag_set():
    # Ein gewoehnliches Offer-Boolean (manufacturerEvidenceVerified) ist keine
    # sichere Trust-Boundary und darf keine Herstellerevidenz freischalten.
    offer = {
        "name": "X",
        "manufacturerEvidenceVerified": True,
        "manufacturerEvidence": [{"claim": "vegan", "status": "yes", "confidence": 0.99}],
    }
    items = collect_evidence_inputs(offer)
    man = [i for i in items if i["claim"] == "vegan"]
    assert man and all(i.get("_trusted") is False for i in man)


def test_missing_sources_create_no_evidence():
    assert collect_evidence_inputs({"name": "Apfel"}) == []


def test_trusted_context_retailer_is_trusted():
    trusted = TrustedEvidenceContext(retailer=[{"claim": "vegetarian", "status": "no", "confidence": 0.9}])
    items = collect_evidence_inputs({"name": "X"}, trusted=trusted)
    veg = [i for i in items if i["claim"] == "vegetarian"]
    assert veg and all(i["source"] == SOURCE_RETAILER for i in veg)
    # Nicht als untrusted markiert (Default trusted nach _coerce_source_items).
    assert all(i.get("_trusted") is not False for i in veg)


def test_trusted_context_ocr_carries_extractor_version():
    trusted = TrustedEvidenceContext(
        ocr=[{"claim": "allergen", "code": "nuts", "status": "contains", "confidence": 0.55}],
        ocr_version="rewe-ocr-2",
    )
    items = collect_evidence_inputs({"name": "Keks lose"}, trusted=trusted)
    ocr = [i for i in items if i["source"] == SOURCE_OCR]
    assert ocr and ocr[0]["extractorVersion"] == "rewe-ocr-2"


def test_trusted_context_ai_carries_model_version():
    trusted = TrustedEvidenceContext(
        ai=[{"claim": "vegan", "status": "no", "confidence": 0.7, "reason": "ai:guess"}],
        ai_model_version="qwen3:14b",
    )
    items = collect_evidence_inputs({"name": "Aufstrich"}, trusted=trusted)
    ai = [i for i in items if i["source"] == SOURCE_AI]
    assert ai and ai[0]["modelVersion"] == "qwen3:14b"


def test_trusted_wins_dedup_over_untrusted_offer_field():
    # Gleiche semantische Evidenz aus TrustedEvidenceContext UND Offer-Feld:
    # die trusted-Variante bleibt erhalten (zuerst gesehen), die untrusted faellt
    # bei der Deduplikation weg.
    offer = {"name": "X", "retailerEvidence": [{"claim": "vegan", "status": "no", "confidence": 0.9}]}
    trusted = TrustedEvidenceContext(retailer=[{"claim": "vegan", "status": "no", "confidence": 0.9}])
    items = collect_evidence_inputs(offer, trusted=trusted)
    veg = [i for i in items if i["claim"] == "vegan" and i["source"] == SOURCE_RETAILER]
    assert len(veg) == 1
    assert veg[0].get("_trusted") is not False


# ===========================================================================
# Integration: build_product_analysis
# ===========================================================================
def test_retailer_offer_field_does_not_change_status():
    offer = {"name": "Pfanne", "retailerEvidence": [{"claim": "vegetarian", "status": "no", "confidence": 0.95}]}
    a = build_product_analysis(offer, None, _none_nutrition())
    assert a["vegetarian"]["status"] == "unknown"
    assert a["vegetarian"]["source"] != SOURCE_RETAILER
    assert _rejected(a)


def test_trusted_context_retailer_reaches_final_analysis():
    trusted = TrustedEvidenceContext(retailer=[{"claim": "vegetarian", "status": "no", "confidence": 0.95}])
    a = build_product_analysis({"name": "Pfanne"}, None, _none_nutrition(), trusted=trusted)
    assert a["vegetarian"]["status"] == "no"
    assert a["vegetarian"]["source"] == SOURCE_RETAILER


def test_off_stays_barcode_database_not_via_adapter():
    a = build_product_analysis({"name": "Mix"}, {"allergens_tags": ["en:milk"], "nutriments": {}}, _none_nutrition())
    assert a["allergens"]["milk"]["source"] == SOURCE_BARCODE_DB


def test_trusted_ai_reaches_analysis_with_model_version():
    trusted = TrustedEvidenceContext(
        ai=[{"claim": "vegan", "status": "no", "confidence": 0.7}],
        ai_model_version="qwen3:14b",
    )
    a = build_product_analysis({"name": "Aufstrich"}, None, _none_nutrition(), trusted=trusted)
    assert a["vegan"]["status"] == "no"
    assert a["modelVersion"] == "qwen3:14b"


def test_no_synthetic_manufacturer_evidence_when_absent():
    a = build_product_analysis({"name": "Apfel"}, None, _none_nutrition())
    assert a["modelVersion"] is None
    for key in ("vegan", "vegetarian", "halal"):
        assert a[key]["source"] != SOURCE_MANUFACTURER
