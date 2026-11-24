from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, deque
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from offers_categorizer.core import (
    BERLIN_TZ,
    OllamaFailFastError,
    run_pipeline as run_base_pipeline,
)
from aichef_offers.availability import compute_offer_availability, resolve_as_of_date
from aichef_offers.product_analysis import (
    TrustedEvidenceContext,
    build_product_analysis,
    legacy_allergens,
    legacy_diet_flags,
)


OFF_FIELDS = (
    "product_name,nutriments,quantity,serving_size,nutrition_data_per,"
    "allergens_tags,traces_tags,ingredients_text,labels_tags,ingredients_analysis_tags"
)

ALLERGEN_MAP = {
    "gluten": "gluten_cereals",
    "wheat": "gluten_cereals",
    "barley": "gluten_cereals",
    "rye": "gluten_cereals",
    "oat": "gluten_cereals",
    "crustaceans": "crustaceans",
    "shrimp": "crustaceans",
    "eggs": "eggs",
    "egg": "eggs",
    "fish": "fish",
    "peanuts": "peanuts",
    "peanut": "peanuts",
    "soybeans": "soybeans",
    "soy": "soybeans",
    "milk": "milk",
    "lactose": "milk",
    "nuts": "nuts",
    "almond": "nuts",
    "hazelnut": "nuts",
    "walnut": "nuts",
    "cashew": "nuts",
    "celery": "celery",
    "mustard": "mustard",
    "sesame": "sesame",
    "sulphites": "sulphites",
    "sulfites": "sulphites",
    "lupin": "lupin",
    "molluscs": "molluscs",
}

EU14_KEYS = [
    "gluten_cereals",
    "crustaceans",
    "eggs",
    "fish",
    "peanuts",
    "soybeans",
    "milk",
    "nuts",
    "celery",
    "mustard",
    "sesame",
    "sulphites",
    "lupin",
    "molluscs",
]

NONFOOD_KEYWORDS_FILE = Path(__file__).with_name("nonfood_keywords.json")
SOURCE_SONSTIGES_HINTS = {"sonstiges", "misc", "other"}
NONFOOD_DEPARTMENT_HINTS = {
    "drogerie",
    "haushalt",
    "papier",
    "hygiene",
    "pflege",
    "kosmetik",
    "garten",
    "haustier",
    "tiernahrung",
    "baby",
}
# Eindeutig ESSBARE Warenarten im PRODUKTNAMEN. Spiegelt
# EDIBLE_PRODUCT_NAME_KEYWORDS in backend/src/offersStrictFoodFilter.ts, damit
# Python-Pipeline und TS-Gate identisch urteilen. Bewusst frei von Wörtern, die
# auch auf Drogerie-/Tier-/Haushaltsartikeln stehen ("creme", "salz", "milch").
EDIBLE_PRODUCT_NAME_KEYWORDS = (
    "protein",
    "proteine",
    "whey",
    "molke",
    "eiweisspulver",
    "kreatin",
    "creatine",
    "muesliriegel",
    "proteinriegel",
    "schokoriegel",
    "nussriegel",
    "fruchtriegel",
    "haferriegel",
    "folgemilch",
    "anfangsmilch",
    "saeuglingsmilch",
    "saeuglingsnahrung",
    "babynahrung",
    "babybrei",
    "milchbrei",
    "beikost",
    "glaskost",
    "schokolade",
    "kaffee",
    "espresso",
    "fruchtsaft",
    "limonade",
    "joghurt",
    "nudeln",
    "haferflocken",
    "knaeckebrot",
    "trockenfruechte",
)
DEFAULT_NONFOOD_KEYWORDS = [
    "handcreme",
    "bodymilk",
    "koerperpflege",
    "koerper-feuchtigkeitspflege",
    "feuchtigkeitspflege",
    "sonnencreme",
    "lacura",
    "dove",
    "duschcreme",
    "seife",
    "garnier",
    "loreal",
    "gesichtspflege",
    "mizellen reinigungswasser",
    "reinigungswasser",
    "tuchmaske",
    "shampoo",
    "haargel",
    "strand matte",
    "strandmatte",
    "deo",
    "zahnpasta",
    "zahncreme",
    "oral b",
    "oral-b",
    "sensodyne",
    "duschgel",
    "schaumbad",
    "kosmetik",
    "reiniger",
    "klarspueler",
    "klarspuler",
    "glanz und klarspueler",
    "glanz und klarspuler",
    "maschinenpfleger",
    "finish klarspueler",
    "finish klarspuler",
    "finish maschinenpfleger",
    "finish powerball",
    "finish ultimate",
    "waschmittel",
    "lenor",
    "waescheparfuem",
    "waescheparfum",
    "wascheparfuem",
    "wascheparfum",
    "persil",
    "waschpulver",
    "kraft gel",
    "4 in 1 discs",
    "discs color",
    "spuelmittel",
    "duftspueler",
    "duftspuler",
    "lufterfrischer",
    "airwick",
    "spÃ¼lmittel",
    "kuechenpapier",
    "küchenpapier",
    "kuechenrolle",
    "küchenrolle",
    "kuechenrollen",
    "küchenrollen",
    "kuechentuecher",
    "kÃ¼chentÃ¼cher",
    "haushaltstuecher",
    "haushaltstücher",
    "putztuecher",
    "putztücher",
    "papierhandtuecher",
    "papierhandtücher",
    "serviette",
    "servietten",
    "toilettenpapier",
    "muellbeutel",
    "mÃ¼llbeutel",
    "kerze",
    "kerzen",
    "duenger",
    "dÃ¼nger",
    "blumenerde",
    "torffreie erde",
    "torffrei",
    "pflanze",
    "pflanzen",
    "tomaten ampel",
    "tomatenampel",
    "bornholm margerite",
    "margerite",
    "katzengras",
    "blumentopf",
    "samen",
    "saemereien",
    "sÃ¤mereien",
    "vase",
    "batterie",
    "batterien",
    "crivit",
    "poolsitz",
    "wasserhaengematte",
    "wasserhangematte",
    "wasserspielmatte",
    "wassermattensortiment",
    "springmatte",
    "gemueseschneider",
    "gemÃ¼seschneider",
    "nudelmaschine",
    "handstaubsauger",
    "staubsauger",
    "fahrradtasche",
    "silvercrest",
    "fruchtsaftkrug",
    "pizzaschneidebrett",
    "schneidebrett",
    "wasserkaraffe",
    "karaffe",
    "bierkastenkuehltasche",
    "bierkastenkuhltasche",
    "kuehltasche",
    "kuhltasche",
    "reifenpflege",
    "thermoglaeser",
    "thermoglaser",
    "trinkglaeser",
    "trinkglaser",
    "nicer dicer",
    "nicer dicer plus",
    "smoothie maker",
    "smoothie maker to go",
    "smoothie-makertogo",
    "switch on",
    "ssmk 300",
    "smoker box",
    "smokerbox",
    "raeucherbox",
    "räucherbox",
    "thisisnobrand123 smoker box",
    "holzhacksler",
    "holzhaecksler",
    "hack 100",
    "reisekoffer",
    "kinder reisekoffer",
    "hundenahrung",
    "hundesnacks",
    "katzensnacks",
    "katzen snacks",
    "katzen snack",
    "klumpstreu",
    "ultra klumpstreu",
    "vitakraft",
    "good boy hundesnacks",
    "multi kroketten",
    "katzennahrung",
    "katzenfutter",
    "choceur katzenzungen",
    "fleckenspray",
    "weichspueler",
    "weichspüler",
    "hornspaene",
    "hornspäne",
    "maler acryl",
    "maler-acryl",
    "acryl express",
    "parkside maler acryl express",
    "die thueringer stifte",
    "die thüringer stifte",
    "thueringer stifte",
    "thüringer stifte",
    "pflegeoel",
    "massageoel",
]
FOOD_RESCUE_BLOCKERS = {
    "shampoo",
    "zahnpasta",
    "zahncreme",
    "oral b",
    "oral-b",
    "sensodyne",
    "deo",
    "bodymilk",
    "handcreme",
    "sonnencreme",
    "lacura",
    "dove",
    "duschcreme",
    "seife",
    "garnier",
    "loreal",
    "gesichtspflege",
    "mizellen reinigungswasser",
    "reinigungswasser",
    "tuchmaske",
    "duschgel",
    "schaumbad",
    "kosmetik",
    "waschmittel",
    "lenor",
    "waescheparfuem",
    "waescheparfum",
    "wascheparfuem",
    "wascheparfum",
    "persil",
    "waschpulver",
    "kraft gel",
    "4 in 1 discs",
    "discs color",
    "reiniger",
    "klarspueler",
    "klarspuler",
    "maschinenpfleger",
    "finish klarspueler",
    "finish klarspuler",
    "finish maschinenpfleger",
    "finish powerball",
    "finish ultimate",
    "spuelmittel",
    "toilettenpapier",
    "kuechenpapier",
    "küchenpapier",
    "kuechenrolle",
    "küchenrolle",
    "kuechenrollen",
    "küchenrollen",
    "kuechentuecher",
    "küchentücher",
    "haushaltstuecher",
    "haushaltstücher",
    "putztuecher",
    "putztücher",
    "papierhandtuecher",
    "papierhandtücher",
    "serviette",
    "servietten",
    "muellbeutel",
    "windeln",
    "rasierer",
    "batterie",
    "batterien",
    "crivit",
    "poolsitz",
    "wasserhaengematte",
    "wasserhangematte",
    "wasserspielmatte",
    "wassermattensortiment",
    "springmatte",
    "kerze",
    "duenger",
    "blumenerde",
    "torffreie erde",
    "torffrei",
    "pflanze",
    "tomaten ampel",
    "tomatenampel",
    "bornholm margerite",
    "margerite",
    "katzengras",
    "blumentopf",
    "gemueseschneider",
    "nudelmaschine",
    "handstaubsauger",
    "staubsauger",
    "fahrradtasche",
    "silvercrest",
    "fruchtsaftkrug",
    "pizzaschneidebrett",
    "schneidebrett",
    "wasserkaraffe",
    "karaffe",
    "bierkastenkuehltasche",
    "bierkastenkuhltasche",
    "kuehltasche",
    "kuhltasche",
    "reifenpflege",
    "thermoglaeser",
    "thermoglaser",
    "trinkglaeser",
    "trinkglaser",
    "smoothie maker",
    "koffer",
    "smoker box",
    "smokerbox",
    "raeucherbox",
    "räucherbox",
    "hundenahrung",
    "hundesnacks",
    "katzensnacks",
    "katzen snacks",
    "katzen snack",
    "katzenfutter",
    "klumpstreu",
    "ultra klumpstreu",
    "vitakraft",
    "weichspueler",
    "weichspüler",
    "hornspaene",
    "hornspäne",
    "maler acryl",
    "maler-acryl",
    "acryl express",
    "parkside",
    "die thueringer stifte",
    "die thüringer stifte",
    "thueringer stifte",
    "thüringer stifte",
    "wasserglaeser",
    "wassergläser",
    "glas set",
    "glaeser set",
}
FOOD_RESCUE_DRINK_RULES: list[tuple[str, tuple[str, ...]]] = [
    ("Mate", ("mio mio", "mate")),
    ("Energy", ("gonrgy", "goenrgy", "gönrgy", "energy drink", "energydrink", "energy")),
    ("Wasser", ("mineralwasser", "wasser")),
    ("Säfte", ("direktsaft", "nektar", "saft")),
    (
        "Kaffee & Tee",
        # Generische Kaffee-/Tee-DESKRIPTOREN (beschreiben das Produkt selbst) —
        # ein eigenständiger Food-Beleg. KEINE Marken (Task P3): eine Marke allein
        # darf einen mehrdeutigen Kurznamen ("Gold"/"Auslese"/"Sensations") nicht
        # retten; sie steht in COFFEE_TEA_BRAND_HINTS und braucht zusätzliche Evidenz.
        ("espresso", "kaffee", "tee", "cafe", "caffe", "crema", "barista"),
    ),
    ("Softdrinks", ("soft drink", "softdrink", "cola", "limonade", "limo", "drink")),
]
# Kaffee-/Tee-MARKEN. Eine Marke allein ist KEIN Food-Beleg (Task P3): erst
# zusammen mit einem unabhängigen strukturellen Beleg (konkreter Zubereitungs-
# Deskriptor ODER ein Kaffee-/Tee-Deskriptor in Kategorie/Abteilung, der ohnehin
# über die Deskriptor-Regel oben greift) wird das Angebot als Food gerettet.
COFFEE_TEA_BRAND_HINTS: tuple[str, ...] = (
    "dallmayr",
    "lavazza",
    "lipton",
    "melitta",
    "jacobs",
    "eduscho",
    "nescafe",
    "tchibo",
)
# Konkrete Zubereitungs-Deskriptoren, die ALLEIN zu mehrdeutig sind ("gemahlen"
# kann ein Gewürz, "Kapsel" ein Waschmittel sein) und nur ZUSAMMEN mit einer
# Marke ein Food-Beleg sind — Domänen-Vokabular, keine Produktliste.
COFFEE_TEA_BRAND_SUPPORT: tuple[str, ...] = (
    "gemahlen",
    "instant",
    "loeslich",
    "loslich",
    "roestkaffee",
    "filterkaffee",
    "kaffeebohnen",
    "ganze bohne",
    "ganze bohnen",
    "pad",
    "pads",
    "kapsel",
    "kapseln",
)
FOOD_RESCUE_DAIRY_RULES: list[tuple[str, tuple[str, ...]]] = [
    ("Milch", ("not mlk", "not m lk", "haferdrink", "mandeldrink", "sojadrink", "pflanzendrink")),
]
FOOD_RESCUE_ALCOHOL_RULES: list[tuple[str, tuple[str, ...]]] = [
    ("Bier", ("krombacher", "0 0")),
    (
        "Wein",
        (
            "alkoholfrei weiss",
            "alkoholfrei weiß",
            "weisswein",
            "weißwein",
            "weissburgunder",
            "weißburgunder",
            "gewuerztraminer",
            "gewürztraminer",
            "grauburgunder",
            "chardonnay",
            "sauvignon",
            "tempranillo",
        ),
    ),
    (
        "Spirituosen",
        (
            "gordon",
            "gordons",
            "sanddornlikor",
            "sanddornlikoer",
            "sanddornlikör",
            "whiskey",
            "whisky",
            "single malt",
            "likor",
            "likoer",
            "likör",
        ),
    ),
]
FOOD_RESCUE_SNACK_RULES: list[tuple[str, tuple[str, ...]]] = [
    ("Cracker & Salzgebäck", ("saltletts", "cracker", "salzgebäck", "salzgebaeck", "laugenspezialität", "laugenspezialitaet")),
    ("Chips & Salzgebäck", ("chips", "popcorn", "flips")),
    ("Kekse & Gebäck", ("keks", "kekse", "gebäck", "gebaeck")),
    ("Schokolade & Pralinen", ("schokolade", "praline", "riegel", "bonbon")),
]
FOOD_RESCUE_READY_HINTS = ("asiatisch", "spezialität", "spezialitaet", "fertig", "instant")

