"""P1 — Unveraenderliche Sicherheitsinvarianten.

Externe, hoeher gerankte Evidenz (z. B. Hersteller-Halal-Claim) darf einen
belegten harten biologischen Ausschluss (Schwein, Alkohol > Grenzwert, tierische
Zutat, Fleisch/Fisch) NIEMALS ueberschreiben. Der sichere negative Status bleibt
bestehen, der Konflikt bleibt sichtbar und loest reviewNeeded aus.

Konkrete Produktnamen leben AUSSCHLIESSLICH hier als Fixtures — der Produktivcode
kennt keine Produkt-/Marken-Allowlist und keine kalenderwochenabhaengige Logik.
"""

from __future__ import annotations

from aichef_offers.product_analysis import (
    SOURCE_AI,
    SOURCE_MANUFACTURER,
    build_product_analysis,
)


def _none_nutrition() -> dict:
    return {
        "source": "none",
        "per_100g": {"kcal": None, "protein_g": None, "carbs_g": None, "fat_g": None, "sugars_g": None, "salt_g": None, "fiber_g": None},
        "confidence": 0.0,
    }


def analyze(name, *, off=None, evidence=None, category=None):
    offer = {"name": name}
    if category:
        offer["canonicalCategory"] = {"main": category}
    return build_product_analysis(offer, off, _none_nutrition(), evidence_inputs=evidence)


def _has_override_review(a) -> bool:
    return any("safety_override" in r or "conflict" in r for r in a["reviewReasons"])


# ===========================================================================
# Reproduktionen: hoeher gerankte Evidenz darf Ausschluss NICHT kippen
# ===========================================================================
def test_pork_ingredient_overrides_manufacturer_halal_claim():
    ev = [{"claim": "halal", "status": "halal", "source": SOURCE_MANUFACTURER, "confidence": 0.99, "reason": "manufacturer:halal_cert"}]
    a = analyze("Wurst", off={"ingredients_text": "Schweinefleisch, Salz"}, evidence=ev)
    assert a["halal"]["status"] == "not_halal"
    assert a["reviewNeeded"] is True
    assert _has_override_review(a)


def test_alcohol_over_limit_overrides_manufacturer_halal_claim():
    ev = [{"claim": "halal", "status": "halal", "source": SOURCE_MANUFACTURER, "confidence": 0.99, "reason": "manufacturer:halal_cert"}]
    a = analyze("Bier 5 % vol", evidence=ev)
    assert a["halal"]["status"] == "not_halal"
    assert a["reviewNeeded"] is True
    assert _has_override_review(a)


def test_animal_ingredient_overrides_manufacturer_vegan_claim():
    ev = [{"claim": "vegan", "status": "yes", "source": SOURCE_MANUFACTURER, "confidence": 0.99, "reason": "manufacturer:vegan"}]
    a = analyze("Aufstrich", off={"ingredients_text": "Wasser, Milch, Ei, Salz"}, evidence=ev)
    assert a["vegan"]["status"] == "no"
    assert a["reviewNeeded"] is True
    assert _has_override_review(a)


def test_meat_overrides_manufacturer_vegetarian_claim():
    ev = [{"claim": "vegetarian", "status": "yes", "source": SOURCE_MANUFACTURER, "confidence": 0.99, "reason": "manufacturer:veg"}]
    a = analyze("Rindfleisch", evidence=ev)
    assert a["vegetarian"]["status"] == "no"
    assert a["reviewNeeded"] is True
    assert _has_override_review(a)


def test_fish_overrides_manufacturer_vegetarian_claim():
    ev = [{"claim": "vegetarian", "status": "yes", "source": SOURCE_MANUFACTURER, "confidence": 0.99, "reason": "manufacturer:veg"}]
    a = analyze("Lachsfilet", off={"ingredients_text": "Lachs, Salz"}, evidence=ev)
    assert a["vegetarian"]["status"] == "no"
    assert a["reviewNeeded"] is True
    assert _has_override_review(a)


# ===========================================================================
# Positive Faelle: Invarianten greifen NUR bei echtem Ausschluss
# ===========================================================================
def test_safe_vegan_ingredient_survives_weak_ai_negative():
    # Belegt veganes Produkt (OFF) gegen schwache KI-Negativaussage (Rang 6).
    off = {"ingredients_analysis_tags": ["en:vegan"], "ingredients_text": "Wasser, Sonnenblumenoel, Salz"}
    ev = [{"claim": "vegan", "status": "no", "source": SOURCE_AI, "confidence": 0.4, "modelVersion": "qwen3:14b", "reason": "ai:guess"}]
    a = analyze("Brotaufstrich", off=off, evidence=ev)
    assert a["vegan"]["status"] == "yes"


def test_unknown_meat_origin_without_pork_stays_doubtful():
    a = analyze("Haehnchenbrust")
    assert a["halal"]["status"] == "doubtful"


def test_positive_halal_certificate_without_exclusion_holds():
    ev = [{"claim": "halal", "status": "halal", "source": SOURCE_MANUFACTURER, "confidence": 0.95, "reason": "manufacturer:halal_cert"}]
    a = analyze("Datteln", evidence=ev)
    assert a["halal"]["status"] == "halal"


def test_every_override_has_machine_readable_review_reason():
    ev = [{"claim": "halal", "status": "halal", "source": SOURCE_MANUFACTURER, "confidence": 0.99, "reason": "manufacturer:halal_cert"}]
    a = analyze("Wurst", off={"ingredients_text": "Schweinefleisch"}, evidence=ev)
    assert any(r.startswith("halal:safety_override") for r in a["reviewReasons"])
    # Verworfene Evidenz wird diagnostisch gespeichert.
    assert any(o["claim"] == "halal" and o["discardedStatus"] == "halal" for o in a["safetyOverrides"])


def test_safe_negative_persists_without_extra_review_when_uncontested():
    # Ohne widersprechende Evidenz: not_halal steht, aber KEIN safety_override.
    a = analyze("Bier 5 % vol")
    assert a["halal"]["status"] == "not_halal"
    assert not any("safety_override" in r for r in a["reviewReasons"])
