"""Quellenpriorität (Task P3): eine vertrauenswürdige, eindeutige Quellabteilung
(sourceCategoryRaw/sourceDepartmentRaw) gewinnt für die finale Hauptkategorie
gegen schwache Name-/Keyword-Signale. Produktnamen hier sind ausschließlich
Reproduktions-Fixtures — der Code kennt keine Produkt-/Marken-Allowlist."""
from __future__ import annotations

from offers_categorizer.core import (
    DEFAULT_TAXONOMY_PATH,
    RuleClassifier,
    load_taxonomy,
    text_normalize,
    trusted_source_department_main,
)

TAX = load_taxonomy(DEFAULT_TAXONOMY_PATH)


class _Offer:
    def __init__(self, title: str, brand: str = "", scat: str = "", sdep: str = "") -> None:
        self.title_norm = text_normalize(title)
        self.brand_norm = text_normalize(brand)
        self.source_category_norm = text_normalize(scat)
        self.source_department_norm = text_normalize(sdep)


def _classify(title: str, scat: str = "", brand: str = "", sdep: str = ""):
    clf = RuleClassifier(taxonomy=TAX, min_rule_score=3.0)
    return clf.classify(_Offer(title, brand=brand, scat=scat, sdep=sdep)).category


# --- trusted_source_department_main (rein) -----------------------------------

def test_trusted_department_mapping() -> None:
    assert trusted_source_department_main(text_normalize("Tiefkühl")) == "Tiefkühl"
    assert trusted_source_department_main(text_normalize("Frozen")) == "Tiefkühl"
    assert trusted_source_department_main(text_normalize("Wein und Spirituosen")) == "Alkohol"
    assert trusted_source_department_main(text_normalize("Bier")) == "Alkohol"
    assert trusted_source_department_main(text_normalize("Obst & Gemüse")) == "Obst & Gemüse"


def test_neutral_and_nonfood_departments_force_nothing() -> None:
    for dept in ["Angebote", "Bonus-Aktionen", "Markenartikel", "Filialangebote"]:
        assert trusted_source_department_main(text_normalize(dept)) is None, dept
    for dept in ["Drogerie", "Haushalt", "Tierbedarf", "Bekleidung"]:
        assert trusted_source_department_main(text_normalize(dept)) is None, dept


def test_alkoholfrei_entwertet_alkohol_signal() -> None:
    assert trusted_source_department_main(text_normalize("Getränke alkoholfrei")) != "Alkohol"


# --- echte finale Kategorie via RuleClassifier.classify ----------------------

def test_iglo_tagliatelle_in_tiefkuehl_bleibt_tiefkuehl() -> None:
    # Name "Tagliatelle" → Grundnahrungsmittel/Pasta; Quelle Tiefkühl muss gewinnen.
    cat = _classify("Iglo Tagliatelle Pilzpfanne", scat="Tiefkühl")
    assert cat.main == "Tiefkühl"
    assert cat.is_non_food is False


def test_carbonara_in_tiefkuehl_bleibt_tiefkuehl() -> None:
    cat = _classify("Iglo Pasta Carbonara", scat="Tiefkühl")
    assert cat.main == "Tiefkühl"


def test_override_fires_when_name_keyword_would_win_other_main() -> None:
    # Name "Barilla Spaghetti" → Grundnahrungsmittel; die vertrauenswürdige
    # Tiefkühl-Abteilung muss die finale Kategorie sichtbar überschreiben.
    cat = _classify("Barilla Spaghetti", scat="Tiefgekühlt")
    assert cat.main == "Tiefkühl"
    assert "override:trusted_source_department" in cat.reasons


def test_qualitaetswein_in_wein_und_spirituosen_bleibt_alkohol() -> None:
    cat = _classify("Süss & Fruchtig oder Trollinger Qualitätswein", scat="Wein und Spirituosen")
    assert cat.main == "Alkohol"


def test_neutral_department_does_not_force_category() -> None:
    # Klarer Käse-Name in neutraler Abteilung bleibt Milchprodukte, nicht erzwungen.
    cat = _classify("Gouda jung gereift", scat="Bonus-Aktionen")
    assert cat.main == "Milchprodukte & Eier"