# Grundwörter, die als KOPF eines deutschen Kompositums (Wortende) matchen
# dürfen: "Apfelsaft", "Mineralwasser", "Kartoffelchips", "Eierlikör",
# "grillfertig". Alle anderen Rescue-Keywords zählen nur als ganzes Wort (plus
# Flexionsendung) — ein nackter Substring-Match machte aus "Rispentomaten"
# (…toMATE…) Mate-Getränke und aus "Nektarinen" (NEKTAR…) Säfte. "mate" darf
# insbesondere NIE Suffix-matchen ("Tomate" endet auf "mate").
FOOD_RESCUE_COMPOUND_HEAD_KEYWORDS = {
    "saft",
    "nektar",
    "schorle",
    "wasser",
    "drink",
    "limonade",
    "cola",
    "kaffee",
    "likoer",
    "likor",
    "chips",
    "keks",
    "kekse",
    "gebaeck",
    "salzgebaeck",
    "schokolade",
    "riegel",
    "flips",
    "cracker",
    "fertig",
    "spezialitaet",
}

# Flexionsendungen, die ein Rescue-Keyword fortsetzen dürfen ("praline" →
# "pralinen", "bonbon" → "bonbons", "apfelsaft" → bleibt). Bewusst kurz: "nektar"
# + "inen" ist KEINE Flexion und bleibt damit ausgeschlossen ("Nektarinen" ist
# Obst, kein Saft).
FOOD_RESCUE_INFLECTION_SUFFIXES = ("en", "es", "er", "e", "n", "s")
_RESCUE_INFLECTION_GROUP = "(?:" + "|".join(FOOD_RESCUE_INFLECTION_SUFFIXES) + ")?"


