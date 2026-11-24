"""P1 — Trust-Boundary ueber den tatsaechlichen produktiven Weg ``core.enrich_offer``.

Die uebrigen ProductAnalysisV2-Tests rufen ``build_product_analysis()`` direkt
auf. Diese Tests gehen ueber ``core.enrich_offer`` — den realen Pipeline-Schritt,
den der Scan/Bridge-Pfad pro Angebot ausfuehrt — und pruefen die haerte
Trust-Boundary (pa-v6):

  * Normale, am Offer haengende Felder (``retailerEvidence`` / ``ocrEvidence`` /
    ``aiEvidence`` / ``manufacturerEvidence`` / ``manufacturerEvidenceVerified`` /
    angehaengte ``evidenceInputs``) sind UNTRUSTED und veraendern KEINEN Status.
  * Privilegierte Evidenz entsteht ausschliesslich ueber den getrennt an
    ``enrich_offer(..., trusted=TrustedEvidenceContext(...))`` uebergebenen Kontext.
  * Safety-Invariants halten auch mit echtem TrustedEvidenceContext.

Konkrete Produktnamen leben AUSSCHLIESSLICH hier als Fixtures.
"""

from __future__ import annotations

from pathlib import Path

from aichef_offers.core import NutritionCache, RunConfig, enrich_offer
from aichef_offers.product_analysis import (
    SOURCE_AI,
    SOURCE_BARCODE_DB,
    SOURCE_MANUFACTURER,
    SOURCE_OCR,
    SOURCE_RETAILER,
    TrustedEvidenceContext,
)


def _config(tmp_path: Path) -> RunConfig:
    return RunConfig(
        input_dir=tmp_path / "in",
        out_dir=tmp_path / "out",
        mode="overlap",
        as_of="2026-02-12",
        week_start="2026-02-09",
        week_window="calendar",
        week_end_day=None,
        include_locked=True,
        emit_visible=True,
        ollama_on=False,
        ollama_url="http://localhost:11434",
        ollama_model="llama3.1",
        ollama_timeout=8,
        ollama_max_consecutive_failures=0,
        national_on=True,
        national_threshold=0.8,
        min_rule_score=3.0,
        min_margin=1.5,
        embeddings_on=False,
        knn_k=5,
        knn_threshold=0.7,
        keywords_file=None,
        nutrition_on=True,
        nutrition_source="both",
        nutrition_ttl_days=30,
        max_off_req_per_min=200,
        bls_path=tmp_path / "bls",
        diet_on=True,
        halal_on=True,
        veg_implies_halal=False,
        dump_stats=True,
    )


class _StubOFFClient:
    """Minimaler OFF-Client fuer Integrationstests — ohne Netzwerk."""

    def __init__(self, by_gtin: dict[str, dict]) -> None:
        self._by_gtin = by_gtin

    def fetch(self, barcode: str) -> dict | None:  # noqa: D401 - mirrors OFFClient.fetch
        return self._by_gtin.get(str(barcode))


def _enrich(offer: dict, tmp_path: Path, off_client=None, trusted=None):
    cache = NutritionCache(tmp_path / "cache.sqlite")
    try:
        return enrich_offer(offer, off_client, [], cache, _config(tmp_path), trusted=trusted)
    finally:
        cache.close()


def _rejected(pa, needle: str = "untrusted_privileged_source") -> bool:
    return any(needle in r for r in pa["reviewReasons"])


# ===========================================================================
# Normale Offer-Felder duerfen NIEMALS einen Status veraendern
# ===========================================================================
def test_retailer_offer_field_does_not_change_status_via_pipeline(tmp_path):
    offer = {"id": "o1", "name": "Pfanne", "retailerEvidence": [{"claim": "vegetarian", "status": "no", "confidence": 0.95}]}
    pa = _enrich(offer, tmp_path)["productAnalysis"]
    assert pa["vegetarian"]["status"] == "unknown"
    assert pa["vegetarian"]["source"] != SOURCE_RETAILER
    assert _rejected(pa)


