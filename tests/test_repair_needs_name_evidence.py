"""Keyword-Reparaturen duerfen ein Urteil nur ueberstimmen, wenn ihr Beleg im
PRODUKTNAMEN steht.

Beobachtet im Lauf 2026-08-17: Das Modell hatte die Produktform korrekt erkannt
("MEINE BACKWELT Apfelecke" -> "suggests a bakery", "RIO D'ORO
Bananen-Kirsch-Getraenk" -> "is a fruit drink"), und `repair:produce_keyword`
bog beide allein wegen des Wortes "gemuese" in der HAENDLER-ABTEILUNG zu
Obst & Gemuese um. Eine Abteilung sagt aber nur, wo etwas im Laden liegt — und
sie ist nachweislich gemischt.

Produktnamen sind reine Reproduktions-Fixtures; der Code kennt keine
Produkt-/Marken-Allowlist.
"""
from __future__ import annotations

from offers_categorizer.core import (
    DEFAULT_TAXONOMY_PATH,
    CanonicalCategory,
    apply_auto_repair,
    load_taxonomy,
    text_normalize,
)

TAX = load_taxonomy(DEFAULT_TAXONOMY_PATH)


class _Offer:
    def __init__(self, title: str, brand: str = "", scat: str = "", sdep: str = "") -> None:
        self.title = title
        self.title_norm = text_normalize(title)
        self.brand = brand
        self.brand_norm = text_normalize(brand)
        self.source_category = scat
        self.source_category_norm = text_normalize(scat)
        self.source_department = sdep
        self.source_department_norm = text_normalize(sdep)


def _cat(main: str, sub: str = "unknown", confidence: float = 0.9) -> CanonicalCategory:
    return CanonicalCategory(
        main=main,
        sub=sub,
        secondary=[],
        is_non_food=False,
        confidence=confidence,
        reasons=["llm"],
        halal={"status": "unknown", "confidence": 0.35, "reasons": []},
    )


def _repair(category: CanonicalCategory, offer: _Offer):
    repaired, _overridden, _reasons, suspects = apply_auto_repair(
        category=category, offer=offer, taxonomy=TAX
    )
    return repaired, suspects


def test_source_department_alone_does_not_override_the_verdict() -> None:
    """Der echte Apfelecke-Fall: Backwaren bleibt Backwaren."""
    offer = _Offer("MEINE BACKWELT Apfelecke", scat="Wochenangebote - Backwaren", sdep="Obst/Gemüse")
    repaired, suspects = _repair(_cat("Backwaren", "Kuchen & Gebäck"), offer)

    assert repaired.main == "Backwaren"
    # Der schwache Hinweis geht nicht verloren, sondern wird zur Review markiert.
    assert "suspect:source_only_category_hint" in suspects


def test_source_department_alone_does_not_turn_a_drink_into_produce() -> None:
    """Der echte RIO-D'ORO-Fall: ein Fruchtgetraenk bleibt ein Getraenk."""
    offer = _Offer("RIO D'ORO Bananen-Kirsch-Getränk", scat="Getränke", sdep="Obst/Gemüse")
    repaired, suspects = _repair(_cat("Getränke alkoholfrei", "Säfte"), offer)

    assert repaired.main == "Getränke alkoholfrei"
    assert "suspect:source_only_category_hint" in suspects


def test_name_evidence_still_repairs() -> None:
    """Gegenprobe: Steht der Beleg im NAMEN, muss die Reparatur weiterhin greifen —
    sonst waere der Schutz gegen falsche Modellurteile weg."""
    offer = _Offer("Grünländer Käse Scheiben", scat="Süßwaren", sdep="Süßwaren")
    repaired, _suspects = _repair(_cat("Süßwaren & Snacks"), offer)

    assert repaired.main == "Milchprodukte & Eier"


def test_name_evidence_wins_over_a_contradicting_department() -> None:
    """Ein Produktname mit klarem Gemuese-Beleg bleibt reparierbar, auch wenn die
    Abteilung etwas anderes sagt.

    Hinweis: Der Beleg muss ein eigenes TOKEN sein — `keyword_match` vergleicht
    Einzelwoerter exakt gegen den Token-Satz. Ein Kompositum wie
    "Rispentomaten" trifft "tomaten" deshalb nicht; das war schon vor dieser
    Absicherung so und ist keine Regression."""
    offer = _Offer("Frische Tomaten", scat="Wochenangebote", sdep="Süßwaren")
    repaired, _suspects = _repair(_cat("Süßwaren & Snacks"), offer)

    assert repaired.main == "Obst & Gemüse"