def normalize_text(value: Any) -> str:
    if value is None:
        return ""
    text = str(value).strip().lower()
    repl = {
        "ä": "ae",
        "ö": "oe",
        "ü": "ue",
        "ß": "ss",
        "Ã¤": "ae",
        "Ã¶": "oe",
        "Ã¼": "ue",
        "ÃŸ": "ss",
    }
    for src, dst in repl.items():
        text = text.replace(src, dst)
    text = re.sub(r"[^a-z0-9%]+", " ", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def load_nonfood_keywords(path: Path = NONFOOD_KEYWORDS_FILE) -> list[str]:
    values: list[str] = list(DEFAULT_NONFOOD_KEYWORDS)
    if path.exists():
        try:
            payload = json.loads(path.read_text(encoding="utf-8-sig"))
        except (OSError, json.JSONDecodeError):
            payload = None
        if isinstance(payload, dict):
            raw_values = payload.get("keywords")
            if isinstance(raw_values, list):
                values.extend(str(item) for item in raw_values if isinstance(item, (str, int, float)))
        elif isinstance(payload, list):
            values.extend(str(item) for item in payload if isinstance(item, (str, int, float)))

    deduped: list[str] = []
    seen: set[str] = set()
    for value in values:
        token = normalize_text(value)
        if token and token not in seen:
            seen.add(token)
            deduped.append(token)
    return deduped


NONFOOD_KEYWORDS = load_nonfood_keywords()


def find_keyword_hits(
    text: str,
    keywords: list[str] | tuple[str, ...] | set[str],
) -> list[str]:
    hits: list[str] = []
    for keyword in keywords:
        token = normalize_text(keyword)
        if not token:
            continue
        if len(token) <= 3 and re.fullmatch(r"[a-z0-9]+", token):
            if re.search(rf"(^|\s){re.escape(token)}($|\s)", text):
                hits.append(token)
            continue
        if " " in token:
            if re.search(rf"(?<![a-z0-9]){re.escape(token)}(?![a-z0-9])", text):
                hits.append(token)
            continue
        if token in text:
            hits.append(token)
    return list(dict.fromkeys(hits))


def find_rescue_keyword_hits(
    text: str,
    keywords: list[str] | tuple[str, ...] | set[str],
) -> list[str]:
    """Wortgrenzen-Variante von find_keyword_hits für die FOOD-RESCUE-Regeln:
    ein Einzelwort-Keyword zählt nur als ganzes Wort (+ kurze Flexionsendung)
    am Wortanfang oder — für die Grundwörter in FOOD_RESCUE_COMPOUND_HEAD_KEYWORDS
    — als Kompositum-Kopf am Wortende ("Apfelsaft", "Kartoffelchips"). Ein nackter
    Substring-Match feuerte sonst auf Wortbestandteile ("mate" in "Tomate",
    "nektar" in "Nektarinen")."""
    hits: list[str] = []
    for keyword in keywords:
        token = normalize_text(keyword)
        if not token:
            continue
        escaped = re.escape(token)
        if " " in token:
            if re.search(rf"(?<![a-z0-9]){escaped}(?![a-z0-9])", text):
                hits.append(token)
            continue
        # Ganzes Wort am Wortanfang (+ kurze Flexionsendung): "saft", "pralinen".
        if re.search(rf"(^|\s){escaped}{_RESCUE_INFLECTION_GROUP}($|\s)", text):
            hits.append(token)
            continue
        # Kompositum-Kopf am Wortende: "haferdrink", "kartoffelchips". Bewusst
        # nur die Grundwörter, die als Wortende ein Getränk/Snack belegen — NIE
        # "mate" (Tomate) oder "nektar" am Wortanfang (Nektarine).
        if token in FOOD_RESCUE_COMPOUND_HEAD_KEYWORDS and re.search(
            rf"[a-z0-9]{escaped}{_RESCUE_INFLECTION_GROUP}($|\s)", text
        ):
            hits.append(token)
    return list(dict.fromkeys(hits))


def detect_food_rescue(offer: dict[str, Any]) -> tuple[str, str, list[str]] | None:
    text = normalize_text(
        " ".join(
            [
                str(offer.get("title") or offer.get("name") or ""),
                str(offer.get("brand") or ""),
                str(offer.get("category") or offer.get("sourceCategory") or ""),
                str(offer.get("department") or ""),
            ]
        )
    )
    if not text:
        return None
    if find_keyword_hits(text, FOOD_RESCUE_BLOCKERS):
        return None

    for sub, keywords in FOOD_RESCUE_DAIRY_RULES:
        hits = find_rescue_keyword_hits(text, keywords)
        if hits:
            reasons = [f"rescue_kw:{hit}" for hit in hits[:4]]
            reasons.append("rescue:dairy")
            return "Milchprodukte & Eier", sub, reasons

    for sub, keywords in FOOD_RESCUE_ALCOHOL_RULES:
        hits = find_rescue_keyword_hits(text, keywords)
        if hits:
            reasons = [f"rescue_kw:{hit}" for hit in hits[:4]]
            reasons.append("rescue:alcohol")
            return "Alkohol", sub, reasons

    for sub, keywords in FOOD_RESCUE_DRINK_RULES:
        hits = find_rescue_keyword_hits(text, keywords)
        if hits:
            reasons = [f"rescue_kw:{hit}" for hit in hits[:4]]
            reasons.append("rescue:drinks")
            return "Getränke alkoholfrei", sub, reasons

    # Kaffee-/Tee-MARKE allein ist KEIN Food-Beleg (Task P3): erst zusammen mit
    # einem unabhängigen Zubereitungs-Deskriptor (gemahlen/instant/Pads/Bohne).
    # Ein Kaffee-/Tee-Deskriptor in Kategorie/Abteilung ("Kaffee"/"Tee") greift
    # bereits über die Deskriptor-Regel oben — die Marke ist dann nicht tragend.
    brand_hits = find_rescue_keyword_hits(text, COFFEE_TEA_BRAND_HINTS)
    if brand_hits:
        support_hits = find_rescue_keyword_hits(text, COFFEE_TEA_BRAND_SUPPORT)
        if support_hits:
            reasons = [f"rescue_kw:{hit}" for hit in (brand_hits + support_hits)[:4]]
            reasons.append("rescue:drinks")
            return "Getränke alkoholfrei", "Kaffee & Tee", reasons

    for sub, keywords in FOOD_RESCUE_SNACK_RULES:
        hits = find_rescue_keyword_hits(text, keywords)
        if hits:
            reasons = [f"rescue_kw:{hit}" for hit in hits[:4]]
            reasons.append("rescue:snacks")
            return "Süßwaren & Snacks", sub, reasons

    ready_hits = find_rescue_keyword_hits(text, FOOD_RESCUE_READY_HINTS)
    if ready_hits:
        reasons = [f"rescue_kw:{hit}" for hit in ready_hits[:4]]
        reasons.append("rescue:ready_hint")
        return "Konserven & Fertiggerichte", "Fertiggerichte", reasons

    return None


def apply_food_rescue_to_canonical(offer: dict[str, Any], rescue: tuple[str, str, list[str]]) -> None:
    main, sub, reasons = rescue
    canonical = offer.get("canonicalCategory")
    if not isinstance(canonical, dict):
        canonical = {}
        offer["canonicalCategory"] = canonical

    existing_reasons = canonical.get("reasons")
    merged_reasons: list[str] = []
    if isinstance(existing_reasons, list):
        merged_reasons.extend(str(item) for item in existing_reasons if str(item).strip())
    merged_reasons.extend(reasons)

    deduped_reasons = list(dict.fromkeys(merged_reasons))
    canonical["main"] = main
    canonical["sub"] = sub
    canonical["secondary"] = canonical.get("secondary") if isinstance(canonical.get("secondary"), list) else []
    canonical["isNonFood"] = False
    canonical["confidence"] = max(0.86, float(canonical.get("confidence", 0.0) or 0.0))
    canonical["reasons"] = deduped_reasons


def to_number(value: Any) -> float | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip().replace(",", ".")
    text = re.sub(r"[^0-9.\-]", "", text)
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def parse_quantity(raw_text: str) -> tuple[float | None, str | None, float]:
    text = normalize_text(raw_text)
    if not text:
        return None, None, 0.0
    multi = re.search(r"(\d+)\s*x\s*(\d+(?:[.,]\d+)?)\s*(kg|g|l|ml)\b", text)
    if multi:
        n = float(multi.group(1))
        amount = float(multi.group(2).replace(",", "."))
        unit = multi.group(3)
        total = n * amount
        if unit == "kg":
            return total * 1000.0, "g", 0.95
        if unit == "l":
            return total * 1000.0, "ml", 0.95
        return total, unit, 0.95
    single = re.search(r"(\d+(?:[.,]\d+)?)\s*(kg|g|l|ml)\b", text)
    if single:
        amount = float(single.group(1).replace(",", "."))
        unit = single.group(2)
        if unit == "kg":
            return amount * 1000.0, "g", 0.92
        if unit == "l":
            return amount * 1000.0, "ml", 0.92
        return amount, unit, 0.92
    count = re.search(r"(\d+)\s*(stk|stueck|stuck|x)\b", text)
    if count:
        return float(count.group(1)), "count", 0.7
    return None, None, 0.0


def estimate_per_item(per_100: dict[str, float | None], amount: float | None, basis: str | None) -> dict[str, float] | None:
    if amount is None or basis not in {"g", "ml"}:
        return None
    out: dict[str, float] = {}
    factor = amount / 100.0
    for key in ("kcal", "protein_g", "carbs_g", "fat_g", "sugars_g"):
        value = per_100.get(key)
        if value is None:
            continue
        out[key] = round(value * factor, 3)
    return out or None


class NutritionCache:
    def __init__(self, db_path: Path) -> None:
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(db_path)
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS off_products(gtin TEXT PRIMARY KEY, payload_json TEXT, fetched_at TEXT)"
        )
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS bls_lookup(fingerprint TEXT PRIMARY KEY, bls_id TEXT, confidence REAL)"
        )
        self.conn.commit()

    def get_off(self, gtin: str, ttl_days: int) -> dict[str, Any] | None:
        row = self.conn.execute(
            "SELECT payload_json, fetched_at FROM off_products WHERE gtin = ?",
            (gtin,),
        ).fetchone()
        if row is None:
            return None
        fetched_at = datetime.fromisoformat(row[1])
        if datetime.now(timezone.utc) - fetched_at > timedelta(days=ttl_days):
            return None
        try:
            payload = json.loads(row[0])
        except json.JSONDecodeError:
            return None
        return payload if isinstance(payload, dict) else None

    def set_off(self, gtin: str, payload: dict[str, Any]) -> None:
        self.conn.execute(
            """
            INSERT INTO off_products(gtin,payload_json,fetched_at)
            VALUES(?,?,?)
            ON CONFLICT(gtin) DO UPDATE SET payload_json=excluded.payload_json, fetched_at=excluded.fetched_at
            """,
            (gtin, json.dumps(payload, ensure_ascii=False), datetime.now(timezone.utc).isoformat()),
        )
        self.conn.commit()

    def get_bls(self, fingerprint: str) -> tuple[str, float] | None:
        row = self.conn.execute(
            "SELECT bls_id, confidence FROM bls_lookup WHERE fingerprint = ?",
            (fingerprint,),
        ).fetchone()
        if row is None:
            return None
        return str(row[0]), float(row[1])

    def set_bls(self, fingerprint: str, bls_id: str, confidence: float) -> None:
        self.conn.execute(
            """
            INSERT INTO bls_lookup(fingerprint, bls_id, confidence)
            VALUES(?,?,?)
            ON CONFLICT(fingerprint) DO UPDATE SET bls_id=excluded.bls_id, confidence=excluded.confidence
            """,
            (fingerprint, bls_id, confidence),
        )
        self.conn.commit()

    def close(self) -> None:
        self.conn.close()