def test_ai_offer_field_does_not_change_status_via_pipeline(tmp_path):
    offer = {
        "id": "o2",
        "name": "Brotaufstrich",
        "aiModelVersion": "qwen3:14b",
        "aiEvidence": [{"claim": "vegan", "status": "no", "confidence": 0.7}],
    }
    pa = _enrich(offer, tmp_path)["productAnalysis"]
    assert pa["vegan"]["status"] == "unknown"
    assert pa["modelVersion"] is None
    assert _rejected(pa)


def test_manufacturer_offer_field_does_not_change_status_via_pipeline(tmp_path):
    offer = {
        "id": "o3",
        "name": "Datteln",
        "manufacturerEvidenceVerified": True,
        "manufacturerEvidence": [{"claim": "vegan", "status": "yes", "confidence": 0.99}],
    }
    pa = _enrich(offer, tmp_path)["productAnalysis"]
    assert pa["vegan"]["status"] != "yes"
    assert pa["vegan"]["source"] != SOURCE_MANUFACTURER
    assert _rejected(pa)


def test_ocr_offer_field_does_not_change_allergen_via_pipeline(tmp_path):
    offer = {
        "id": "o4",
        "name": "Keks lose",
        "ocrVersion": "rewe-ocr-2",
        "ocrEvidence": [{"claim": "allergen", "code": "nuts", "status": "contains", "confidence": 0.6}],
    }
    pa = _enrich(offer, tmp_path)["productAnalysis"]
    assert pa["allergens"]["nuts"]["status"] == "unknown"
    assert pa["allergens"]["nuts"]["source"] != SOURCE_OCR
    assert _rejected(pa)


def test_fake_trust_markers_have_no_effect_via_pipeline(tmp_path):
    offer = {
        "id": "o5",
        "name": "Wurst",
        "evidenceInputs": [
            {"claim": "halal", "status": "halal", "source": SOURCE_MANUFACTURER, "confidence": 1,
             "_trusted": True, "__trusted__": True, "trusted": True},
        ],
    }
    pa = _enrich(offer, tmp_path)["productAnalysis"]
    assert pa["halal"]["status"] != "halal"
    assert pa["halal"]["source"] != SOURCE_MANUFACTURER
    assert _rejected(pa)


def test_attached_evidence_inputs_stays_untrusted_via_pipeline(tmp_path):
    offer = {
        "id": "o6",
        "name": "Wurst",
        "evidenceInputs": [{"claim": "vegan", "status": "yes", "source": SOURCE_MANUFACTURER, "confidence": 1}],
    }
    pa = _enrich(offer, tmp_path)["productAnalysis"]
    assert pa["vegan"]["status"] != "yes"
    assert pa["vegan"]["source"] != SOURCE_MANUFACTURER
    assert _rejected(pa)


# ===========================================================================
# Vertrauenswuerdige Evidenz ueber den getrennten TrustedEvidenceContext
# ===========================================================================
def test_trusted_retailer_context_works_via_pipeline(tmp_path):
    trusted = TrustedEvidenceContext(retailer=[{"claim": "vegetarian", "status": "no", "confidence": 0.95}])
    pa = _enrich({"id": "t1", "name": "Pfanne"}, tmp_path, trusted=trusted)["productAnalysis"]
    assert pa["vegetarian"]["status"] == "no"
    assert pa["vegetarian"]["source"] == SOURCE_RETAILER


def test_trusted_ai_context_works_with_model_version_via_pipeline(tmp_path):
    trusted = TrustedEvidenceContext(
        ai=[{"claim": "vegan", "status": "no", "confidence": 0.7}],
        ai_model_version="qwen3:14b",
    )
    pa = _enrich({"id": "t2", "name": "Brotaufstrich"}, tmp_path, trusted=trusted)["productAnalysis"]
    assert pa["vegan"]["status"] == "no"
    assert pa["modelVersion"] == "qwen3:14b"


