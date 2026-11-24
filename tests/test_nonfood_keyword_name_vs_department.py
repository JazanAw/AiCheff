"""Non-Food-Keywords: PRODUKTNAME vs. HÄNDLER-ABTEILUNG.

Befund im Lauf 2026-08-17: `RuleClassifier.classify` matchte die Non-Food-
Keywords auf dem zusammengesetzten Body (Titel + Marke + Quellkategorie +
Quellabteilung). Kauflands KOMBINIERTE Abteilung "Drogerie, Tiernahrung"
belegte damit ALLE 47 Angebote dieses Regals mit `nonfood_kw:tiernahrung`,
Konfidenz 0.99 und needs_llm=False — auch die Lebensmittel darin:

    ESN Isoclear Whey-Protein      (300-g-Packung, 15,99 EUR)
    KORO Proteinriegel             (55-g-Riegel,    1,79 EUR)
    APTAMIL Folgemilch 2 oder 3    (800-g-Packung, 14,99 EUR)

Eine Abteilung ist eine Regalzuordnung, keine Warenart. Ein Keyword, das nur
dort steht, ist deshalb ein HINWEIS (`nonfood_department_hint:`, Konfidenz 0.7,
needs_llm=True) und kein abschließendes Urteil. Steht das Keyword im
Produktnamen, bleibt es das harte 0.99-Urteil.

Produktnamen sind reine Reproduktions-Fixtures — der Code kennt keine
Produkt-/Marken-Allowlist.
"""
from __future__ import annotations

from offers_categorizer.core import (
    DEFAULT_TAXONOMY_PATH,
    RuleClassifier,
    load_taxonomy,
    text_normalize,
)

TAX = load_taxonomy(DEFAULT_TAXONOMY_PATH)
KAUFLAND_DRUGSTORE_AISLE = "Drogerie, Tiernahrung"


class _Offer:
    def __init__(self, title: str, brand: str = "", scat: str = "", sdep: str = "") -> None:
        self.title_norm = text_normalize(title)
        self.brand_norm = text_normalize(brand)
        self.source_category_norm = text_normalize(scat)
        self.source_department_norm = text_normalize(sdep)


def _classify(title: str, scat: str = "", brand: str = "", sdep: str = ""):
    clf = RuleClassifier(taxonomy=TAX, min_rule_score=3.0)
    return clf.classify(_Offer(title, brand=brand, scat=scat, sdep=sdep))


def _reasons(result) -> list[str]:
    return list(result.category.reasons)


def test_department_only_keyword_is_a_hint_not_a_hard_verdict() -> None:
    for title in (
        "ESN Isoclear Whey-Protein",
        "KORO Proteinriegel",
        "APTAMIL Folgemilch 2 oder 3",
    ):
        result = _classify(title, scat=KAUFLAND_DRUGSTORE_AISLE)
        reasons = _reasons(result)
        # Kein `nonfood_kw:`-Beleg mehr — das Keyword steht nicht im Namen.
        assert not any(r.startswith("nonfood_kw:") for r in reasons), (title, reasons)
        # Der Abteilungs-Hinweis bleibt sichtbar, aber weich und KI-pflichtig.
        assert any(r.startswith("nonfood_department_hint:") for r in reasons), (title, reasons)
        assert result.category.confidence < 0.99, title
        assert result.needs_llm is True, title


def test_keyword_in_the_product_name_stays_a_hard_verdict() -> None:
    for title in (
        "ANIMONDA GranCarno Hundenahrung",
        "PANTENE PRO-V Shampoo",
        "MEISTER PROPER Reiniger",
    ):
        result = _classify(title, scat=KAUFLAND_DRUGSTORE_AISLE)
        reasons = _reasons(result)
        assert any(r.startswith("nonfood_kw:") for r in reasons), (title, reasons)
        assert result.category.is_non_food is True, title
        assert result.category.confidence == 0.99, title
        assert result.needs_llm is False, title


def test_department_hint_still_marks_non_food_for_a_plain_drugstore_item() -> None:
    # Ein Artikel ohne eigenes Keyword im Namen bleibt Non-Food — nur eben
    # überprüfbar (needs_llm) statt hart.
    result = _classify("ALWAYS Discreet", scat=KAUFLAND_DRUGSTORE_AISLE)
    assert result.category.is_non_food is True
    assert result.needs_llm is True


def test_pure_food_department_is_untouched() -> None:
    result = _classify("Dtsch. Lauchzwiebeln", scat="Obst, Gemüse, Pflanzen")
    reasons = _reasons(result)
    assert result.category.is_non_food is False, reasons
    assert not any(r.startswith("nonfood_department_hint:") for r in reasons), reasons