class OFFClient:
    def __init__(self, cache: NutritionCache, ttl_days: int, max_req_per_min: int, timeout: int) -> None:
        self.cache = cache
        self.ttl_days = max(1, ttl_days)
        self.max_req_per_min = max(1, max_req_per_min)
        self.timeout = max(3, timeout)
        self.timestamps: deque[float] = deque()

    def _throttle(self) -> None:
        now = time.time()
        while self.timestamps and now - self.timestamps[0] > 60:
            self.timestamps.popleft()
        if len(self.timestamps) >= self.max_req_per_min:
            wait_sec = 60 - (now - self.timestamps[0]) + 0.05
            if wait_sec > 0:
                time.sleep(wait_sec)
        self.timestamps.append(time.time())

    def fetch(self, barcode: str) -> dict[str, Any] | None:
        code = re.sub(r"[^0-9A-Za-z]", "", barcode or "")
        if not code:
            return None
        cached = self.cache.get_off(code, self.ttl_days)
        if cached is not None:
            return cached
        url = (
            "https://world.openfoodfacts.org/api/v2/product/"
            + urllib.parse.quote(code)
            + "?fields="
            + urllib.parse.quote(OFF_FIELDS)
        )
        headers = {"Accept": "application/json", "User-Agent": "aicheff/1.0 (contact: local)"}
        for attempt in range(4):
            self._throttle()
            req = urllib.request.Request(url=url, method="GET", headers=headers)
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                    raw = resp.read().decode("utf-8", errors="replace")
                    status = resp.status
            except urllib.error.HTTPError as exc:
                status = exc.code
                if status == 404:
                    return None
                if status in {429, 500, 502, 503, 504} and attempt < 3:
                    time.sleep(2**attempt)
                    continue
                return None
            except (urllib.error.URLError, TimeoutError):
                if attempt < 3:
                    time.sleep(2**attempt)
                    continue
                return None
            if status >= 400:
                return None
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                return None
            product = payload.get("product")
            if isinstance(product, dict):
                self.cache.set_off(code, product)
                return product
            return None
        return None


@dataclass
class RunConfig:
    input_dir: Path
    out_dir: Path
    mode: str
    as_of: str | None
    week_start: str | None
    week_window: str
    week_end_day: str | None
    include_locked: bool
    emit_visible: bool
    ollama_on: bool
    ollama_url: str
    ollama_model: str
    ollama_timeout: int
    ollama_max_consecutive_failures: int
    national_on: bool
    national_threshold: float
    min_rule_score: float
    min_margin: float
    embeddings_on: bool
    knn_k: int
    knn_threshold: float
    keywords_file: Path | None
    nutrition_on: bool
    nutrition_source: str
    nutrition_ttl_days: int
    max_off_req_per_min: int
    bls_path: Path
    diet_on: bool
    halal_on: bool
    veg_implies_halal: bool
    dump_stats: bool
    # Extra attempts for a single timed-out item before skipping it (0 = none).
    # Trailing default so existing RunConfig(...) call sites stay valid.
    ollama_retries: int = 0


def load_bls(path: Path) -> list[dict[str, Any]]:
    files: list[Path] = [path] if path.is_file() else sorted(path.glob("*.json")) if path.exists() else []
    items: list[dict[str, Any]] = []
    for file_path in files:
        try:
            payload = json.loads(file_path.read_text(encoding="utf-8-sig"))
        except json.JSONDecodeError:
            continue
        if isinstance(payload, dict) and isinstance(payload.get("foods"), list):
            items.extend([entry for entry in payload["foods"] if isinstance(entry, dict)])
        elif isinstance(payload, list):
            items.extend([entry for entry in payload if isinstance(entry, dict)])
    return items


def map_allergen(token: str) -> str | None:
    n = normalize_text(token)
    for key, value in ALLERGEN_MAP.items():
        if key in n:
            return value
    return None


def extract_allergens_from_off(product: dict[str, Any]) -> tuple[list[str], list[str]]:
    contains: set[str] = set()
    may: set[str] = set()
    for value in product.get("allergens_tags", []) if isinstance(product.get("allergens_tags"), list) else []:
        mapped = map_allergen(str(value))
        if mapped:
            contains.add(mapped)
    for value in product.get("traces_tags", []) if isinstance(product.get("traces_tags"), list) else []:
        mapped = map_allergen(str(value))
        if mapped:
            may.add(mapped)
    return sorted(contains), sorted(may)


def infer_food_flag(offer: dict[str, Any], extra_keywords: list[str] | None = None) -> tuple[str, list[str]]:
    canonical = offer.get("canonicalCategory") if isinstance(offer.get("canonicalCategory"), dict) else {}
    source_text = normalize_text(str(offer.get("category") or offer.get("sourceCategory") or ""))
    department_text = normalize_text(str(offer.get("department") or ""))
    combined_text = normalize_text(
        " ".join(
            [
                str(offer.get("title") or offer.get("name") or ""),
                str(offer.get("brand") or ""),
                str(offer.get("category") or ""),
                str(offer.get("sourceCategory") or ""),
                str(offer.get("department") or ""),
            ]
        )
    )

    rescue = detect_food_rescue(offer)
    if rescue is not None:
        apply_food_rescue_to_canonical(offer, rescue)
        return "food", ["rescue:food_drink"]

    # Der PRODUKTNAME und die HÄNDLER-ABTEILUNG sind verschieden starke Belege.
    # `nonfood_kw:` bezieht sich deshalb ausschliesslich auf Titel + Marke: eine
    # gemischte Abteilung wie Kauflands "Drogerie, Tiernahrung" darf nicht
    # JEDES Angebot des Regals mit `nonfood_kw:tiernahrung` als Non-Food belegen
    # (Befund 2026-08-17: "ESN Isoclear Whey-Protein", "KORO Proteinriegel",
    # "APTAMIL Folgemilch"). Abteilungswörter laufen unten über
    # `nonfood_department:` weiter — dort greift die Ausnahme für eindeutig
    # essbare Warenarten im Namen.
    name_text = normalize_text(
        " ".join(
            [
                str(offer.get("title") or offer.get("name") or ""),
                str(offer.get("brand") or ""),
            ]
        )
    )
    keyword_list = NONFOOD_KEYWORDS + [normalize_text(value) for value in (extra_keywords or []) if normalize_text(value)]
    nonfood_keyword_hits = find_keyword_hits(name_text, keyword_list)
    if nonfood_keyword_hits:
        return "nonfood", [f"nonfood_kw:{token}" for token in nonfood_keyword_hits[:6]]

    department_nonfood_hits = find_keyword_hits(source_text + " " + department_text, NONFOOD_DEPARTMENT_HINTS)
    source_is_sonstiges = any(hint in source_text for hint in SOURCE_SONSTIGES_HINTS)
    edible_name_hits = find_keyword_hits(name_text, EDIBLE_PRODUCT_NAME_KEYWORDS)

    if department_nonfood_hits and not source_is_sonstiges and not edible_name_hits:
        return "nonfood", [f"nonfood_department:{token}" for token in department_nonfood_hits[:4]]
    if department_nonfood_hits and edible_name_hits:
        # Abteilung sagt Non-Food, der Name nennt eine eindeutig essbare Warenart
        # (Whey-Protein, Proteinriegel, Folgemilch). Kein hartes Urteil in
        # BEIDE Richtungen — die KI/Review entscheidet.
        return "unsure", [
            f"department_vs_edible_name:{department_nonfood_hits[0]}",
            f"edible_kw:{edible_name_hits[0]}",
        ]

    canonical_reasons = canonical.get("reasons") if isinstance(canonical.get("reasons"), list) else []
    hard_nonfood_reason_keywords = set(keyword_list)
    canonical_nonfood_reasons = [
        str(reason)
        for reason in canonical_reasons
        if (
            str(reason).startswith("nonfood_kw:")
            and str(reason).split(":", 1)[-1].strip() in hard_nonfood_reason_keywords
        )
        or str(reason).startswith("override:backwaren_to_nonfood")
        or str(reason).startswith("override:is_non_food")
    ]
    if (canonical.get("isNonFood") is True or canonical.get("main") == "Non-Food") and canonical_nonfood_reasons:
        return "nonfood", ["category:nonfood", *canonical_nonfood_reasons[:4]]

    if (
        (canonical.get("isNonFood") is True or canonical.get("main") == "Non-Food")
        and source_is_sonstiges
        and not nonfood_keyword_hits
        and not department_nonfood_hits
    ):
        canonical["main"] = "Grundnahrungsmittel"
        canonical["sub"] = "unknown"
        canonical["isNonFood"] = False
        existing_reasons = canonical.get("reasons")
        merged = list(existing_reasons) if isinstance(existing_reasons, list) else []
        merged.append("repair:sonstiges_nonfood_unverified")
        canonical["reasons"] = list(dict.fromkeys(str(item) for item in merged if str(item).strip()))
        try:
            canonical_conf = float(canonical.get("confidence", 0.0) or 0.0)
        except (TypeError, ValueError):
            canonical_conf = 0.0
        canonical["confidence"] = min(canonical_conf if canonical_conf > 0 else 0.58, 0.66)

    conf_raw = canonical.get("confidence", 0.0)
    try:
        conf = float(conf_raw)
    except (TypeError, ValueError):
        conf = 0.0
    sub = str(canonical.get("sub", "unknown") or "unknown")

    if source_is_sonstiges and (sub == "unknown" or conf < 0.78):
        return "unsure", ["source_sonstiges_unclear"]

    if conf < 0.62 or sub == "unknown":
        return "unsure", ["rule:low_confidence"]

    return "food", ["rule:category_food"]


def load_additional_keywords(path: Path | None) -> list[str]:
    if path is None or not path.exists():
        return []
    try:
        raw = path.read_text(encoding="utf-8-sig")
    except OSError:
        return []

    values: list[str] = []
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        payload = None

    if isinstance(payload, list):
        values.extend(str(item) for item in payload if isinstance(item, (str, int, float)))
    elif isinstance(payload, dict):
        keyword_values = payload.get("keywords")
        if isinstance(keyword_values, list):
            values.extend(str(item) for item in keyword_values if isinstance(item, (str, int, float)))
    else:
        for line in raw.splitlines():
            line = line.strip()
            if line and not line.startswith("#"):
                values.append(line)

    deduped: list[str] = []
    seen: set[str] = set()
    for value in values:
        token = normalize_text(value)
        if token and token not in seen:
            seen.add(token)
            deduped.append(token)
    return deduped