def test_trusted_ocr_context_works_with_extractor_version_via_pipeline(tmp_path):
    trusted = TrustedEvidenceContext(
        ocr=[{"claim": "allergen", "code": "nuts", "status": "contains", "confidence": 0.6}],
        ocr_version="rewe-ocr-2",
    )
    pa = _enrich({"id": "t3", "name": "Keks lose"}, tmp_path, trusted=trusted)["productAnalysis"]
    assert pa["allergens"]["nuts"]["status"] == "contains"
    assert pa["allergens"]["nuts"]["source"] == SOURCE_OCR
    # Provenienz (Extraktorversion) bleibt in der akzeptierten Evidenz erhalten.
    assert any(e.get("provenance", {}).get("extractorVersion") == "rewe-ocr-2" for e in pa["acceptedEvidence"])


def test_trusted_verified_manufacturer_context_works_via_pipeline(tmp_path):
    trusted = TrustedEvidenceContext(
        manufacturer=[{"claim": "vegan", "status": "yes", "confidence": 0.99}],
        manufacturer_verified=True,
    )
    pa = _enrich({"id": "t4", "name": "Datteln"}, tmp_path, trusted=trusted)["productAnalysis"]
    assert pa["vegan"]["status"] == "yes"
    assert pa["vegan"]["source"] == SOURCE_MANUFACTURER


def test_unverified_manufacturer_context_does_not_work_via_pipeline(tmp_path):
    trusted = TrustedEvidenceContext(
        manufacturer=[{"claim": "vegan", "status": "yes", "confidence": 0.99}],
        manufacturer_verified=False,
    )
    pa = _enrich({"id": "t5", "name": "Datteln"}, tmp_path, trusted=trusted)["productAnalysis"]
    assert pa["vegan"]["status"] != "yes"
    assert pa["vegan"]["source"] != SOURCE_MANUFACTURER


def test_no_context_creates_no_privileged_evidence_via_pipeline(tmp_path):
    pa = _enrich({"id": "t6", "name": "Apfel"}, tmp_path)["productAnalysis"]
    assert pa["modelVersion"] is None
    for key in ("vegan", "vegetarian", "halal"):
        assert pa[key]["source"] not in {SOURCE_MANUFACTURER, SOURCE_AI, SOURCE_RETAILER, SOURCE_OCR}


# ===========================================================================
# OFF bleibt separat barcode_database
# ===========================================================================
def test_off_product_stays_barcode_database_via_pipeline(tmp_path):
    off_client = _StubOFFClient({"4000001": {"allergens_tags": ["en:milk"], "nutriments": {}}})
    pa = _enrich({"id": "o7", "name": "Riegel", "gtin": "4000001"}, tmp_path, off_client=off_client)["productAnalysis"]
    assert pa["allergens"]["milk"]["source"] == SOURCE_BARCODE_DB


# ===========================================================================
# Safety-Invariants halten auch mit echtem TrustedEvidenceContext
# ===========================================================================
def test_pork_overrides_trusted_manufacturer_halal_via_pipeline(tmp_path):
    off_client = _StubOFFClient({"4000002": {"ingredients_text": "Schweinefleisch, Salz", "nutriments": {}}})
    offer = {"id": "o8", "name": "Wurst", "gtin": "4000002"}
    trusted = TrustedEvidenceContext(
        manufacturer=[{"claim": "halal", "status": "halal", "confidence": 0.99}],
        manufacturer_verified=True,
    )
    pa = _enrich(offer, tmp_path, off_client=off_client, trusted=trusted)["productAnalysis"]
    assert pa["halal"]["status"] == "not_halal"
    assert pa["reviewNeeded"] is True
    assert any("safety_override" in r for r in pa["reviewReasons"])


def test_alcohol_overrides_trusted_manufacturer_halal_via_pipeline(tmp_path):
    offer = {"id": "o9", "name": "Bier 5 % vol"}
    trusted = TrustedEvidenceContext(
        manufacturer=[{"claim": "halal", "status": "halal", "confidence": 0.99}],
        manufacturer_verified=True,
    )
    pa = _enrich(offer, tmp_path, trusted=trusted)["productAnalysis"]
    assert pa["halal"]["status"] == "not_halal"
    assert pa["reviewNeeded"] is True
    assert any("safety_override" in r for r in pa["reviewReasons"])
