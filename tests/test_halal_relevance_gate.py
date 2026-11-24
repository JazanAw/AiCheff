"""Halal-Relevanz-Gate (pa-v7) — generisches Gate VOR der tiefen KI-Pruefung.

Reine Engine-Tests ohne IO. Konkrete Produktnamen leben AUSSCHLIESSLICH hier als
Fixtures — der Produktivcode kennt KEINE Produkt-/Marken-Allowlist und KEINE
kalenderwochenabhaengige Logik.

Geprueft wird das neue Feld ``productAnalysis.halalRelevance`` und die zentrale,
reine Funktion ``classify_halal_relevance``. Kernzusagen:
  * Klar pflanzliche Grundprodukte / eindeutiges Schwein/Alkohol -> KEINE tiefe
    (KI-)Pruefung (``deepAnalysisRecommended is False``).
  * Nur echte Risikoklassen werden eskaliert (Fleisch/Gelatine/Lab/Alkohol/Zusatz).
  * Das Gate ist widerspruchsfrei zum bestehenden ``halal``-Claim (haram <->
    not_halal) und veraendert vegan/vegetarisch/Allergene NICHT.
"""

from __future__ import annotations

from aichef_offers.product_analysis import (
    HALAL_DEEP_CLASSES,
    HALAL_HARAM,
    HALAL_NEEDS_REVIEW,
    HALAL_NOT_RELEVANT,
    HALAL_POSSIBLE_UNVERIFIED,
    HALAL_PRESUMED_OK,
    HALAL_REL_UNKNOWN,
    build_product_analysis,
)


def _none_nutrition() -> dict:
    return {
        "source": "none",
        "per_100g": {"kcal": None, "protein_g": None, "carbs_g": None, "fat_g": None, "sugars_g": None, "salt_g": None, "fiber_g": None},
        "confidence": 0.0,
    }


def analyze(name: str, *, off=None, category=None, brand=""):
    offer = {"name": name, "brand": brand}
    if category:
        offer["canonicalCategory"] = {"main": category}
    return build_product_analysis(offer, off, _none_nutrition())


def rel(name: str, **kw) -> dict:
    return analyze(name, **kw)["halalRelevance"]


# ===========================================================================
# 1) Klar pflanzliche Grundprodukte -> not_relevant/presumed_ok, KEINE tiefe Pruefung
# ===========================================================================
def test_apple_is_not_relevant_no_deep_check():
    r = rel("Aepfel lose")
    assert r["relevance"] == HALAL_NOT_RELEVANT
    assert r["deepAnalysisRecommended"] is False
    assert "not_relevant:plant_basic" in r["reasons"]


def test_banana_is_not_relevant():
    r = rel("Bananen Chiquita")
    assert r["relevance"] == HALAL_NOT_RELEVANT
    assert r["deepAnalysisRecommended"] is False


def test_rice_is_not_relevant():
    r = rel("Basmati Reis")
    assert r["relevance"] == HALAL_NOT_RELEVANT
    assert r["deepAnalysisRecommended"] is False


def test_water_is_not_relevant():
    r = rel("Stilles Mineralwasser")
    assert r["relevance"] == HALAL_NOT_RELEVANT
    assert r["deepAnalysisRecommended"] is False


def test_flour_is_not_relevant():
    r = rel("Weizenmehl Type 405")
    assert r["relevance"] == HALAL_NOT_RELEVANT
    assert r["deepAnalysisRecommended"] is False


def test_spices_and_vegetables_not_flagged_as_unknown_risk():
    # Obst/Gemuese/Gewuerze duerfen NICHT unnoetig als unknown-risk gelten.
    for name in ("Gemahlener Pfeffer", "Frische Tomaten", "Paprika rot", "Petersilie"):
        r = rel(name)
        assert r["relevance"] == HALAL_NOT_RELEVANT, name
        assert r["relevance"] != HALAL_REL_UNKNOWN, name
        assert r["deepAnalysisRecommended"] is False, name


def test_vegan_labelled_product_is_presumed_ok_no_deep():
    r = rel("Gemuesepfanne", off={"ingredients_analysis_tags": ["en:vegan"]})
    assert r["relevance"] == HALAL_PRESUMED_OK
    assert r["deepAnalysisRecommended"] is False


# ===========================================================================
# 2) Schwein / Alkohol -> haram, KEINE tiefe Pruefung (eindeutig)
# ===========================================================================
def test_pork_schnitzel_is_haram():
    r = rel("Schweineschnitzel paniert")
    assert r["relevance"] == HALAL_HARAM
    assert "risk:pork" in r["reasons"]
    assert r["deepAnalysisRecommended"] is False


def test_bacon_is_haram():
    r = rel("Bacon Streifen")
    assert r["relevance"] == HALAL_HARAM
    assert "risk:pork" in r["reasons"]