# Die fruehere `infer_diet_and_halal`-Funktion (mit `veg_implies_halal`) wurde in
# Phase 2.0 ersatzlos entfernt. Die EINE Entscheidungslogik fuer
# vegan/vegetarisch/halal lebt jetzt ausschliesslich in
# aichef_offers/product_analysis.py; `dietFlags` wird daraus via
# legacy_diet_flags() abgeleitet (keine widerspruechlichen Parallelregeln).


def parse_per_100_from_off(product: dict[str, Any]) -> tuple[dict[str, float | None], float]:
    nutriments = product.get("nutriments")
    if not isinstance(nutriments, dict):
        return {
            "kcal": None,
            "protein_g": None,
            "carbs_g": None,
            "fat_g": None,
            "sugars_g": None,
            "salt_g": None,
            "fiber_g": None,
        }, 0.0
    per_100 = {
        "kcal": to_number(nutriments.get("energy-kcal_100g")) or to_number(nutriments.get("energy-kcal")),
        "protein_g": to_number(nutriments.get("proteins_100g")),
        "carbs_g": to_number(nutriments.get("carbohydrates_100g")),
        "fat_g": to_number(nutriments.get("fat_100g")),
        "sugars_g": to_number(nutriments.get("sugars_100g")),
        "salt_g": to_number(nutriments.get("salt_100g")),
        "fiber_g": to_number(nutriments.get("fiber_100g")),
    }
    found = sum(1 for value in per_100.values() if value is not None)
    confidence = min(0.95, 0.22 + found * 0.12)
    return per_100, confidence


# Globale Ausschluss-Marker: Varianten-/Misch-/Sortimentsangebote, deren echter
# Nährwert nicht aus einem einzelnen Grundprodukt ableitbar ist. Treffer hier ->
# gar kein BLS-Match (ehrlich unknown statt falscher Schätzung).
BLS_GLOBAL_EXCLUDE = (
    "sortiment",
    "verschiedene",
    "versch ",
    "nach wahl",
    "sorten",
    "auswahl",
    "diverse",
    "je packung",
    "verschiedene sorten",
    # Verarbeitete Misch-/Alkohol-Marker -> nicht aus einem Grundprodukt schätzbar
    "smoothie",
    "% vol",
)


def _bls_anchor_hit(title_norm: str, title_tokens: set[str], anchor: str) -> bool:
    """True wenn `anchor` (normalisiert) im Titel steckt. Mehrwort-Anker als
    direkter Teilstring; Einwort-Anker als Teilstring eines Tokens, damit
    deutsche Komposita greifen ("milch" in "vollmilch", "tomate" in
    "rispentomaten")."""
    if not anchor:
        return False
    if " " in anchor:
        return anchor in title_norm
    return any(anchor in token for token in title_tokens)


def match_bls(offer: dict[str, Any], entries: list[dict[str, Any]], cache: NutritionCache, fingerprint: str) -> tuple[dict[str, Any] | None, float]:
    """Konservatives BLS-Matching für barcodelose Prospekt-Angebote.

    Sicherheitsregeln (Reihenfolge):
      1. Globale Ausschlüsse (Sortiment/Varianten) -> kein Match.
      2. Kategorie-Gate: canonicalCategory.main MUSS der BLS-Kategorie
         entsprechen (verhindert z. B. "Apfelsaft"=Getränke -> "Apfel"=Obst).
      3. Pro-Eintrag-Ausschlüsse (z. B. Joghurt schließt "frucht" aus).
      4. Anker-Treffer im Namen. Der längste/spezifischste Anker gewinnt.
    Ergebnis ist immer nur eine Schätzung (nutrition.source='bls' -> estimated),
    nie 'verified'.
    """
    if not entries:
        return None, 0.0

    title_norm = normalize_text(offer.get("title") or offer.get("name") or "")
    if not title_norm:
        return None, 0.0

    cached = cache.get_bls(fingerprint)
    if cached:
        bls_id, confidence = cached
        for entry in entries:
            if str(entry.get("id", "")) == bls_id:
                return entry, confidence

    # 1) globale Ausschlüsse (Varianten-/Sortimentsangebote)
    if " oder " in f" {title_norm} ":
        return None, 0.0
    for marker in BLS_GLOBAL_EXCLUDE:
        if marker in title_norm:
            return None, 0.0

    title_tokens = set(title_norm.split())
    main_norm = normalize_text(str((offer.get("canonicalCategory") or {}).get("main", "")))

    best: tuple[float, dict[str, Any]] | None = None
    for entry in entries:
        if not isinstance(entry, dict):
            continue

        # 2) Kategorie-Gate — ohne plausible Kategorie kein Match.
        entry_cat = normalize_text(str(entry.get("category", "")))
        if not entry_cat or not main_norm or main_norm != entry_cat:
            continue

        # 3) Pro-Eintrag-Ausschlüsse
        excludes = [normalize_text(str(x)) for x in (entry.get("exclude") or []) if str(x).strip()]
        if any(ex and ex in title_norm for ex in excludes):
            continue

        # 4) Anker (anchors + name + aliases) als Teilstring/Token-Treffer.
        anchors: list[str] = []
        for value in entry.get("anchors") or []:
            anchors.append(normalize_text(str(value)))
        anchors.append(normalize_text(str(entry.get("name", ""))))
        for value in entry.get("aliases") or []:
            anchors.append(normalize_text(str(value)))

        hit: str | None = None
        for anchor in anchors:
            if anchor and _bls_anchor_hit(title_norm, title_tokens, anchor):
                if hit is None or len(anchor) > len(hit):
                    hit = anchor
        if hit is None:
            continue

        # Längerer, spezifischerer Anker -> höhere (interne) Confidence.
        score = 0.6 + min(0.3, 0.02 * len(hit))
        if best is None or score > best[0]:
            best = (score, entry)

    if best is None:
        return None, 0.0

    entry = best[1]
    bls_id = str(entry.get("id", ""))
    if bls_id:
        cache.set_bls(fingerprint, bls_id, best[0])
    return entry, best[0]


def enrich_offer(
    offer: dict[str, Any],
    off_client: OFFClient | None,
    bls_entries: list[dict[str, Any]],
    cache: NutritionCache,
    config: RunConfig,
    extra_keywords: list[str] | None = None,
    *,
    trusted: TrustedEvidenceContext | None = None,
) -> dict[str, Any]:
    out = dict(offer)
    food_flag, food_reasons = infer_food_flag(out, extra_keywords=extra_keywords)
    out["foodFlag"] = food_flag
    out["foodReasons"] = food_reasons
    out["nonfoodReasons"] = food_reasons if food_flag == "nonfood" else []

    coverage = float(out.get("snapshotCoverage", 0) or 0) / max(1.0, float(out.get("snapshotTotal", 1) or 1))
    out["national"] = {
        "isNational": bool(config.national_on and (out.get("snapshotTotal", 1) or 1) > 1 and coverage >= config.national_threshold),
        "coverage": round(coverage, 4),
        "snapshotsPresent": int(out.get("snapshotCoverage", 0) or 0),
        "totalSnapshots": int(out.get("snapshotTotal", 1) or 1),
    }

    amount, basis, amount_conf = parse_quantity(
        " ".join(
            [
                str(out.get("unit") or ""),
                str(out.get("size") or ""),
                str(out.get("title") or out.get("name") or ""),
            ]
        )
    )
    fingerprint = str(out.get("offerFingerprint", out.get("id", "")))
    gtin = str(out.get("gtin") or out.get("ean") or out.get("barcode") or "")
    off_product = off_client.fetch(gtin) if (off_client is not None and gtin and config.nutrition_source in {"off", "both"}) else None

    if config.nutrition_on and isinstance(off_product, dict):
        per_100, confidence = parse_per_100_from_off(off_product)
        nutrition = {
            "source": "openfoodfacts",
            "per_100g": per_100,
            "per_item_estimate": estimate_per_item(per_100, amount, basis),
            "confidence": round(max(confidence, amount_conf * 0.15), 4),
            "refs": {"gtin": gtin},
        }
    elif config.nutrition_on and config.nutrition_source in {"bls", "both"}:
        bls_entry, bls_conf = match_bls(out, bls_entries, cache, fingerprint)
        if bls_entry:
            per_100g = bls_entry.get("per_100g", {}) if isinstance(bls_entry.get("per_100g"), dict) else {}
            normalized = {
                "kcal": to_number(per_100g.get("kcal")),
                "protein_g": to_number(per_100g.get("protein_g")),
                "carbs_g": to_number(per_100g.get("carbs_g")),
                "fat_g": to_number(per_100g.get("fat_g")),
                "sugars_g": to_number(per_100g.get("sugars_g")),
                "salt_g": to_number(per_100g.get("salt_g")),
                "fiber_g": to_number(per_100g.get("fiber_g")),
            }
            nutrition = {
                "source": "bls",
                "per_100g": normalized,
                "per_item_estimate": estimate_per_item(normalized, amount, basis),
                "confidence": round(min(0.9, 0.45 + bls_conf * 0.4), 4),
                "refs": {"bls_id": str(bls_entry.get("id", ""))},
            }
        else:
            nutrition = {
                "source": "none",
                "per_100g": {"kcal": None, "protein_g": None, "carbs_g": None, "fat_g": None, "sugars_g": None, "salt_g": None, "fiber_g": None},
                "per_item_estimate": None,
                "confidence": 0.0,
                "refs": {},
            }
    else:
        nutrition = {
            "source": "none",
            "per_100g": {"kcal": None, "protein_g": None, "carbs_g": None, "fat_g": None, "sugars_g": None, "salt_g": None, "fiber_g": None},
            "per_item_estimate": None,
            "confidence": 0.0,
            "refs": {},
        }
    out["nutrition"] = nutrition

    # Phase 2.0: EINE evidenzbasierte Wahrheit (product_analysis). dietFlags und
    # allergens werden deterministisch hieraus abgeleitet — keine Parallelregeln.
    # diet_on/halal_on schalten nur die ABLEITUNG, nicht eine zweite Logik.
    #
    # Trust-Boundary (pa-v6): privilegierte externe Evidenz entsteht AUSSCHLIESSLICH
    # ueber den getrennt uebergebenen ``trusted`` (TrustedEvidenceContext), den nur
    # ein verifizierter Connector-/OCR-/KI-/Hersteller-Produzent erzeugen darf.
    # Normale Offer-Felder (retailerEvidence/ocrEvidence/aiEvidence/
    # manufacturerEvidence/evidenceInputs) sind UNTRUSTED und koennen keinen Status
    # mehr veraendern. Da derzeit KEIN realer Produzent einen solchen Kontext sicher
    # erzeugt, bleibt ``trusted`` im echten Scan leer (None) — es wird keine
    # kuenstliche Evidenz erfunden. OFF/Barcode bleibt separat barcode_database.
    analysis = build_product_analysis(
        out,
        off_product if isinstance(off_product, dict) else None,
        nutrition,
        amount=amount,
        basis=basis,
        trusted=trusted,
        now=datetime.now(timezone.utc).isoformat(),
    )
    out["productAnalysis"] = analysis
    out["allergens"] = legacy_allergens(analysis)

    diet = legacy_diet_flags(analysis)
    if not config.diet_on:
        diet["vegan"] = None
        diet["vegetarian"] = None
    if not config.halal_on:
        diet["halal"] = {"status": "unknown", "statusV2": "unknown", "confidence": 0.0, "reasons": ["halal:disabled"]}
    out["dietFlags"] = diet

    # Review-Gruende der Analyse in die bestehenden Felder spiegeln (P8), ohne
    # eine bereits gesetzte redaktionelle Review-Markierung zu ueberschreiben.
    if analysis["reviewNeeded"] and out.get("reviewNeeded") is not True:
        out["reviewNeeded"] = True
        out.setdefault("reviewReason", analysis["reviewReasons"][0] if analysis["reviewReasons"] else "review_needed")
    if analysis["reviewReasons"]:
        out["reviewReasons"] = analysis["reviewReasons"]
    return out


