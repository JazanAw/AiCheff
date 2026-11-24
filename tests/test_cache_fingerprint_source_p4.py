"""P4 — der Klassifizierer-Cache-Schlüssel muss ALLE entscheidungsrelevanten
Eingaben abdecken. Die Quell-Kategorie/-Abteilung fließen in detect_category_conflict
und das Food-Source-Signal ein; ein Cache-Key OHNE sie ließe denselben Produktnamen
in einer Food- vs. Non-Food-Abteilung auf EIN gecachtes Verdikt kollidieren (der
Spritzring-Fall, P2).

Bewusst getrennt: der Offer-IDENTITÄTS-Fingerprint (`offer_fingerprint`) bleibt OHNE
Quell-Abteilung, damit dasselbe Produkt snapshot-übergreifend zu EINER Gruppe
verschmilzt; der Entscheidungs-Cache nutzt `classification_cache_key`. Keine
Produkt-/Marken-Allowlist — reine Strukturtests.
"""
from __future__ import annotations

from offers_categorizer.core import (
    CLASSIFIER_SCHEMA_VERSION,
    OfferRecord,
    classification_cache_key,
    offer_fingerprint,
    text_normalize,
)


def _record(
    *,
    scat: str = "",
    sdep: str = "",
    chain: str = "netto",
    title: str = "spritzring",
    brand: str = "",
    size: str = "",
    price: float = 1.99,
    validity_start: str = "2026-06-15",
    validity_end: str = "2026-06-20",
) -> OfferRecord:
    chain_norm = text_normalize(chain)
    title_norm = text_normalize(title)
    fingerprint = offer_fingerprint(
        chain_norm=chain_norm,
        title_norm=title_norm,
        brand_norm=text_normalize(brand),
        size_norm=text_normalize(size),
        price=price,
        validity_start_raw=validity_start,
        validity_end_raw=validity_end,
        gtin_or_ean="",
    )
    return OfferRecord(
        fingerprint=fingerprint,
        raw_offer={},
        title=title,
        title_norm=title_norm,
        brand=brand,
        brand_norm=text_normalize(brand),
        source_category="",
        source_category_norm=text_normalize(scat),
        source_department="",
        source_department_norm=text_normalize(sdep),
        chain=chain,
        chain_norm=chain_norm,
        size_or_unit=size,
        price=price,
        validity_start=None,
        validity_end=None,
        validity_start_raw=validity_start,
        validity_end_raw=validity_end,
        gtin_or_ean="",
        tags=[],
        tags_norm=[],
        ingredients_text="",
        ingredients_norm="",
        source_file="x",
        snapshot_id="s",
    )


def test_schema_version_bumped_for_cache_key_change() -> None:
    # Der Versions-Bump entwertet alte (unvollständige) Cache-Einträge kontrolliert.
    assert CLASSIFIER_SCHEMA_VERSION == "cat-schema-v4"


def test_identity_fingerprint_is_independent_of_source_department() -> None:
    # Die snapshot-übergreifende Gruppierung darf sich an der Quell-Abteilung NICHT
    # aufspalten (sonst verschmelzen Duplikate nicht mehr).
    assert _record(scat="getraenke").fingerprint == _record(scat="haushalt").fingerprint


def test_decision_key_changes_with_source_category() -> None:
    # Getränke (Food) vs. Haushalt (Non-Food) → unterschiedlicher Entscheidungs-Cache-Key.
    assert classification_cache_key(_record(scat="getraenke alkoholfrei")) != (
        classification_cache_key(_record(scat="haushalt"))
    )


def test_decision_key_changes_with_source_department() -> None:
    assert classification_cache_key(_record(sdep="backwaren")) != (
        classification_cache_key(_record(sdep="drogerie"))
    )


def test_decision_key_is_stable_for_identical_inputs() -> None:
    assert classification_cache_key(_record(scat="getraenke")) == (
        classification_cache_key(_record(scat="getraenke"))
    )


def test_decision_key_ignores_weekly_offer_price_and_validity() -> None:
    previous_week = _record(
        price=1.99,
        validity_start="2026-06-15",
        validity_end="2026-06-20",
    )
    next_week = _record(
        price=2.29,
        validity_start="2026-06-22",
        validity_end="2026-06-27",
    )

    # The volatile offer fingerprints differ, but the model sees the same input.
    assert previous_week.fingerprint != next_week.fingerprint
    assert classification_cache_key(previous_week) == classification_cache_key(next_week)


def test_decision_key_namespaces_model_and_taxonomy() -> None:
    offer = _record(scat="getraenke")
    assert classification_cache_key(offer, model="qwen3:14b", taxonomy_signature="tax-a") != (
        classification_cache_key(offer, model="qwen3:8b", taxonomy_signature="tax-a")
    )
    assert classification_cache_key(offer, model="qwen3:14b", taxonomy_signature="tax-a") != (
        classification_cache_key(offer, model="qwen3:14b", taxonomy_signature="tax-b")
    )


def test_decision_key_keeps_real_prompt_inputs() -> None:
    base = classification_cache_key(_record(title="spritzring", brand="Marke", size="500 g"))
    assert base != classification_cache_key(_record(title="spritzkuchen", brand="Marke", size="500 g"))
    assert base != classification_cache_key(_record(title="spritzring", brand="Andere", size="500 g"))
    assert base != classification_cache_key(_record(title="spritzring", brand="Marke", size="1 kg"))
    assert base != classification_cache_key(_record(title="spritzring", brand="Marke", size="500 g", chain="Lidl"))