def test_pork_gelatin_is_haram():
    r = rel("Fruchtgummi", off={"ingredients_text": "Zucker, Schweinegelatine"})
    assert r["relevance"] == HALAL_HARAM
    assert "risk:pork" in r["reasons"]


def test_beer_is_haram_alcohol():
    r = rel("Pils Bier 0,5l", off={"ingredients_text": "Wasser, Hopfen, Malz"})
    assert r["relevance"] == HALAL_HARAM
    assert "risk:alcohol" in r["reasons"]
    assert r["deepAnalysisRecommended"] is False


def test_wine_is_haram_alcohol():
    r = rel("Rotwein trocken")
    assert r["relevance"] == HALAL_HARAM
    assert "risk:alcohol" in r["reasons"]


def test_whisky_sauce_is_haram_alcohol():
    r = rel("Whisky Sauce")
    assert r["relevance"] == HALAL_HARAM
    assert "risk:alcohol" in r["reasons"]


# ===========================================================================
# 3) Fleisch ohne Schwein/Zertifikat -> halal_possible_but_unverified (Review)
# ===========================================================================
def test_chicken_without_cert_is_possible_unverified():
    r = rel("Haehnchenbrustfilet")
    assert r["relevance"] == HALAL_POSSIBLE_UNVERIFIED
    assert "risk:meat" in r["reasons"]
    assert r["deepAnalysisRecommended"] is True


def test_beef_without_cert_is_possible_unverified():
    r = rel("Rindergulasch")
    assert r["relevance"] == HALAL_POSSIBLE_UNVERIFIED
    assert "risk:meat" in r["reasons"]


def test_lamb_without_cert_is_possible_unverified():
    r = rel("Lammkeule frisch")
    assert r["relevance"] == HALAL_POSSIBLE_UNVERIFIED


def test_sausage_without_cert_is_possible_unverified():
    r = rel("Bratwurst grob")
    assert r["relevance"] == HALAL_POSSIBLE_UNVERIFIED
    assert "risk:meat" in r["reasons"]


def test_bare_ham_is_not_haram_could_be_turkey():
    # Bewusst: "Schinken" allein beweist KEIN Schwein (Putenschinken) -> Fleisch-
    # Risiko, KEIN haram. Schuetzt die bestehende dokumentierte Invariante.
    r = rel("Schinken Aufschnitt")
    assert r["relevance"] == HALAL_POSSIBLE_UNVERIFIED
    assert r["relevance"] != HALAL_HARAM
    assert "risk:meat" in r["reasons"]


def test_certified_halal_meat_is_presumed_ok():
    r = rel("Haehnchen Schenkel", off={"labels_tags": ["en:halal"]})
    assert r["relevance"] == HALAL_PRESUMED_OK
    assert "presumed_ok:halal_certified" in r["reasons"]
    assert r["deepAnalysisRecommended"] is False


# ===========================================================================
# 4) Gelatine-/Suesswaren-Risiko -> needs_halal_review bzw. haram (Evidenz)
# ===========================================================================
def test_gummy_bears_need_review_gelatin():
    r = rel("Fruchtgummi Classic")
    assert r["relevance"] == HALAL_NEEDS_REVIEW
    assert "risk:gelatin" in r["reasons"]
    assert r["deepAnalysisRecommended"] is True


def test_marshmallow_needs_review_gelatin():
    r = rel("Marshmallow Mix")
    assert r["relevance"] == HALAL_NEEDS_REVIEW
    assert "risk:gelatin" in r["reasons"]


def test_mousse_dessert_needs_review_gelatin():
    r = rel("Mousse au Chocolat Dessert")
    assert r["relevance"] == HALAL_NEEDS_REVIEW
    assert "risk:gelatin" in r["reasons"]


def test_unknown_gelatin_in_ingredients_needs_review():
    r = rel("Dessert", off={"ingredients_text": "Zucker, Gelatine, Aroma"})
    assert r["relevance"] == HALAL_NEEDS_REVIEW
    assert "risk:gelatin" in r["reasons"]


# ===========================================================================
# 5) Kaese mit Lab/Enzym -> needs_halal_review (Lab-Risiko)
# ===========================================================================
def test_cheese_with_animal_rennet_needs_review():
    r = rel("Bergkaese", off={"ingredients_text": "Milch, tierisches Lab, Salz"})
    assert r["relevance"] == HALAL_NEEDS_REVIEW
    assert "risk:rennet" in r["reasons"]


def test_cheese_with_lab_token_needs_review():
    r = rel("Hartkaese", off={"ingredients_text": "Rohmilch, Lab, Salz"})
    assert r["relevance"] == HALAL_NEEDS_REVIEW
    assert "risk:rennet" in r["reasons"]