def write_json(path: Path, payload: Any) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def build_summary(offers: list[dict[str, Any]], path: Path) -> None:
    by_chain = Counter(str(offer.get("chain") or offer.get("storeChain") or "-") for offer in offers)
    by_main = Counter(str((offer.get("canonicalCategory") or {}).get("main", "")) for offer in offers)
    by_sub = Counter(f"{(offer.get('canonicalCategory') or {}).get('main','')}/{(offer.get('canonicalCategory') or {}).get('sub','unknown')}" for offer in offers)
    unknown_sub = sum(1 for offer in offers if str((offer.get("canonicalCategory") or {}).get("sub", "")) == "unknown")
    nonfood = sum(1 for offer in offers if offer.get("foodFlag") == "nonfood")
    starts_midweek = sum(1 for offer in offers if ((offer.get("weekFlags") or {}).get("startsMidweek") is True))
    ends_before_week_end = sum(1 for offer in offers if ((offer.get("weekFlags") or {}).get("endsBeforeWeekEnd") is True))
    in_week_offers = [offer for offer in offers if ((offer.get("weekFlags") or {}).get("inWeek") is True)]
    locked_count = sum(
        1 for offer in in_week_offers if ((offer.get("offerAvailability") or {}).get("status") == "locked")
    )
    unlocked_count = sum(
        1 for offer in in_week_offers if ((offer.get("offerAvailability") or {}).get("status") == "unlocked")
    )
    unlocked_by_chain = Counter(
        str(offer.get("chain") or offer.get("storeChain") or "-")
        for offer in in_week_offers
        if ((offer.get("offerAvailability") or {}).get("status") == "unlocked")
    )
    overrides = sum(1 for offer in offers if any(str(r).startswith("repair:") for r in ((offer.get("canonicalCategory") or {}).get("reasons") or [])))
    review_reasons = Counter(
        reason.strip()
        for offer in offers
        for reason in str(offer.get("reviewReason") or "").split(",")
        if reason.strip()
    )
    nutrition_cov = Counter(str((offer.get("nutrition") or {}).get("source", "none")) for offer in offers)
    allergens_top = Counter(a for offer in offers for a in ((offer.get("allergens") or {}).get("contains") or []))
    halal_stats = Counter(str(((offer.get("dietFlags") or {}).get("halal") or {}).get("status", "unknown")) for offer in offers)
    gelatin_src = Counter(str(((offer.get("dietFlags") or {}).get("gelatin") or {}).get("source", "null")) for offer in offers)
    halal_reasons = Counter(r for offer in offers for r in (((offer.get("dietFlags") or {}).get("halal") or {}).get("reasons") or []))

    # --- Phase 2.0 ProductAnalysisV2 coverage (eine Wahrheit) -------------
    def _pa(offer: dict[str, Any]) -> dict[str, Any]:
        pa = offer.get("productAnalysis")
        return pa if isinstance(pa, dict) else {}

    vegan_cov = Counter(str(((_pa(o).get("vegan") or {}).get("status", "unknown"))) for o in offers)
    vegetarian_cov = Counter(str(((_pa(o).get("vegetarian") or {}).get("status", "unknown"))) for o in offers)
    halal_v2_cov = Counter(str(((_pa(o).get("halal") or {}).get("status", "unknown"))) for o in offers)
    nutrition_quality_cov = Counter(str(((_pa(o).get("nutrition") or {}).get("quality", "unknown"))) for o in offers)
    diet_source_cov = Counter(str(((_pa(o).get("halal") or {}).get("source", "unknown"))) for o in offers)
    eu14_cov: Counter = Counter()
    for o in offers:
        per = _pa(o).get("allergens") or {}
        for code, info in per.items():
            if isinstance(info, dict) and info.get("status") not in (None, "unknown"):
                eu14_cov[code] += 1
    review_count = sum(1 for o in offers if _pa(o).get("reviewNeeded") is True)
    review_reason_cov = Counter(r for o in offers for r in (_pa(o).get("reviewReasons") or []))
    total = len(offers)
    lines = [
        "# AICheff Summary",
        "",
        f"- total: `{total}`",
        f"- unknown_sub_percent: `{(unknown_sub / total * 100 if total else 0):.2f}%`",
        f"- nonfood: `{nonfood}`",
        f"- starts_midweek: `{starts_midweek}`",
        f"- ends_before_week_end: `{ends_before_week_end}`",
        f"- unlocked_in_week: `{unlocked_count}`",
        f"- locked_in_week: `{locked_count}`",
        f"- overrides: `{overrides}`",
        "",
        "## Counts by chain",
        "",
    ]
    for key, value in sorted(by_chain.items(), key=lambda x: x[0]):
        lines.append(f"- {key}: {value}")
    lines.extend(["", "## Main/Sub", ""])
    for key, value in sorted(by_main.items(), key=lambda x: x[0]):
        lines.append(f"- {key}: {value}")
    lines.extend(["", "### Sub", ""])
    for key, value in sorted(by_sub.items(), key=lambda x: x[0]):
        lines.append(f"- {key}: {value}")
    lines.extend(["", "## Unlocked by chain", ""])
    if unlocked_by_chain:
        for key, value in sorted(unlocked_by_chain.items(), key=lambda x: x[0]):
            lines.append(f"- {key}: {value}")
    else:
        lines.append("- none")
    lines.extend(["", "## Top review reasons", ""])
    if review_reasons:
        for key, value in review_reasons.most_common(20):
            lines.append(f"- {key}: {value}")
    else:
        lines.append("- none")
    lines.extend(["", "## Nutrition coverage", ""])
    for key, value in sorted(nutrition_cov.items(), key=lambda x: x[0]):
        pct = value / total * 100 if total else 0
        lines.append(f"- {key}: {value} ({pct:.2f}%)")
    lines.extend(["", "## Allergens top", ""])
    for key, value in allergens_top.most_common(20):
        lines.append(f"- {key}: {value}")
    if not allergens_top:
        lines.append("- none")
    lines.extend(["", "## Halal", ""])
    for key, value in sorted(halal_stats.items(), key=lambda x: x[0]):
        lines.append(f"- {key}: {value}")
    lines.extend(["", "### Halal reasons", ""])
    for key, value in halal_reasons.most_common(20):
        lines.append(f"- {key}: {value}")
    if not halal_reasons:
        lines.append("- none")
    lines.extend(["", "### Gelatin source", ""])
    for key, value in gelatin_src.most_common():
        lines.append(f"- {key}: {value}")

    def _cov_block(title: str, counter: Counter, keys: list[str] | None = None) -> None:
        lines.extend(["", title, ""])
        items = [(k, counter.get(k, 0)) for k in keys] if keys else sorted(counter.items(), key=lambda x: x[0])
        if not items:
            lines.append("- none")
            return
        for key, value in items:
            pct = value / total * 100 if total else 0
            lines.append(f"- {key}: {value} ({pct:.2f}%)")

    lines.extend(["", "## Phase 2.0 — ProductAnalysisV2 coverage", ""])
    _cov_block("### Vegan", vegan_cov, ["yes", "no", "unknown"])
    _cov_block("### Vegetarian", vegetarian_cov, ["yes", "no", "unknown"])
    _cov_block("### Halal (V2)", halal_v2_cov, ["halal", "not_halal", "doubtful", "unknown"])
    _cov_block("### Nutrition quality tiers", nutrition_quality_cov,
               ["manufacturer_label", "retailer_structured", "barcode_database", "ocr_extracted", "estimated", "unknown"])
    _cov_block("### Diet evidence source", diet_source_cov)
    _cov_block("### EU-14 allergen coverage (offers with a known status)", eu14_cov, list(EU14_KEYS))
    lines.extend(["", f"### Review (ProductAnalysisV2): {review_count} ({(review_count / total * 100 if total else 0):.2f}%)", ""])
    if review_reason_cov:
        for key, value in review_reason_cov.most_common(20):
            lines.append(f"- {key}: {value}")
    else:
        lines.append("- none")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def run_pipeline(config: RunConfig) -> dict[str, Any]:
    config.out_dir.mkdir(parents=True, exist_ok=True)
    as_of_date_local = resolve_as_of_date(config.as_of)
    as_of_anchor = datetime(
        as_of_date_local.year,
        as_of_date_local.month,
        as_of_date_local.day,
        12,
        0,
        tzinfo=BERLIN_TZ,
    )
    def _emit_progress(payload: dict[str, Any]) -> None:
        try:
            sys.stdout.write("__AICHEF_PROGRESS__" + json.dumps(payload, ensure_ascii=False) + "\n")
            sys.stdout.flush()
        except Exception:
            pass

    with tempfile.TemporaryDirectory(prefix="aichef_base_") as temp_dir_raw:
        temp_dir = Path(temp_dir_raw)
        base_stats = run_base_pipeline(
            input_dir=config.input_dir,
            out_dir=temp_dir,
            mode=config.mode,
            ollama_mode="on" if config.ollama_on else "off",
            model=config.ollama_model,
            ollama_host=config.ollama_url,
            week_start_iso=config.week_start,
            week_window_mode=config.week_window,
            week_end_day=config.week_end_day,
            min_rule_score=config.min_rule_score,
            use_llm_threshold=0.72,
            dump_stats=False,
            now=as_of_anchor,
            on_progress=_emit_progress,
            llm_timeout_seconds=config.ollama_timeout,
            max_consecutive_failures=config.ollama_max_consecutive_failures,
            item_retries=config.ollama_retries,
        )
        categorized = json.loads((temp_dir / "categorized_offers.json").read_text(encoding="utf-8"))
        offers = categorized.get("offers", [])
        if not isinstance(offers, list):
            offers = []

    cache = NutritionCache(Path("cache/nutrition_cache.sqlite"))
    off_client = (
        OFFClient(cache, config.nutrition_ttl_days, config.max_off_req_per_min, config.ollama_timeout)
        if config.nutrition_on and config.nutrition_source in {"off", "both"}
        else None
    )
    bls_entries = load_bls(config.bls_path) if config.nutrition_on and config.nutrition_source in {"bls", "both"} else []
    extra_keywords = load_additional_keywords(config.keywords_file)
    try:
        enriched = [enrich_offer(offer, off_client, bls_entries, cache, config, extra_keywords) for offer in offers]
    finally:
        cache.close()

    for offer in enriched:
        offer["offerAvailability"] = compute_offer_availability(offer, as_of_date_local)

    all_in_week_full = [offer for offer in enriched if ((offer.get("weekFlags") or {}).get("inWeek") is True)]
    visible_in_week = [
        offer
        for offer in all_in_week_full
        if ((offer.get("offerAvailability") or {}).get("status") == "unlocked")
    ]
    if config.include_locked:
        all_in_week = all_in_week_full
    else:
        all_in_week = visible_in_week
    food_in_week = [offer for offer in all_in_week if offer.get("foodFlag") != "nonfood"]
    # ALL enriched food offers regardless of week (current + next week + undated).
    # Consumers that do their own week-split (e.g. the backend snapshot, which
    # keeps a separate next-week bucket) need the full set so next-week offers
    # are not lost. `all_in_week`/`food_in_week` stay this-week-only for callers
    # that want exactly the current week.
    food_all = [offer for offer in enriched if offer.get("foodFlag") != "nonfood"]
    flagged_nonfood = [offer for offer in enriched if offer.get("foodFlag") == "nonfood"]
    flagged_midweek = [offer for offer in all_in_week_full if ((offer.get("weekFlags") or {}).get("startsMidweek") is True)]
    flagged_locked = [
        offer
        for offer in enriched
        if ((offer.get("offerAvailability") or {}).get("status") == "locked")
    ]
    flagged_halal_no = [
        offer
        for offer in enriched
        if (((offer.get("dietFlags") or {}).get("halal") or {}).get("status") == "no")
    ]
    flagged_gelatin_unknown = [
        offer
        for offer in enriched
        if (((offer.get("dietFlags") or {}).get("gelatin") or {}).get("present") is True)
        and (((offer.get("dietFlags") or {}).get("gelatin") or {}).get("source") == "unknown")
    ]
    debug_low_confidence = [
        offer
        for offer in enriched
        if float((offer.get("canonicalCategory") or {}).get("confidence", 0.0)) < 0.75
        or str((offer.get("canonicalCategory") or {}).get("sub", "unknown")) == "unknown"
        or str((offer.get("nutrition") or {}).get("source", "none")) == "none"
        or float((offer.get("allergens") or {}).get("confidence", 0.0)) < 0.5
        or (
            (((offer.get("dietFlags") or {}).get("gelatin") or {}).get("present") is True)
            and (((offer.get("dietFlags") or {}).get("halal") or {}).get("status") == "unknown")
        )
    ]

    write_json(
        config.out_dir / "all_in_week.json",
        {
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "asOfDateLocal": as_of_date_local.isoformat(),
            "offers": all_in_week,
        },
    )
    visible_path = config.out_dir / "visible_in_week.json"
    if config.emit_visible:
        write_json(
            visible_path,
            {
                "generatedAt": datetime.now(timezone.utc).isoformat(),
                "asOfDateLocal": as_of_date_local.isoformat(),
                "offers": visible_in_week,
            },
        )
    elif visible_path.exists():
        visible_path.unlink()
    write_json(
        config.out_dir / "food_in_week.json",
        {"generatedAt": datetime.now(timezone.utc).isoformat(), "offers": food_in_week},
    )
    write_json(
        config.out_dir / "food_all.json",
        {"generatedAt": datetime.now(timezone.utc).isoformat(), "offers": food_all},
    )
    write_json(
        config.out_dir / "flagged_nonfood.json",
        {"generatedAt": datetime.now(timezone.utc).isoformat(), "offers": flagged_nonfood},
    )
    write_json(
        config.out_dir / "flagged_midweek.json",
        {"generatedAt": datetime.now(timezone.utc).isoformat(), "offers": flagged_midweek},
    )
    write_json(
        config.out_dir / "flagged_locked.json",
        {"generatedAt": datetime.now(timezone.utc).isoformat(), "asOfDateLocal": as_of_date_local.isoformat(), "offers": flagged_locked},
    )
    write_json(
        config.out_dir / "debug_low_confidence.json",
        {"generatedAt": datetime.now(timezone.utc).isoformat(), "offers": debug_low_confidence},
    )
    write_json(
        config.out_dir / "flagged_halal_no.json",
        {"generatedAt": datetime.now(timezone.utc).isoformat(), "offers": flagged_halal_no},
    )
    write_json(
        config.out_dir / "flagged_gelatin_unknown.json",
        {"generatedAt": datetime.now(timezone.utc).isoformat(), "offers": flagged_gelatin_unknown},
    )
    build_summary(enriched, config.out_dir / "summary.md")

    stats = {
        "base": base_stats,
        "all_in_week": len(all_in_week),
        "all_in_week_full": len(all_in_week_full),
        "visible_in_week": len(visible_in_week),
        "locked": len(flagged_locked),
        "unlocked": len(visible_in_week),
        "food_in_week": len(food_in_week),
        "food_all": len(food_all),
        "flagged_nonfood": len(flagged_nonfood),
        "flagged_midweek": len(flagged_midweek),
        "flagged_locked": len(flagged_locked),
        "debug_low_confidence": len(debug_low_confidence),
        "flagged_halal_no": len(flagged_halal_no),
        "flagged_gelatin_unknown": len(flagged_gelatin_unknown),
        "out_dir": str(config.out_dir.resolve()),
    }
    if config.dump_stats:
        write_json(config.out_dir / "stats.json", stats)
    return stats


def run_eval(config: RunConfig) -> dict[str, Any]:
    pipeline_stats = run_pipeline(config)
    all_in_week_payload = json.loads((config.out_dir / "all_in_week.json").read_text(encoding="utf-8"))
    offers = all_in_week_payload.get("offers", [])
    if not isinstance(offers, list):
        offers = []

    total = len(offers)
    unknown_sub = 0
    repair_counts: Counter[str] = Counter()
    week_flag_counts: Counter[str] = Counter()
    suspects: list[dict[str, Any]] = []

    for offer in offers:
        canonical = offer.get("canonicalCategory") or {}
        reasons = canonical.get("reasons") or []
        week_flags = offer.get("weekFlags") or {}
        category_suspects = offer.get("categorySuspects") or []

        if str(canonical.get("sub", "unknown")) == "unknown":
            unknown_sub += 1

        for reason in reasons if isinstance(reasons, list) else []:
            if not isinstance(reason, str):
                continue
            if reason.startswith("repair:") or reason.startswith("override:"):
                repair_counts[reason] += 1

        for key in ("startsMidweek", "endsMidweek", "endsBeforeWeekEnd", "partialWeek"):
            if week_flags.get(key) is True:
                week_flag_counts[key] += 1

        suspect_reasons: list[str] = []
        if isinstance(category_suspects, list):
            suspect_reasons.extend(str(item) for item in category_suspects if str(item).strip())
        if str(canonical.get("sub", "unknown")) == "unknown":
            suspect_reasons.append("unknown_sub")
        if offer.get("reviewNeeded") is True:
            suspect_reasons.append(str(offer.get("reviewReason") or "review_needed"))
        for reason in reasons if isinstance(reasons, list) else []:
            if isinstance(reason, str) and (reason.startswith("repair:") or reason.startswith("override:")):
                suspect_reasons.append(reason)

        suspect_reasons = sorted(set(suspect_reasons))
        if suspect_reasons:
            suspects.append(
                {
                    "title": offer.get("title") or offer.get("name") or "",
                    "chain": offer.get("chain") or offer.get("storeChain") or "",
                    "canonicalCategory": canonical,
                    "suspects": suspect_reasons,
                }
            )

    suspects_sorted = sorted(
        suspects,
        key=lambda item: (
            0 if str((item.get("canonicalCategory") or {}).get("sub", "")) == "unknown" else 1,
            str(item.get("chain") or ""),
            str(item.get("title") or ""),
        ),
    )
    top_suspects = suspects_sorted[:50]
    write_json(
        config.out_dir / "category_suspects.json",
        {"generatedAt": datetime.now(timezone.utc).isoformat(), "offers": suspects_sorted},
    )

    lines = [
        "# Eval Summary",
        "",
        f"- total_offers_in_week: `{total}`",
        f"- unknown_sub_percent: `{(unknown_sub / total * 100 if total else 0):.2f}%`",
        f"- suspects_total: `{len(suspects_sorted)}`",
        "",
        "## Repairs by type",
        "",
    ]
    if repair_counts:
        for key, value in repair_counts.most_common():
            lines.append(f"- {key}: {value}")
    else:
        lines.append("- none")

    lines.extend(["", "## WeekFlags distribution", ""])
    for key in ("startsMidweek", "endsMidweek", "endsBeforeWeekEnd", "partialWeek"):
        value = int(week_flag_counts.get(key, 0))
        pct = (value / total * 100) if total else 0.0
        lines.append(f"- {key}: {value} ({pct:.2f}%)")

    lines.extend(["", "## Top 50 suspicious offers", ""])
    if top_suspects:
        for entry in top_suspects:
            canonical = entry.get("canonicalCategory") or {}
            lines.append(
                "- "
                + str(entry.get("chain") or "-")
                + ": "
                + str(entry.get("title") or "-")
                + " -> "
                + str(canonical.get("main") or "-")
                + "/"
                + str(canonical.get("sub") or "unknown")
                + " ("
                + ", ".join(entry.get("suspects") or [])
                + ")"
            )
    else:
        lines.append("- none")

    (config.out_dir / "summary.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    eval_stats = {
        "pipeline": pipeline_stats,
        "total_offers_in_week": total,
        "unknown_sub_count": unknown_sub,
        "suspects_total": len(suspects_sorted),
        "out_dir": str(config.out_dir.resolve()),
    }
    if config.dump_stats:
        write_json(config.out_dir / "eval_stats.json", eval_stats)
    return eval_stats