def test_plain_cheese_without_lab_is_presumed_ok():
    # Bare Gouda ohne Lab/Enzym-Hinweis ist halal-neutral (Milchprodukt) -> kein
    # unnoetiges Review.
    r = rel("Gouda jung am Stueck")
    assert r["relevance"] == HALAL_PRESUMED_OK
    assert r["deepAnalysisRecommended"] is False


# ===========================================================================
# 6) Ambivalente Zusatzstoffe -> needs_halal_review (risk:additive)
# ===========================================================================
def test_carmine_additive_needs_review():
    r = rel("Erdbeerjoghurt", off={"ingredients_text": "Joghurt, Zucker, Farbstoff Karmin"})
    assert r["relevance"] == HALAL_NEEDS_REVIEW
    assert "risk:additive" in r["reasons"]


def test_shellac_additive_needs_review():
    r = rel("Dragees", off={"ingredients_text": "Zucker, Ueberzugsmittel Schellack"})
    assert r["relevance"] == HALAL_NEEDS_REVIEW
    assert "risk:additive" in r["reasons"]


# ===========================================================================
# 7) Alkohol im Aroma -> haram (Engine wertet "rum"/"wein" als echten Alkohol).
#    Bewusst KEINE eigene Sonderlogik im Gate: es spiegelt ev.alcohol() exakt,
#    bleibt damit widerspruchsfrei zum bestehenden halal-Claim (not_halal).
# ===========================================================================
def test_rum_aroma_counts_as_alcohol_haram():
    r = rel("Pralinen", off={"ingredients_text": "Schokolade, Rumaroma"})
    assert r["relevance"] == HALAL_HARAM
    assert "risk:alcohol" in r["reasons"]
    assert r["deepAnalysisRecommended"] is False


# ===========================================================================
# 8) deepAnalysisRecommended-Logik + Widerspruchsfreiheit zum halal-Claim
# ===========================================================================
def test_deep_flag_matches_relevance_class():
    cases = {
        "Aepfel": False,
        "Schweineschnitzel": False,
        "Pils Bier": False,
        "Haehnchenbrustfilet": True,
        "Fruchtgummi Classic": True,
        "Produkt voellig ohne Info xyz": True,
    }
    for name, expect_deep in cases.items():
        r = rel(name)
        assert r["deepAnalysisRecommended"] is expect_deep, name
        assert (r["relevance"] in HALAL_DEEP_CLASSES) is expect_deep, name


def test_haram_iff_halal_claim_is_not_halal():
    # Das Gate (haram) ist widerspruchsfrei zum bestehenden halal-Claim (not_halal).
    haram_names = [
        ("Schweineschnitzel", None),
        ("Bacon Streifen", None),
        ("Rotwein trocken", None),
        ("Fruchtgummi", {"ingredients_text": "Zucker, Schweinegelatine"}),
    ]
    for name, off in haram_names:
        a = analyze(name, off=off)
        assert a["halalRelevance"]["relevance"] == HALAL_HARAM, name
        assert a["halal"]["status"] == "not_halal", name

    non_haram_names = ["Aepfel", "Haehnchenbrustfilet", "Basmati Reis", "Gouda jung"]
    for name in non_haram_names:
        a = analyze(name)
        assert a["halalRelevance"]["relevance"] != HALAL_HARAM, name
        assert a["halal"]["status"] != "not_halal", name


def test_presumed_ok_or_not_relevant_never_not_halal():
    for name in ("Aepfel", "Basmati Reis", "Stilles Mineralwasser"):
        a = analyze(name)
        assert a["halalRelevance"]["relevance"] in (HALAL_NOT_RELEVANT, HALAL_PRESUMED_OK)
        assert a["halal"]["status"] != "not_halal"


# ===========================================================================
# 9) Regression: das Gate veraendert vegan/vegetarisch/Allergene NICHT
# ===========================================================================
def test_gate_does_not_change_vegan_vegetarian():
    a = analyze("Veganes Schnitzel", off={"ingredients_analysis_tags": ["en:vegan"], "ingredients_text": "Weizeneiweiss"})
    assert a["vegan"]["status"] == "yes"
    assert a["vegetarian"]["status"] == "yes"
    # Vegan-Claim -> Gate presumed_ok, KEINE tiefe Pruefung.
    assert a["halalRelevance"]["relevance"] == HALAL_PRESUMED_OK
    assert a["halalRelevance"]["deepAnalysisRecommended"] is False


def test_gate_does_not_add_review_reasons():
    # Marshmallow eskaliert im Gate (needs_review), darf aber die bestehende
    # Review-Liste / reviewNeeded NICHT veraendern (separate Schicht).
    a = analyze("Marshmallow Mix")
    assert a["halalRelevance"]["relevance"] == HALAL_NEEDS_REVIEW
    assert all(not r.startswith("halal:gelatin_possible") for r in a["reviewReasons"])