def download_bls(out_dir: Path) -> dict[str, Any]:
    out_dir.mkdir(parents=True, exist_ok=True)
    payload = {
        "foods": [
            {
                "id": "BLS-APPLE-001",
                "name": "Apfel, frisch",
                "aliases": ["aepfel", "äpfel", "apfel"],
                "category": "Obst & Gemüse",
                "per_100g": {"kcal": 52, "protein_g": 0.26, "carbs_g": 13.81, "fat_g": 0.17, "sugars_g": 10.39, "salt_g": 0.0, "fiber_g": 2.4},
            },
            {
                "id": "BLS-BEEF-001",
                "name": "Rinderhack, roh",
                "aliases": ["rinderhack", "hackfleisch rind", "hack"],
                "category": "Fleisch & Wurst",
                "per_100g": {"kcal": 254, "protein_g": 17.2, "carbs_g": 0.0, "fat_g": 20.0, "sugars_g": 0.0, "salt_g": 0.14, "fiber_g": 0.0},
            },
            {
                "id": "BLS-GOUDA-001",
                "name": "Gouda",
                "aliases": ["kaese gouda", "käse gouda"],
                "category": "Milchprodukte & Eier",
                "per_100g": {"kcal": 356, "protein_g": 24.9, "carbs_g": 2.2, "fat_g": 27.4, "sugars_g": 0.5, "salt_g": 1.8, "fiber_g": 0.0},
            },
        ]
    }
    target = out_dir / "bls_foods.json"
    write_json(target, payload)
    return {"ok": True, "file": str(target.resolve())}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="AICheff offers pipeline")
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--mode", choices=["overlap", "starts"], default="overlap")
    parser.add_argument("--as-of", default=None, help="Lokales Datum (Europe/Berlin) fuer Freischaltung/Week-Anchor, z.B. 2026-02-12")
    parser.add_argument("--week-start", default=None)
    parser.add_argument("--week-window", choices=["calendar", "retail"], default="calendar")
    parser.add_argument("--week-end-day", choices=["mon", "tue", "wed", "thu", "fri", "sat", "sun"], default=None)
    parser.add_argument("--include-locked", choices=["on", "off"], default="on")
    parser.add_argument("--emit-visible", choices=["on", "off"], default="on")
    parser.add_argument("--ollama", choices=["on", "off"], default="off")
    parser.add_argument("--ollama-url", default=os.environ.get("VITE_OLLAMA_HOST", "http://localhost:11434"))
    parser.add_argument("--ollama-model", default=os.environ.get("VITE_OLLAMA_MODEL", "qwen2.5:14b-instruct"))
    parser.add_argument("--ollama-timeout", type=int, default=45)
    # Abort the run after this many consecutive transport-level Ollama failures
    # (timeout / refused / HTTP 5xx). 0 = never abort (legacy behaviour). The
    # base category LLM honours this so a dead Ollama can't grind for hours.
    parser.add_argument("--ollama-max-consecutive-failures", type=int, default=0)
    # Extra attempts for a single timed-out item before skipping it (0 = none).
    parser.add_argument("--ollama-retries", type=int, default=0)
    parser.add_argument("--national", choices=["on", "off"], default="on")
    parser.add_argument("--national-threshold", type=float, default=0.80)
    parser.add_argument("--min-rule-score", type=float, default=3.0)
    parser.add_argument("--min-margin", type=float, default=1.5)
    parser.add_argument("--embeddings", choices=["on", "off"], default="off")
    parser.add_argument("--knn-k", type=int, default=5)
    parser.add_argument("--knn-threshold", type=float, default=0.70)
    parser.add_argument("--keywords-file", type=Path, default=None)
    parser.add_argument("--nutrition", choices=["on", "off"], default="on")
    parser.add_argument("--nutrition-source", choices=["off", "bls", "both"], default="both")
    parser.add_argument("--nutrition-ttl-days", type=int, default=30)
    parser.add_argument("--max-off-req-per-min", type=int, default=80)
    parser.add_argument("--bls-path", type=Path, default=Path("data/bls"))
    parser.add_argument("--diet", choices=["on", "off"], default="on")
    parser.add_argument("--halal", choices=["on", "off"], default="on")
    parser.add_argument("--veg-implies-halal", default="true")
    parser.add_argument("--dump-stats", action="store_true")
    return parser


def parse_config(argv: list[str] | None = None) -> RunConfig:
    args = build_parser().parse_args(argv)
    return RunConfig(
        input_dir=args.input,
        out_dir=args.out,
        mode=args.mode,
        as_of=args.as_of,
        week_start=args.week_start,
        week_window=args.week_window,
        week_end_day=args.week_end_day,
        include_locked=args.include_locked == "on",
        emit_visible=args.emit_visible == "on",
        ollama_on=args.ollama == "on",
        ollama_url=args.ollama_url,
        ollama_model=args.ollama_model,
        ollama_timeout=max(3, int(args.ollama_timeout)),
        ollama_max_consecutive_failures=max(0, int(args.ollama_max_consecutive_failures)),
        ollama_retries=max(0, int(args.ollama_retries)),
        national_on=args.national == "on",
        national_threshold=float(args.national_threshold),
        min_rule_score=float(args.min_rule_score),
        min_margin=float(args.min_margin),
        embeddings_on=args.embeddings == "on",
        knn_k=max(1, int(args.knn_k)),
        knn_threshold=float(args.knn_threshold),
        keywords_file=args.keywords_file,
        nutrition_on=args.nutrition == "on",
        nutrition_source=args.nutrition_source,
        nutrition_ttl_days=max(1, int(args.nutrition_ttl_days)),
        max_off_req_per_min=max(1, int(args.max_off_req_per_min)),
        bls_path=args.bls_path,
        diet_on=args.diet == "on",
        halal_on=args.halal == "on",
        veg_implies_halal=str(args.veg_implies_halal).strip().lower() in {"1", "true", "yes", "on"},
        dump_stats=bool(args.dump_stats),
    )


def main(argv: list[str] | None = None) -> None:
    args = list(argv) if argv is not None else None
    if args is None:
        import sys
        args = sys.argv[1:]
    if args and args[0] == "download-bls":
        parser = argparse.ArgumentParser(description="Create local BLS starter data")
        parser.add_argument("download-bls", nargs="?")
        parser.add_argument("--out", required=True, type=Path)
        parsed = parser.parse_args(args)
        print(json.dumps(download_bls(parsed.out), ensure_ascii=False, indent=2))
        return
    if args and args[0] == "eval":
        config = parse_config(args[1:])
        result = run_eval(config)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return
    config = parse_config(args)
    try:
        result = run_pipeline(config)
    except OllamaFailFastError as exc:
        # Exit code 3 == Ollama fail-fast abort (mirrors offers_categorizer.__main__).
        print(str(exc), file=sys.stderr, flush=True)
        sys.exit(3)
    print(json.dumps(result, ensure_ascii=False, indent=2))
