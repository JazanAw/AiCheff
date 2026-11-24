"""ProductAnalysisV2 — die EINE evidenzbasierte Wahrheit fuer Phase 2.

Pure, IO-frei, vollstaendig unit-testbar. Entscheidet vegan/vegetarisch/halal,
EU-14-Allergene und Naehrwerte aus der verfuegbaren Evidenz nach EINER festen
Quellenhierarchie. Die Legacy-Felder ``dietFlags`` / ``allergens`` werden
deterministisch aus diesem Modell abgeleitet (siehe ``legacy_*``) — es gibt
keine zweite, widerspruechliche Regelmenge mehr.

Designprinzipien (aus der Aufgabenstellung):
  * KEINE kalenderwochenabhaengige Logik.
  * KEINE Produkt- oder Marken-Allowlist. Die Lexika unten sind reines
    Zutaten-/Kategorie-Vokabular (Fleisch, Fisch, Alkohol, Allergene) — kein
    einziger Marken- oder Produktname. Konkrete Produktnamen leben nur in Tests.
  * ``unknown`` ist ein korrektes Ergebnis und besser als eine unbelegte Aussage.
  * Hoehere Evidenz darf nicht von schwaecherer ueberschrieben werden.
  * KI ist niemals ein Zertifikat; sie liefert nur Status+Confidence+Gruende.

Das Modul kennt KEINE IO und importiert NICHT aus ``core`` (sonst Zyklus). Es
bringt eigene reine Helfer (``_norm`` / ``_num``) mit, die sich identisch zu
``core.normalize_text`` / ``core.to_number`` verhalten.
"""

from __future__ import annotations

import hashlib
import math
import re
from dataclasses import dataclass, field
from typing import Any

# Bump bei jeder regelrelevanten Aenderung -> entwertet alte Analysen (Cache).
# pa-v7 (Halal-Relevanz-Gate): NEUES, generisches Gate ``classify_halal_relevance``
# VOR der tiefen (KI-)Halal-Pruefung. Es entscheidet deterministisch + billig, OB
# ein Produkt ueberhaupt relevant ist (klar pflanzliche Grundprodukte und
# eindeutiges Schwein/Alkohol brauchen keine KI), und liefert das neue Feld
# ``halalRelevance`` mit Relevanzklasse + ``deepAnalysisRecommended`` + erklaerbaren
# ``risk:``-Gruenden. Reine ZUSATZmetadaten: der bestehende ``halal``-Claim sowie
# vegan/vegetarisch/Allergene/Naehrwerte/Review-Logik bleiben unveraendert. KEINE
# KW-Logik, KEINE Marken-/Produkt-Allowlist (nur Zutaten-/Kategorie-Vokabular).
# Bump entwertet alte sf5-Analysen, damit das neue Feld materialisiert.
# pa-v6 (Trust-Boundary haerter + Provenienz): (P1) das Konzept
# "trusted-by-convention" fuer NORMALE Offer-Felder ist vollstaendig entfernt —
# ``retailerEvidence``/``ocrEvidence``/``aiEvidence``/``manufacturerEvidence``
# (+``manufacturerEvidenceVerified``/``ocrVersion``/``aiModelVersion``) und frei
# angehaengte ``evidenceInputs`` am Offer sind UNTRUSTED und koennen keine
# privilegierte Quelle mehr erzeugen (sie werden mit maschinenlesbarem Grund
# abgelehnt). Privilegierte Evidenz kommt AUSSCHLIESSLICH ueber den getrennten
# ``TrustedEvidenceContext`` (von der Pipeline explizit uebergeben) bzw. den
# aequivalenten internen ``evidence_inputs=``-Parameter. (P2) Die normalisierte,
# akzeptierte Evidenz erhaelt jetzt die volle Provenienz (producer/producerVersion/
# extractorVersion/modelVersion/connector/originalField) -> verschiedene
# Produzenten-/Extraktorversionen ergeben verschiedene Fingerprints. Praefix
# sf4 -> sf5 (entwertet alte sf1..sf4-Analysen sicher).
# pa-v5 (Trust-Boundary): frei an ein Offer angehaengte ``evidenceInputs`` waren
# UNTRUSTED; vertrauenswuerdige Evidenz kam ueber TrustedEvidenceContext ODER die
# (nun entfernten) rueckwaertskompatiblen typisierten Offer-Felder.
# pa-v4 (P1-P4, 2. Nachzug): unveraenderliche Safety-Invariants, zentraler
# Evidenz-Adapter, strikte Schema-Validierung, vollstaendiger Fingerprint.
RULES_VERSION = "pa-v7"

# Version des Evidenz-Eingabeschemas (P3/P4). Geht in den Fingerprint ein, damit
# sich aenderndes Evidenz-Schema den Cache entwertet.
EVIDENCE_SCHEMA_VERSION = "ev-v1"

# ---------------------------------------------------------------------------
# Quellenhierarchie (P2). Niedrigerer Rang = staerkere Evidenz.
# ---------------------------------------------------------------------------
SOURCE_MANUFACTURER = "manufacturer_label"
SOURCE_RETAILER = "retailer_structured"
SOURCE_BARCODE_DB = "barcode_database"
SOURCE_OCR = "ocr_extracted"
SOURCE_NAME_RULE = "name_category_rule"
SOURCE_AI = "ai"
SOURCE_UNKNOWN = "unknown"

SOURCE_RANK = {
    SOURCE_MANUFACTURER: 1,
    SOURCE_RETAILER: 2,
    SOURCE_BARCODE_DB: 3,
    SOURCE_OCR: 4,
    SOURCE_NAME_RULE: 5,
    SOURCE_AI: 6,
    SOURCE_UNKNOWN: 7,
}

# Privilegierte Quellen duerfen NUR von einem vertrauenswuerdigen, internen
# Produzenten erzeugt werden (verifizierter Hersteller-, Connector-, OCR-Adapter-
# oder KI-Adapter-Pfad). Frei an ein Offer angehaengte (untrusted)
# ``evidenceInputs`` koennen diese Quellen NICHT selbst behaupten — sonst liesse
# sich die Vertrauensgrenze umgehen. ``name_category_rule`` ist die interne
# Regelschicht und steht hier bewusst nicht; ``barcode_database`` (OFF) wird
# direkt in Python verarbeitet und laeuft nie ueber externe Evidenz.
PRIVILEGED_SOURCES = frozenset(
    {SOURCE_MANUFACTURER, SOURCE_RETAILER, SOURCE_BARCODE_DB, SOURCE_OCR, SOURCE_AI}
)


def source_rank(source: str) -> int:
    return SOURCE_RANK.get(source, SOURCE_RANK[SOURCE_UNKNOWN])


# ---------------------------------------------------------------------------
# Reine Helfer (Spiegel von core.normalize_text / core.to_number, ohne Import)
# ---------------------------------------------------------------------------
_UMLAUTS = {
    "ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss",
    "Ã¤": "ae", "Ã¶": "oe", "Ã¼": "ue", "ÃŸ": "ss",
}


def _norm(value: Any) -> str:
    if value is None:
        return ""
    text = str(value).strip().lower()
    for src, dst in _UMLAUTS.items():
        text = text.replace(src, dst)
    text = re.sub(r"[^a-z0-9%]+", " ", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def _num(value: Any) -> float | None:
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


def _contains_any(haystack: str, needles: tuple[str, ...]) -> str | None:
    """Erstes Vokabel, das als Teilstring (deutsche Komposita) im Text vorkommt."""
    for needle in needles:
        if needle and needle in haystack:
            return needle
    return None


# ---------------------------------------------------------------------------
# Zutaten-/Kategorie-Lexika. KEINE Marken, KEINE Produktnamen.
# ---------------------------------------------------------------------------
# Eindeutig pflanzlicher Vegan-Claim (starke Evidenz, P3).
VEGAN_CLAIM_TOKENS = ("vegan",)

# Saeugetier-/Gefluegelfleisch -> vegetarisch=no, vegan=no. "schinken"/"speck"
# sind FLEISCH (vegetarisch=no), aber NICHT per se Schwein (Pute-/Rinderschinken).
MEAT_WORDS = (
    "fleisch", "wurst", "hack", "gulasch", "steak", "schnitzel", "filet",
    "braten", "kotelett", "frikadelle", "bratwurst", "salami", "mett",
    "cabanossi", "leberkaese", "mortadella", "chorizo", "beef", "rind",
    "kalb", "lamm", "hammel", "wild", "hirsch", "reh", "kaninchen",
    "ente", "gans", "pute", "puten", "truthahn", "huhn", "huehner",
    "haehnchen", "gefluegel", "haehn", "schinken", "speck",
)

# Fisch / Meeresfruechte -> vegetarisch=no, vegan=no (Fisch ist NICHT vegetarisch).
FISH_WORDS = (
    "fisch", "lachs", "thunfisch", "forelle", "hering", "makrele", "kabeljau",
    "dorsch", "scholle", "garnele", "shrimp", "krabbe", "hummer", "muschel",
    "tintenfisch", "calamari", "sardine", "sardelle", "anchovi", "surimi",
    "seelachs", "pangasius", "zander", "wels", "krebs", "languste", "matjes",
    "raeucherlachs", "sushi",
)

# Tierisch, aber nicht Fleisch/Fisch -> vegan=no, vegetarisch BLEIBT moeglich yes.
# Milchprodukte (Milch/Kaese/...) als Komposita-Substring; Ei wird NICHT hier,
# sondern token-/wortgrenzenbasiert ueber _has_egg erkannt ("glutenfrEI"!).
DAIRY_WORDS = (
    "milch", "milk", "kaese", "butter", "sahne", "joghurt", "quark", "rahm",
    "molke", "buttermilch", "schmand", "mascarpone", "mozzarella", "gouda",
    "lactose", "casein",
)
HONEY_WORDS = ("honig", "honey")
# Pflanzendrinks enthalten den Substring "milch"/"milk", sind aber KEINE
# Tierprodukte. Steht ein solcher Qualifier dabei, ist "milch" kein Milch-Signal.
PLANT_MILK_QUALIFIERS = (
    "hafer", "mandel", "soja", "kokos", "reis", "dinkel", "cashew", "erbsen",
    "lupinen", "haselnuss", "pflanzen", "oat", "almond", "coconut",
)

# Ei nur als ganzes Wort ("ei"/"eier") ODER als eindeutiges Kompositum-Teil
# ("eigelb", "ruehrei", ...). NICHT das mehrdeutige "eiweiss" (Weizen-/
# Sojaeiweiss = Protein, kein Ei) und NIE der Substring "ei" in "glutenfrei",
# "frei", "drei", "reis", "fleisch".
_EGG_WORD_RE = re.compile(r"(?<![a-z])eier?(?![a-z])")
_EGG_COMPOUND_RE = re.compile(
    r"eigelb|eipulver|trockenei|vollei|huehnerei|eierlikoer|eiernudel|spiegelei|ruehrei"
)


def _has_egg(text: str) -> bool:
    if not text:
        return False
    return bool(_EGG_WORD_RE.search(text) or _EGG_COMPOUND_RE.search(text))


# Schwein (P4 Schritt 1). NUR ein echtes Schweinesignal loest direkt not_halal
# aus. "Schinken"/"Speck" allein beweisen KEIN Schwein (Puten-/Rinderschinken)
# und stehen daher als reines Fleischsignal in MEAT_WORDS, nicht hier.
PORK_DEFINITE = ("schwein", "pork", "bacon", "prosciutto", "pancetta", "lardo", "serrano")

# Alkoholisches Getraenk / relevanter Alkohol (P4 Schritt 2). KEIN bloss "vol"
# (das steckt in "Vollmilch"); Alkoholprozente werden separat per Regex erkannt.
ALCOHOL_BEVERAGE = (
    "bier", "wein", "sekt", "prosecco", "champagner", "wodka", "vodka",
    "whisky", "whiskey", "rum", "gin", "likoer", "schnaps", "tequila",
    "brandy", "weinbrand", "aperol", "campari", "cognac", "spirituose",
    "gluehwein",
)
# Alkoholfrei-Marker. Ein alkoholfreies Getraenk darf NICHT allein wegen seiner
# Getraenkeklasse ("Bier"/"Wein") als alkoholisch/nicht-halal gelten (Fall 1).
_ALCOHOL_FREE_RE = re.compile(r"\balkoholfrei|\balcohol free\b|\bohne alkohol\b|\bnon alcoholic\b")
# Gesetzlicher Grenzwert (P1): Getraenke bis einschliesslich 0,5 % vol gelten in
# der EU als "alkoholfrei". Ein deklarierter Wert <= Grenzwert macht ein Getraenk
# allein durch seine Getraenkeklasse NICHT not_halal; ein echter Wert oberhalb
# bleibt not_halal.
ALCOHOL_LIMIT_VOL = 0.5
# Deklarierter Alkoholgehalt vor "% vol"/"% ABV". WICHTIG (P1): NICHT auf dem
# normalisierten Text lesen — _norm() ersetzt das Dezimalkomma durch ein
# Leerzeichen ("0,5% vol" -> "0 5% vol"), wodurch die alte Regex faelschlich die
# letzte Ziffer ("5") las. Stattdessen wird der ROHTEXT geparst und Komma wie
# Punkt als Dezimaltrenner akzeptiert ("0,0", "0,5", "0.5", "4,9", "38").
_ALCOHOL_VOL_VALUE_RE = re.compile(r"(\d+(?:[.,]\d+)?)\s*%\s*(?:vol|abv)\b")
# Schwacher Alkoholbezug -> doubtful + Review, NICHT pauschal not_halal.
ALCOHOL_TRACE = ("rumaroma", "weinbergpfirsich aroma")

# Gelatine / tierisches Lab (P3/P4/P8).
GELATIN_WORDS = ("gelatine", "gelatin")
RENNET_WORDS = ("tierisches lab", "animal rennet", "labferment")
PORK_QUALIFIERS = ("schwein", "porcine", "pork")
BEEF_QUALIFIERS = ("rind", "bovine", "beef")
FISH_GELATIN_QUALIFIERS = ("fisch", "fish")

# ---------------------------------------------------------------------------
# Halal-Relevanz-Gate (Phase 2). Generisches, regelbasiertes, IO-freies Vokabular
# fuer die Frage "muss dieses Produkt ueberhaupt tief (per KI) auf Halal geprueft
# werden?". KEINE Marken-/Produkt-Allowlist — wie ueberall in diesem Modul nur
# Zutaten-/Kategorie-Begriffe. Konkrete Produktnamen leben nur in Tests.
# ---------------------------------------------------------------------------
# Relevanzklassen.
HALAL_NOT_RELEVANT = "not_relevant"
HALAL_PRESUMED_OK = "presumed_ok"
HALAL_HARAM = "haram"
HALAL_NEEDS_REVIEW = "needs_halal_review"
HALAL_POSSIBLE_UNVERIFIED = "halal_possible_but_unverified"
HALAL_REL_UNKNOWN = "unknown"

# Nur DIESE Klassen rechtfertigen die teure/tiefe (KI-)Halal-Pruefung. Klar
# pflanzliche Grundprodukte, eindeutiges Schwein/Alkohol und Zertifikate werden
# deterministisch entschieden und NIE an die KI gegeben.
HALAL_DEEP_CLASSES = frozenset({HALAL_NEEDS_REVIEW, HALAL_POSSIBLE_UNVERIFIED, HALAL_REL_UNKNOWN})

# Generische pflanzliche Grundprodukte (Obst/Gemuese/Getreide/Reis/Nudeln/Mehl/
# Zucker/Salz/Oel/Gewuerze/Wasser/Saft). KATEGORIE-/ZUTATEN-Vokabular, KEINE
# Marken/Produktnamen. Greift nur, wenn KEIN kritisches Signal (Fleisch/Fisch/
# Gelatine/Alkohol/Lab/ambivalenter Zusatzstoff) vorher zugeschlagen hat.
PLANT_BASIC_WORDS = (
    # Obst
    "apfel", "aepfel", "banane", "birne", "orange", "zitrone", "limette",
    "traube", "weintraube", "erdbeere", "himbeere", "heidelbeere", "blaubeere",
    "kirsche", "pfirsich", "nektarine", "pflaume", "aprikose", "melone",
    "wassermelone", "ananas", "mango", "kiwi", "avocado", "beere", "obst",
    # Gemuese
    "tomate", "gurke", "paprika", "zwiebel", "knoblauch", "karotte", "moehre",
    "kartoffel", "brokkoli", "blumenkohl", "spinat", "salat", "zucchini",
    "aubergine", "kuerbis", "lauch", "rettich", "radieschen", "kohl", "spargel",
    "champignon", "gemuese",
    # Getreide / Beilage
    "reis", "basmatireis", "nudel", "pasta", "spaghetti", "penne", "makkaroni",
    "mehl", "griess", "haferflocken", "bulgur", "quinoa", "polenta", "hirse",
    # Huelsenfruechte
    "linsen", "kichererbsen", "kidneybohnen", "erbsen",
    # Grundzutaten / Gewuerze
    "zucker", "salz", "pfeffer", "gewuerz", "zimt", "vanille", "oregano",
    "basilikum", "petersilie", "kraeuter", "oel", "olivenoel", "sonnenblumenoel",
    "rapsoel", "essig", "balsamico",
    # Getraenke (Alkohol wird VORHER hart ausgeschlossen).
    "wasser", "mineralwasser", "saft", "apfelsaft", "orangensaft", "tee",
)

# Wort-ENDE-Match (deutsche Komposita + optionaler Plural -n/-s). Vermeidet
# Substring-Fehltreffer (z. B. "oel" in "voellig").
_PLANT_BASIC_RE = re.compile(
    r"(?:" + "|".join(re.escape(w) for w in PLANT_BASIC_WORDS) + r")[ns]?(?= |$)"
)

# Suesswaren/Desserts mit RELEVANTEM Gelatine-Risiko (moeglich, NICHT bewiesen) —
# NUR fuers Gate; beruehrt die gelatin()-Evidenz (vegan/vegetarisch) NICHT. Bewusst
# eng auf typische Gelatinetraeger begrenzt (kein pauschales "Dessert"/"Joghurt").
GELATIN_RISK_WORDS = (
    "marshmallow", "mousse", "panna cotta", "pannacotta", "goetterspeise",
    "wackelpudding", "schaumkuss", "schokokuss", "schaumzucker", "aspik",
    "suelze", "geleefrucht",
)

# Kaese/Produkte mit moeglichem (tierischem) Lab/Enzym. "tierisches lab" ist bereits
# bewiesene Evidenz (has_animal_rennet); hier nur das generische RISIKO fuer Review.
CHEESE_WORDS = ("kaese", "cheese", "parmesan", "pecorino", "bergkaese", "hartkaese")

# Ambivalente Zusatzstoffe (tierische/alkoholische Herkunft moeglich). BEWUSST ENG
# auf eindeutig mehrdeutige E-Nummern/Namen begrenzt — generisches "Aroma"/"Extrakt"
# wird NICHT pauschal eskaliert (sonst Masseneskalation, das Gate verloere seinen
# Sinn und die presumed_ok-Abdeckung braeche ein).
ADDITIVE_RISK_WORDS = (
    "karmin", "carmine", "cochenille", "e120",
    "schellack", "shellac", "e904",
    "l cystein", "l cysteine", "e920",
    "e441", "e542", "speisegelatine",
)

# EU-14 Allergengruppen (deklarationspflichtig). Schluessel = pipeline-Codes.
EU14_KEYS = (
    "gluten_cereals", "crustaceans", "eggs", "fish", "peanuts", "soybeans",
    "milk", "nuts", "celery", "mustard", "sesame", "sulphites", "lupin",
    "molluscs",
)

# OFF-Tag-TOKEN -> EU-14-Code. Taxonomisch und TOKEN-EXAKT (Fall 4): der Tag
# "en:coconut" wird in Tokens ["en","coconut"] zerlegt; "coconut" steht in KEINER
# Aliasliste, also keine faelschliche Nuss-Klassifikation per Substring "nut".
# Kokosnuss ist KEINE EU-Schalenfrucht (Anhang II) und kein Milchallergen.
# Peanuts!=nuts, crustaceans!=molluscs.
ALLERGEN_TOKEN_MAP = {
    # gluten / Getreide
    "gluten": "gluten_cereals", "cereals": "gluten_cereals", "cereal": "gluten_cereals",
    "wheat": "gluten_cereals", "weizen": "gluten_cereals", "barley": "gluten_cereals",
    "gerste": "gluten_cereals", "rye": "gluten_cereals", "roggen": "gluten_cereals",
    "oat": "gluten_cereals", "oats": "gluten_cereals", "hafer": "gluten_cereals",
    "dinkel": "gluten_cereals", "spelt": "gluten_cereals", "kamut": "gluten_cereals",
    # Krebstiere
    "crustacean": "crustaceans", "crustaceans": "crustaceans", "krebstier": "crustaceans",
    "krebstiere": "crustaceans", "shrimp": "crustaceans", "shrimps": "crustaceans",
    "garnele": "crustaceans", "garnelen": "crustaceans", "krabbe": "crustaceans",
    "krabben": "crustaceans", "hummer": "crustaceans", "prawns": "crustaceans",
    # Ei
    "egg": "eggs", "eggs": "eggs", "ei": "eggs", "eier": "eggs",
    # Fisch
    "fish": "fish", "fisch": "fish",
    # Erdnuss (NICHT Schalenfrucht)
    "peanut": "peanuts", "peanuts": "peanuts", "erdnuss": "peanuts",
    "erdnuesse": "peanuts", "arachis": "peanuts",
    # Soja
    "soy": "soybeans", "soya": "soybeans", "soybean": "soybeans",
    "soybeans": "soybeans", "soja": "soybeans",
    # Milch (Laktose ist Milchallergen-Tag in OFF)
    "milk": "milk", "milch": "milk", "lactose": "milk", "laktose": "milk", "dairy": "milk",
    # Schalenfruechte (EU Anhang II) — KEIN coconut/peanut
    "nut": "nuts", "nuts": "nuts", "tree": "nuts", "nuesse": "nuts", "mandel": "nuts",
    "almond": "nuts", "almonds": "nuts", "hazelnut": "nuts", "hazelnuts": "nuts",
    "haselnuss": "nuts", "walnut": "nuts", "walnuts": "nuts", "walnuss": "nuts",
    "cashew": "nuts", "cashews": "nuts", "pistachio": "nuts", "pistachios": "nuts",
    "pistazie": "nuts", "pecan": "nuts", "pecans": "nuts", "macadamia": "nuts",
    "brazil": "nuts", "walnuesse": "nuts", "haselnuesse": "nuts",
    # Sellerie / Senf / Sesam
    "celery": "celery", "sellerie": "celery",
    "mustard": "mustard", "senf": "mustard",
    "sesame": "sesame", "sesam": "sesame", "sesamum": "sesame",
    # Sulfite
    "sulphite": "sulphites", "sulphites": "sulphites", "sulfite": "sulphites",
    "sulfites": "sulphites", "sulphur": "sulphites", "sulfur": "sulphites",
    "schwefel": "sulphites", "schwefeldioxid": "sulphites",
    # Lupine
    "lupin": "lupin", "lupine": "lupin", "lupinen": "lupin", "lupins": "lupin",
    # Weichtiere
    "mollusc": "molluscs", "molluscs": "molluscs", "mollusk": "molluscs",
    "mollusks": "molluscs", "weichtier": "molluscs", "weichtiere": "molluscs",
    "tintenfisch": "molluscs", "muschel": "molluscs", "muscheln": "molluscs",
}

# Naehrwert-Qualitaetsstufen (P6).
QUALITY_MANUFACTURER = "manufacturer_label"
QUALITY_RETAILER = "retailer_structured"
QUALITY_BARCODE = "barcode_database"
QUALITY_OCR = "ocr_extracted"
QUALITY_ESTIMATED = "estimated"
QUALITY_UNKNOWN = "unknown"

# Legacy nutrition.source -> V2-Qualitaetsstufe + Evidenzquelle.
_NUTRITION_SOURCE_TO_QUALITY = {
    "openfoodfacts": (QUALITY_BARCODE, SOURCE_BARCODE_DB),
    "off": (QUALITY_BARCODE, SOURCE_BARCODE_DB),
    "bls": (QUALITY_ESTIMATED, SOURCE_NAME_RULE),
    "estimated": (QUALITY_ESTIMATED, SOURCE_NAME_RULE),
    "ocr": (QUALITY_OCR, SOURCE_OCR),
    "none": (QUALITY_UNKNOWN, SOURCE_UNKNOWN),
}


# ---------------------------------------------------------------------------
# Evidenz aus Angebot + OFF-Produkt
# ---------------------------------------------------------------------------
class Evidence:
    """Aufbereitete, normalisierte Evidenz fuer EIN Produkt. Reiner Container."""

    def __init__(self, offer: dict[str, Any], off_product: dict[str, Any] | None) -> None:
        title = offer.get("title") or offer.get("name") or ""
        category = (offer.get("canonicalCategory") or {}) if isinstance(offer.get("canonicalCategory"), dict) else {}
        self.category_main = str(category.get("main", "") or "")
        name_fields = [
            str(title), str(offer.get("brand") or ""),
            str(offer.get("category") or ""), str(offer.get("sourceCategory") or ""),
        ]
        self.name_text = _norm(" ".join(name_fields))
        self.has_off = isinstance(off_product, dict)
        off = off_product if isinstance(off_product, dict) else {}
        self.ingredients = _norm(off.get("ingredients_text") or "")
        self.analysis_tags = [_norm(t) for t in off.get("ingredients_analysis_tags", []) if isinstance(off.get("ingredients_analysis_tags"), list)]
        self.labels = [_norm(t) for t in off.get("labels_tags", []) if isinstance(off.get("labels_tags"), list)]
        self.labels_text = " ".join(self.labels)
        self.allergen_tags = [str(t) for t in off.get("allergens_tags", []) if isinstance(off.get("allergens_tags"), list)]
        self.trace_tags = [str(t) for t in off.get("traces_tags", []) if isinstance(off.get("traces_tags"), list)]
        # Ingredients sind die belastbarste Textquelle; Name nur als Fallback.
        self.evidence_text = (self.ingredients + " " + self.name_text).strip()
        # ROHTEXT (nur klein, ohne Komma->Space-Normalisierung) fuer das
        # Zahlen-/Prozent-Parsing (P1): "0,5% vol" muss als 0.5 lesbar bleiben.
        self.raw_text = " ".join(name_fields + [str(off.get("ingredients_text") or "")]).lower()
        # Alkoholfrei-Marker (Name oder Zutaten) — Getraenkeklasse allein zaehlt
        # dann NICHT als Alkohol (Fall 1).
        self.alcohol_free = bool(_ALCOHOL_FREE_RE.search(self.evidence_text))

    # -- Vegan-Claim -------------------------------------------------------
    def vegan_claim(self) -> tuple[bool, str, float, list[str]]:
        """(claim?, source, confidence, reasons). Belastbarer Vegan-Claim (P3)."""
        if any("non vegan" in t or "non-vegan" in t for t in self.analysis_tags):
            return False, SOURCE_BARCODE_DB, 0.0, []
        if any(t == "en vegan" or t.endswith(" vegan") or t == "vegan" for t in self.analysis_tags):
            return True, SOURCE_BARCODE_DB, 0.9, ["off:analysis_vegan"]
        if "vegan" in self.labels_text and "non vegan" not in self.labels_text:
            return True, SOURCE_BARCODE_DB, 0.82, ["off:label_vegan"]
        # Standalone-Token im Namen (nicht "veganer Geschmack"-Substring-Zufall).
        if "vegan" in self.name_text.split():
            return True, SOURCE_NAME_RULE, 0.6, ["rule:name_vegan"]
        return False, SOURCE_UNKNOWN, 0.0, []

    def gelatin(self) -> dict[str, Any]:
        """Gelatine-Evidenz (present/source/confidence/reasons) — auch fuer Legacy."""
        text = self.evidence_text
        if _contains_any(text, GELATIN_WORDS) is None:
            # Fruchtgummi ohne Zutatenliste: moegliche, unbelegte Gelatine.
            if not self.ingredients and _contains_any(self.name_text, ("fruchtgummi", "gummibaer", "weingummi")) and not self.vegan_claim()[0]:
                return {"present": True, "source": "unknown", "confidence": 0.55, "reasons": ["rule:gummy_maybe_gelatin"]}
            if self.vegan_claim()[0]:
                return {"present": False, "source": "none", "confidence": 0.8, "reasons": ["rule:vegan_no_gelatin"]}
            return {"present": None, "source": None, "confidence": 0.0, "reasons": []}
        if _contains_any(text, PORK_QUALIFIERS) is not None or "schweinegelatine" in text:
            return {"present": True, "source": "pork", "confidence": 0.93, "reasons": ["evidence:gelatin_pork"]}
        if _contains_any(text, BEEF_QUALIFIERS) is not None or "rindergelatine" in text:
            return {"present": True, "source": "beef", "confidence": 0.9, "reasons": ["evidence:gelatin_beef"]}
        if _contains_any(text, FISH_GELATIN_QUALIFIERS) is not None:
            return {"present": True, "source": "fish", "confidence": 0.88, "reasons": ["evidence:gelatin_fish"]}
        return {"present": True, "source": "unknown", "confidence": 0.7, "reasons": ["evidence:gelatin_unknown_source"]}

    def has_animal_rennet(self) -> bool:
        return _contains_any(self.evidence_text, RENNET_WORDS) is not None

    def pork_from_name_or_ingredients(self) -> str | None:
        # NUR ein echtes Schweinesignal (PORK_DEFINITE). "Schinken"/"Speck"
        # beweisen kein Schwein und sind reines Fleischsignal (MEAT_WORDS).
        return _contains_any(self.evidence_text, PORK_DEFINITE)

    def _max_vol_percent(self) -> float | None:
        best: float | None = None
        for m in _ALCOHOL_VOL_VALUE_RE.finditer(self.raw_text):
            val = float(m.group(1).replace(",", "."))
            if best is None or val > best:
                best = val
        return best

    def alcohol(self) -> str | None:
        vol = self._max_vol_percent()
        if vol is not None:
            # Ein DEKLARIERTER Wert ist die staerkste Alkohol-Evidenz und
            # ueberstimmt jede Getraenkeklasse/jeden "alkoholfrei"-Marker.
            if vol > ALCOHOL_LIMIT_VOL:
                return f"vol:{vol:g}"
            # Wert <= Grenzwert (0,0 / 0,3 / 0,5 % vol, 0.5 % ABV): gesetzlich
            # alkoholfrei -> Getraenkeklasse macht es NICHT not_halal (P1).
            return None
        # Kein deklarierter Wert: "alkoholfrei"-Marker entschaerft die Klasse.
        if self.alcohol_free:
            return None
        if self.category_main == "Alkohol":
            return "category:alkohol"
        hit = _contains_any(self.evidence_text, ALCOHOL_BEVERAGE)
        if hit:
            return hit
        return None

    def alcohol_conflict(self) -> bool:
        """Widerspruch (P1): "alkoholfrei"-Marker UND deklarierter Alkoholwert
        oberhalb des Grenzwerts. Der echte Wert ueberstimmt (not_halal), aber der
        Konflikt darf nicht still verschwinden -> loest Review aus."""
        vol = self._max_vol_percent()
        return bool(self.alcohol_free and vol is not None and vol > ALCOHOL_LIMIT_VOL)

    def alcohol_trace(self) -> str | None:
        if self.alcohol_free:
            return None
        return _contains_any(self.evidence_text, ALCOHOL_TRACE)

    def meat_or_poultry(self) -> str | None:
        return _contains_any(self.evidence_text, MEAT_WORDS)

    def fish_or_seafood(self) -> str | None:
        return _contains_any(self.evidence_text, FISH_WORDS)

    def dairy_egg_honey(self) -> str | None:
        text = " " + self.evidence_text + " "
        hit = _contains_any(text, DAIRY_WORDS)
        if hit in {"milch", "milk"} and _contains_any(text, PLANT_MILK_QUALIFIERS) is not None:
            # "Hafermilch"/"Mandelmilch" etc. -> kein Tierprodukt-Signal.
            hit = None
        if hit:
            return hit
        if _has_egg(self.evidence_text):
            return "ei"
        return _contains_any(text, HONEY_WORDS)

    def animal_in_ingredients(self) -> tuple[str, str] | None:
        """Belastbare tierische Evidenz aus ZUTATEN/OFF-Allergen-Tags (NICHT aus
        dem Produktnamen). Stark genug, einen Vegan-Claim zu widerlegen (Fall 5):
        ein Marketing-Claim darf nicht ueber widerspruechliche Zutaten gestellt
        werden. Liefert (kategorie, token) oder None."""
        ing = self.ingredients
        if ing:
            m = _contains_any(ing, MEAT_WORDS)
            if m:
                return ("meat", m)
            f = _contains_any(ing, FISH_WORDS)
            if f:
                return ("fish", f)
            padded = " " + ing + " "
            d = _contains_any(padded, DAIRY_WORDS)
            if d in {"milch", "milk"} and _contains_any(padded, PLANT_MILK_QUALIFIERS) is not None:
                d = None
            if d:
                return ("dairy", d)
            if _has_egg(ing):
                return ("dairy", "ei")
            h = _contains_any(padded, HONEY_WORDS)
            if h:
                return ("dairy", h)
        for tag in self.allergen_tags:
            code = _map_allergen_token(tag)
            if code in {"milk", "eggs"}:
                return ("dairy", code)
            if code == "fish":
                return ("fish", code)
            if code in {"crustaceans", "molluscs"}:
                return ("seafood", code)
        return None

    def halal_claim(self) -> bool:
        lt = self.labels_text
        if ("halal" in lt) and ("non halal" not in lt and "not halal" not in lt and "non-halal" not in lt and "not-halal" not in lt):
            return True
        return False

    def non_halal_label(self) -> bool:
        lt = self.labels_text
        return "non halal" in lt or "not halal" in lt or "non-halal" in lt or "not-halal" in lt


def _claim(status: str, source: str, confidence: float, reasons: list[str]) -> dict[str, Any]:
    return {"status": status, "source": source, "confidence": round(float(confidence), 4), "reasons": list(reasons)}


# ---------------------------------------------------------------------------
# P3 — vegan / vegetarisch (unabhaengig voneinander)
# ---------------------------------------------------------------------------
def decide_vegetarian(ev: Evidence, review: list[str]) -> dict[str, Any]:
    claim, csrc, cconf, creasons = ev.vegan_claim()
    if claim:
        # Veganer Claim impliziert vegetarisch; Fleischwoerter im Ersatzprodukt-
        # NAMEN duerfen das NICHT kippen (P3: veganes Ersatzprodukt). Eine echte
        # Fleisch-/Fischzutat (Fall 5) widerlegt aber auch vegetarisch.
        conflict = ev.animal_in_ingredients()
        if conflict and conflict[0] in {"meat", "fish", "seafood"}:
            review.append(f"vegan:conflict_{conflict[0]}_ingredient:{conflict[1]}")
            return _claim("no", SOURCE_BARCODE_DB, 0.8, creasons + [f"conflict:vegan_claim_vs_{conflict[0]}:{conflict[1]}"])
        return _claim("yes", csrc, cconf, creasons + ["implied_by_vegan"])
    if any("non vegetarian" in t or "non-vegetarian" in t for t in ev.analysis_tags):
        return _claim("no", SOURCE_BARCODE_DB, 0.9, ["off:analysis_non_vegetarian"])
    meat = ev.meat_or_poultry()
    if meat:
        return _claim("no", SOURCE_NAME_RULE, 0.8, [f"evidence:meat:{meat}"])
    fish = ev.fish_or_seafood()
    if fish:
        return _claim("no", SOURCE_NAME_RULE, 0.8, [f"evidence:fish:{fish}"])
    gel = ev.gelatin()
    if gel["present"] is True:
        if gel["source"] == "unknown":
            # Unklare Herkunft -> Review statt harter Aussage (P3).
            review.append("gelatin:unknown_origin")
            return _claim("unknown", SOURCE_NAME_RULE, 0.4, ["evidence:gelatin_unknown_origin"])
        # Bekannte tierische Herkunft (Schwein/Rind/Fisch) -> nicht vegetarisch.
        return _claim("no", SOURCE_NAME_RULE, 0.7, [f"evidence:gelatin_{gel['source']}"])
    if ev.has_animal_rennet():
        review.append("rennet:unknown_origin")
        return _claim("unknown", SOURCE_NAME_RULE, 0.4, ["evidence:animal_rennet"])
    if any(t.endswith(" vegetarian") or t == "en vegetarian" for t in ev.analysis_tags):
        return _claim("yes", SOURCE_BARCODE_DB, 0.85, ["off:analysis_vegetarian"])
    if "vegetar" in ev.labels_text and "non vegetarian" not in ev.labels_text:
        return _claim("yes", SOURCE_BARCODE_DB, 0.8, ["off:label_vegetarian"])
    if "vegetar" in ev.name_text:
        return _claim("yes", SOURCE_NAME_RULE, 0.6, ["rule:name_vegetarian"])
    # Milch/Ei/Honig allein -> vegetarisch moeglich yes (vegan bleibt no).
    dairy = ev.dairy_egg_honey()
    if dairy:
        src = SOURCE_BARCODE_DB if ev.has_off else SOURCE_NAME_RULE
        return _claim("yes", src, 0.6, [f"evidence:dairy_egg_only:{dairy.strip()}"])
    # Fehlender Tierbegriff bedeutet NICHT automatisch vegetarisch.
    return _claim("unknown", SOURCE_UNKNOWN, 0.0, ["insufficient_data"])


def decide_vegan(ev: Evidence, review: list[str]) -> dict[str, Any]:
    if any("non vegan" in t or "non-vegan" in t for t in ev.analysis_tags):
        return _claim("no", SOURCE_BARCODE_DB, 0.9, ["off:analysis_non_vegan"])
    # Tierische Bestandteile -> vegan=no (auch bei Fleisch/Fisch).
    meat = ev.meat_or_poultry()
    fish = ev.fish_or_seafood()
    dairy = ev.dairy_egg_honey()
    gel = ev.gelatin()
    claim, csrc, cconf, creasons = ev.vegan_claim()
    if claim:
        # Belastbarer Vegan-Claim ist starke Evidenz (P3). Fleischwort im NAMEN
        # eines Ersatzprodukts widerspricht dem nicht — eine echte tierische
        # ZUTAT (Milch/Ei/Fleisch/...) aber schon (Fall 5): explizite tierische
        # Zutaten verhindern vegan=yes, der Konflikt wird dokumentiert + Review.
        conflict = ev.animal_in_ingredients()
        if conflict:
            cat, tok = conflict
            review.append(f"vegan:conflict_animal_ingredient:{tok}")
            return _claim("no", SOURCE_BARCODE_DB, 0.8, creasons + [f"conflict:vegan_claim_vs_{cat}:{tok}"])
        return _claim("yes", csrc, cconf, creasons)
    if meat:
        return _claim("no", SOURCE_NAME_RULE, 0.8, [f"evidence:meat:{meat}"])
    if fish:
        return _claim("no", SOURCE_NAME_RULE, 0.8, [f"evidence:fish:{fish}"])
    if dairy:
        return _claim("no", SOURCE_NAME_RULE if not ev.has_off else SOURCE_BARCODE_DB, 0.75, [f"evidence:animal:{dairy.strip()}"])
    if gel["present"] is True:
        return _claim("no", SOURCE_NAME_RULE, 0.7, ["evidence:gelatin_animal"])
    if ev.has_animal_rennet():
        return _claim("no", SOURCE_NAME_RULE, 0.6, ["evidence:animal_rennet"])
    # Fehlender Tierbegriff bedeutet NICHT vegan (P3).
    return _claim("unknown", SOURCE_UNKNOWN, 0.0, ["insufficient_data"])


# ---------------------------------------------------------------------------
# P4 — halal (UNABHAENGIG von vegan/vegetarisch). Schwein & Alkohol ueberstimmen.
# ---------------------------------------------------------------------------
def decide_halal(ev: Evidence, review: list[str]) -> dict[str, Any]:
    vegan_claim = ev.vegan_claim()[0]

    # 1) Schwein. Aus Zutaten immer; aus dem Namen nur, wenn KEIN belastbarer
    #    Vegan-Claim vorliegt (sonst ist "Schnitzel" ein Ersatzprodukt-Name).
    pork_ingredient = _contains_any(ev.ingredients, PORK_DEFINITE) is not None or "schweinegelatine" in ev.evidence_text
    pork_name = ev.pork_from_name_or_ingredients() is not None
    gel = ev.gelatin()
    if pork_ingredient or gel["source"] == "pork":
        return _claim("not_halal", SOURCE_NAME_RULE if not ev.has_off else SOURCE_BARCODE_DB, 0.95, ["evidence:pork"])
    if pork_name and not vegan_claim:
        return _claim("not_halal", SOURCE_NAME_RULE, 0.9, ["evidence:pork_name"])

    # 2) Alkohol (gilt auch fuer vegane Getraenke!). Spuren/Aroma -> doubtful.
    alc = ev.alcohol()
    if alc:
        # Widerspruch "alkoholfrei" + echter Alkoholwert -> not_halal + Review.
        if ev.alcohol_conflict():
            review.append("alcohol:conflict_free_but_positive")
            return _claim("not_halal", SOURCE_NAME_RULE, 0.9, [f"evidence:alcohol:{alc}", "conflict:alcohol_free_vs_positive"])
        return _claim("not_halal", SOURCE_NAME_RULE, 0.93, [f"evidence:alcohol:{alc}"])
    trace = ev.alcohol_trace()
    if trace:
        review.append("alcohol:uncertain")
        return _claim("doubtful", SOURCE_NAME_RULE, 0.5, [f"evidence:alcohol_trace:{trace}"])

    # 3) Explizites non-halal-Label.
    if ev.non_halal_label():
        return _claim("not_halal", SOURCE_BARCODE_DB, 0.85, ["off:label_non_halal"])

    # 4) Belastbarer Halal-Claim/Zertifikat (kein Ausschlussgrund traf zu).
    if ev.halal_claim():
        return _claim("halal", SOURCE_BARCODE_DB, 0.85, ["off:label_halal"])

    # 5) Gelatine unbekannter Herkunft -> doubtful + Review (nicht raten).
    if gel["present"] is True and gel["source"] in {"unknown", "beef", "fish"}:
        review.append("gelatin:unknown_origin")
        return _claim("doubtful", SOURCE_NAME_RULE, max(0.5, float(gel["confidence"])), [f"evidence:gelatin_{gel['source']}"])

    # 6) Fleisch/Gefluegel ohne Halal-Nachweis -> doubtful (NIE allein positiv).
    #    Bei belastbarem Vegan-Claim ist ein Fleischwort nur ein Ersatzprodukt-
    #    Name und darf halal NICHT auf doubtful ziehen.
    if ev.meat_or_poultry() and not vegan_claim:
        review.append("meat:no_halal_proof")
        return _claim("doubtful", SOURCE_NAME_RULE, 0.5, ["evidence:meat_no_halal_proof"])

    # 7) Tierisches Lab unbekannter Herkunft.
    if ev.has_animal_rennet():
        review.append("rennet:unknown_origin")
        return _claim("unknown", SOURCE_NAME_RULE, 0.4, ["evidence:animal_rennet"])

    # 8) Pflanzlich/vegan ist NICHT automatisch halal (P4 Schritt 5).
    return _claim("unknown", SOURCE_UNKNOWN, 0.0, ["insufficient_data"])


# ---------------------------------------------------------------------------
# P4b — Halal-Relevanz-Gate (VOR der tiefen/KI-Halal-Pruefung)
# ---------------------------------------------------------------------------
# Generisch + deterministisch: NICHT jedes Produkt bekommt eine tiefe Halal-KI-
# Pruefung. Klar pflanzliche Grundprodukte und eindeutiges Schwein/Alkohol werden
# hier billig entschieden; nur echte Risikoklassen (Fleisch ohne Schwein,
# Gelatine, tierisches Lab, Alkohol-Spur, ambivalente Zusatzstoffe) werden zur
# tiefen Pruefung eskaliert (``deepAnalysisRecommended``). Das Gate ist eine
# ZUSATZschicht — es nutzt exakt dieselben Evidenz-Primitive wie ``decide_halal``
# und ist daher per Konstruktion widerspruchsfrei dazu (siehe Tests: haram <->
# not_halal). Es mutiert NICHT die Review-Liste und aendert KEINE bestehenden
# Felder (vegan/vegetarisch/Allergene/Naehrwerte/Review bleiben unangetastet).
def _has_gelatin_risk(ev: Evidence) -> bool:
    """Suesswaren/Desserts mit MOEGLICHEM (nicht bewiesenem) Gelatine-Anteil."""
    return _contains_any(ev.evidence_text, GELATIN_RISK_WORDS) is not None


def _has_rennet_risk(ev: Evidence) -> bool:
    """Kaese + Lab/Enzym-Begriff -> moegliches tierisches Lab (Review, kein Fakt).
    "lab"/"rennet" nur als ganzes Wort (kein Substring-Zufall in z. B. "Knoblauch")."""
    if _contains_any(ev.evidence_text, CHEESE_WORDS) is None:
        return False
    padded = " " + ev.evidence_text + " "
    if " lab " in padded or " rennet " in padded:
        return True
    return _contains_any(ev.evidence_text, ("labferment", "enzym")) is not None


def _has_additive_risk(ev: Evidence) -> bool:
    """Eindeutig herkunfts-ambivalente Zusatzstoffe (tierisch/alkoholisch moeglich)."""
    return _contains_any(ev.evidence_text, ADDITIVE_RISK_WORDS) is not None


def _is_plant_basic(ev: Evidence) -> bool:
    """Klar pflanzliches Grundprodukt (Obst/Gemuese/Getreide/Wasser/Gewuerz ...).

    WORT-ENDE-Grenze statt blanker Substring: deutsche Komposita tragen das
    Grundwort am Wortende ("Weizenmehl", "Apfelsaft", "Olivenoel"), optional mit
    Plural (-n/-s). So matcht "mehl" in "weizenmehl", aber "oel" NICHT mitten in
    "voellig" — kein Fehltreffer durch zufaellige Substrings."""
    if _PLANT_BASIC_RE.search(ev.evidence_text):
        return True
    cat = _norm(ev.category_main)
    return "obst" in cat or "gemuese" in cat


def _relevance(
    relevance: str, confidence: float, reasons: list[str], *, deep: bool
) -> dict[str, Any]:
    return {
        "relevance": relevance,
        "deepAnalysisRecommended": bool(deep),
        "confidence": round(float(confidence), 4),
        "reasons": list(reasons),
    }


def classify_halal_relevance(ev: Evidence) -> dict[str, Any]:
    """Generisches Halal-Relevanz-Gate. Liefert
    ``{relevance, deepAnalysisRecommended, confidence, reasons}``.

    Reihenfolge (staerkste/billigste Entscheidung zuerst):
      1. HARAM — Schwein / Alkohol / explizites non-halal-Label. Deterministisch,
         keine KI noetig (``deep=False``).
      2. presumed_ok — belastbares Halal-Zertifikat (Label). Keine KI noetig.
      3. RISIKOKLASSEN -> tiefe Pruefung (``deep=True``):
         Gelatine (bewiesen oder Suesswaren-Risiko), tierisches Lab (bewiesen oder
         Kaese+Lab/Enzym-Risiko), Alkohol-Spur/Aroma, ambivalente Zusatzstoffe,
         Fleisch/Gefluegel ohne Schwein & ohne Zertifikat
         (``halal_possible_but_unverified``).
      4. presumed_ok / not_relevant — Vegan-Claim bzw. klar pflanzliches
         Grundprodukt bzw. halal-neutrale Tierprodukte (Milch/Ei/Honig/Fisch).
         Keine KI noetig, ehrliche niedrige bis mittlere Confidence.
      5. unknown — echtes Fehlen jeder Klassifikationsevidenz (nur dann, NICHT fuer
         Obst/Gemuese/Gewuerze). ``deep=True``, da eine unerkannte Risikoklasse
         moeglich ist.

    KI ist NIE ein Zertifikat: presumed_ok/not_relevant heissen "kein kritisches
    Signal gefunden", nicht "garantiert halal"."""
    vegan_claim = ev.vegan_claim()[0]
    gel = ev.gelatin()

    # 1) HARAM — hart, deterministisch.
    pork_ingredient = (
        _contains_any(ev.ingredients, PORK_DEFINITE) is not None
        or "schweinegelatine" in ev.evidence_text
    )
    if pork_ingredient or gel["source"] == "pork":
        return _relevance(HALAL_HARAM, 0.95, ["risk:pork"], deep=False)
    if ev.pork_from_name_or_ingredients() is not None and not vegan_claim:
        return _relevance(HALAL_HARAM, 0.9, ["risk:pork"], deep=False)
    if ev.alcohol() is not None:
        # Spuren/Aroma sind KEIN Vollalkohol -> die behandelt Schritt 3 (Review);
        # ev.alcohol() liefert nur echten/relevanten Alkohol.
        return _relevance(HALAL_HARAM, 0.93, ["risk:alcohol"], deep=False)
    if ev.non_halal_label():
        return _relevance(HALAL_HARAM, 0.85, ["risk:label_non_halal"], deep=False)

    # 2) Belastbares Halal-Zertifikat (kein Ausschlussgrund traf zu).
    if ev.halal_claim():
        return _relevance(HALAL_PRESUMED_OK, 0.85, ["presumed_ok:halal_certified"], deep=False)

    # 3) Risikoklassen -> tiefe Pruefung.
    if gel["present"] is True:
        # Bewiesene Gelatine unbekannter/rind-/fischiger Herkunft.
        return _relevance(HALAL_NEEDS_REVIEW, max(0.5, float(gel["confidence"])), ["risk:gelatin"], deep=True)
    if not vegan_claim and _has_gelatin_risk(ev):
        return _relevance(HALAL_NEEDS_REVIEW, 0.45, ["risk:gelatin"], deep=True)
    if ev.has_animal_rennet():
        return _relevance(HALAL_NEEDS_REVIEW, 0.5, ["risk:rennet"], deep=True)
    if not vegan_claim and _has_rennet_risk(ev):
        return _relevance(HALAL_NEEDS_REVIEW, 0.45, ["risk:rennet"], deep=True)
    if ev.alcohol_trace() is not None:
        return _relevance(HALAL_NEEDS_REVIEW, 0.5, ["risk:alcohol"], deep=True)
    if not vegan_claim and _has_additive_risk(ev):
        return _relevance(HALAL_NEEDS_REVIEW, 0.45, ["risk:additive"], deep=True)
    if ev.meat_or_poultry() is not None and not vegan_claim:
        # Fleisch ohne Schwein & ohne Zertifikat: halal MOEGLICH, aber unbelegt.
        return _relevance(HALAL_POSSIBLE_UNVERIFIED, 0.5, ["risk:meat"], deep=True)

    # 4) Nicht relevant / presumed ok (billig, keine KI).
    if vegan_claim:
        return _relevance(HALAL_PRESUMED_OK, 0.6, ["presumed_ok:vegan_claim"], deep=False)
    if _is_plant_basic(ev):
        return _relevance(HALAL_NOT_RELEVANT, 0.55, ["not_relevant:plant_basic"], deep=False)
    if ev.dairy_egg_honey() is not None or ev.fish_or_seafood() is not None:
        # Milch/Ei/Honig/Fisch sind halal-neutral (kein Ausschluss, kein Zertifikat).
        return _relevance(HALAL_PRESUMED_OK, 0.5, ["presumed_ok:no_critical_signal"], deep=False)

    # 5) Echtes Fehlen jeder Evidenz -> unknown (moegliche unerkannte Risikoklasse).
    return _relevance(HALAL_REL_UNKNOWN, 0.0, ["unknown:insufficient_signal"], deep=True)


# ---------------------------------------------------------------------------
# P5 — EU-14-Allergene (pro Allergen eigener Status/Quelle/Confidence/Gruende)
# ---------------------------------------------------------------------------
def _map_allergen_token(token: str) -> str | None:
    """Taxonomisch + TOKEN-EXAKT. Der Tag wird in Tokens zerlegt; jedes Token
    muss EXAKT in der Aliasliste stehen. Kein Substring-Treffer -> "coconut"
    wird NICHT zu "nut" (Fall 4)."""
    for tok in _norm(token).split():
        code = ALLERGEN_TOKEN_MAP.get(tok)
        if code:
            return code
    return None


# Zutaten-/Namensregeln (Tier 5) — belastbare Komposita-Treffer, nie "frei".
# Ei NICHT hier (siehe _has_egg, Fall 3). Gluten/Weizen ebenfalls separat, weil
# "glutenfrei" sonst faelschlich als Gluten-Enthaelt gelesen wuerde.
_ALLERGEN_NAME_RULES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("milk", ("milch", "kaese", "butter", "sahne", "joghurt", "quark", "molke")),
    ("fish", FISH_WORDS),
    ("crustaceans", ("garnele", "shrimp", "krabbe", "hummer", "krebstier")),
    ("molluscs", ("muschel", "tintenfisch", "calamari", "weichtier")),
    ("nuts", ("mandel", "haselnuss", "walnuss", "cashew", "pistazie")),
    ("peanuts", ("erdnuss", "erdnuesse", "peanut")),
    ("sesame", ("sesam",)),
    ("soybeans", ("soja", "tofu")),
    ("celery", ("sellerie",)),
    ("mustard", ("senf",)),
    ("gluten_cereals", ("weizen", "gerste", "roggen", "dinkel")),
)

# "frei von"-Claims (nur Claim, keine medizinische Garantie). Laktosefrei ist
# bewusst NICHT dabei: Laktose != Milchprotein (Milchallergie).
_FREE_FROM_RULES: tuple[tuple[str, str], ...] = (
    ("gluten free", "gluten_cereals"), ("glutenfrei", "gluten_cereals"),
    ("milk free", "milk"), ("ohne milch", "milk"), ("milchfrei", "milk"),
    ("nut free", "nuts"), ("nussfrei", "nuts"),
)


def _allergen_codes_in(text: str, *, include_milk: bool, include_egg: bool) -> set[str]:
    """EU-14-Codes, die aus belastbarem ZUTATEN-Text ableitbar sind."""
    found: set[str] = set()
    padded = " " + text + " "
    for code, needles in _ALLERGEN_NAME_RULES:
        if code == "milk" and not include_milk:
            continue
        if _contains_any(padded, needles) is not None:
            found.add(code)
    if include_egg and _has_egg(text):
        found.add("eggs")
    return found


def decide_allergens(ev: Evidence, review: list[str]) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {
        key: {"status": "unknown", "source": SOURCE_UNKNOWN, "confidence": 0.0, "reasons": []}
        for key in EU14_KEYS
    }

    def set_status(code: str, status: str, source: str, confidence: float, reason: str) -> None:
        cur = result[code]
        order = {"contains": 3, "may_contain": 2, "free_from_claim": 1, "unknown": 0}
        # contains gewinnt gegen may_contain/free_from; staerkste Aussage bleibt.
        if order[status] > order[cur["status"]] or (
            order[status] == order[cur["status"]] and source_rank(source) < source_rank(cur["source"])
        ):
            cur.update({"status": status, "source": source, "confidence": round(confidence, 4), "reasons": [reason]})
        elif status == cur["status"]:
            if reason not in cur["reasons"]:
                cur["reasons"].append(reason)

    # 1) OFF allergens_tags -> contains (Barcode-DB-Evidenz, token-exakt).
    for tag in ev.allergen_tags:
        code = _map_allergen_token(tag)
        if code:
            set_status(code, "contains", SOURCE_BARCODE_DB, 0.92, "off:allergens_tags")
    # 2) OFF traces_tags -> may_contain (Spuren != contains, P5).
    for tag in ev.trace_tags:
        code = _map_allergen_token(tag)
        if code:
            set_status(code, "may_contain", SOURCE_BARCODE_DB, 0.85, "off:traces_tags")
    # 3) "frei von"-Claims (nur Claim). Codes merken fuer Konflikterkennung.
    claimed_free: set[str] = set()
    for needle, code in _FREE_FROM_RULES:
        if needle in ev.labels_text or needle in ev.name_text:
            claimed_free.add(code)
            set_status(code, "free_from_claim", SOURCE_BARCODE_DB if ev.has_off else SOURCE_NAME_RULE, 0.6, "claim:free_from")

    # 4) Kategorie-Heuristik (deklarationsnahe Evidenz).
    if ev.category_main == "Milchprodukte & Eier":
        set_status("milk", "contains", SOURCE_NAME_RULE, 0.55, "rule:category_milk")
    if ev.category_main in {"Fisch & Meeresfrüchte", "Fisch & Meeresfruechte"}:
        set_status("fish", "contains", SOURCE_NAME_RULE, 0.55, "rule:category_fish")

    # 5) Zutaten-Treffer = belastbare contains-Evidenz. Widersprechen sie einem
    #    free-from-Claim, gewinnt die Evidenz (Sicherheit) UND es gibt Review —
    #    ein Marketing-Claim darf nie blind ueber widerspruechliche Zutaten
    #    gestellt werden. "glutenfrei" im Namen erzeugt selbst KEIN contains.
    ingredient_codes = _allergen_codes_in(ev.ingredients, include_milk=True, include_egg=True)
    for code in ingredient_codes:
        if code in claimed_free or result[code]["status"] == "free_from_claim":
            review.append(f"allergen:conflict_free_from_vs_contains:{code}")
            result[code] = {
                "status": "contains",
                "source": SOURCE_NAME_RULE,
                "confidence": 0.55,
                "reasons": ["rule:ingredient_contains", "claim:free_from_conflict"],
            }
        elif result[code]["status"] == "unknown":
            set_status(code, "contains", SOURCE_NAME_RULE, 0.5, f"rule:ingredient:{code}")

    # 6) Namens-Treffer (schwaecher) nur, wenn kein free-from-Claim widerspricht
    #    und der Code noch unbekannt ist — so bleibt "glutenfrei" sauber.
    name_codes = _allergen_codes_in(ev.name_text, include_milk=True, include_egg=True)
    for code in name_codes:
        if code in claimed_free:
            continue
        if result[code]["status"] == "unknown":
            set_status(code, "contains", SOURCE_NAME_RULE, 0.5, f"rule:name:{code}")

    # OCR-Unsicherheit / widerspruechliche Quellen -> Review.
    for code in EU14_KEYS:
        r = result[code]
        if r["source"] == SOURCE_OCR and r["confidence"] < 0.6:
            review.append(f"allergen:ocr_uncertain:{code}")
    return result


# ---------------------------------------------------------------------------
# P6 — Naehrwerte + Plausibilitaet
# ---------------------------------------------------------------------------
def _plausibility(values: dict[str, float | None]) -> dict[str, Any]:
    violations: list[str] = []
    for key, val in values.items():
        if val is not None and val < 0:
            violations.append(f"negative:{key}")
    carbs, sugars = values.get("carbs_g"), values.get("sugars_g")
    if carbs is not None and sugars is not None and sugars > carbs + 0.01:
        violations.append("sugars_gt_carbs")
    fat, sat = values.get("fat_g"), values.get("saturated_fat_g")
    if fat is not None and sat is not None and sat > fat + 0.01:
        violations.append("saturated_gt_fat")
    for key in ("fat_g", "carbs_g", "protein_g", "sugars_g", "salt_g", "saturated_fat_g"):
        val = values.get(key)
        if val is not None and val > 100:
            violations.append(f"out_of_range:{key}")
    kcal, kj = values.get("energy_kcal"), values.get("energy_kj")
    if kcal is not None and kj is not None and kcal > 0:
        expected = kcal * 4.184
        if abs(kj - expected) > max(25.0, 0.25 * expected):
            violations.append("energy_kj_kcal_mismatch")
    return {"ok": not violations, "violations": violations}


def build_nutrition(
    legacy_nutrition: dict[str, Any],
    off_product: dict[str, Any] | None,
    amount: float | None,
    basis: str | None,
    serving_size: Any,
    review: list[str],
) -> dict[str, Any]:
    source_legacy = str(legacy_nutrition.get("source", "none"))
    quality, ev_source = _NUTRITION_SOURCE_TO_QUALITY.get(source_legacy, (QUALITY_UNKNOWN, SOURCE_UNKNOWN))
    per100 = legacy_nutrition.get("per_100g", {}) if isinstance(legacy_nutrition.get("per_100g"), dict) else {}
    off = off_product if isinstance(off_product, dict) else {}
    nutriments = off.get("nutriments", {}) if isinstance(off.get("nutriments"), dict) else {}

    kcal = _num(per100.get("kcal"))
    kj = _num(nutriments.get("energy-kj_100g")) or _num(nutriments.get("energy_100g"))
    if kj is None and kcal is not None:
        kj = round(kcal * 4.184, 1)  # Konsistente Ableitung, als estimated markiert.
    values: dict[str, float | None] = {
        "energy_kj": kj,
        "energy_kcal": kcal,
        "fat_g": _num(per100.get("fat_g")),
        "saturated_fat_g": _num(nutriments.get("saturated-fat_100g")),
        "carbs_g": _num(per100.get("carbs_g")),
        "sugars_g": _num(per100.get("sugars_g")),
        "protein_g": _num(per100.get("protein_g")),
        "salt_g": _num(per100.get("salt_g")),
        "fiber_g": _num(per100.get("fiber_g")),
    }
    # Bezugsbasis: OFF kann per-serving liefern; sonst per_100g/ml aus Menge.
    data_per = _norm(off.get("nutrition_data_per") or "")
    nutrition_basis = "per_100g"
    if data_per in {"serving", "portion"}:
        nutrition_basis = "per_serving"
    elif basis == "ml":
        nutrition_basis = "per_100ml"
    elif "prepared" in _norm(off.get("preparation") or ""):
        nutrition_basis = "prepared"

    estimated = quality in {QUALITY_ESTIMATED, QUALITY_OCR} or source_legacy in {"bls", "estimated", "none"}
    plaus = _plausibility(values)
    if not plaus["ok"]:
        review.append("nutrition:implausible")

    has_any = any(v is not None for v in values.values())
    return {
        "basis": nutrition_basis,
        "serving_size": _num(serving_size),
        "serving_unit": "g" if basis != "ml" else "ml",
        "source": ev_source,
        "quality": quality if has_any else QUALITY_UNKNOWN,
        "confidence": round(float(legacy_nutrition.get("confidence", 0.0) or 0.0), 4),
        "estimated": bool(estimated),
        "values": values,
        "raw": {"legacy_source": source_legacy, "off_nutriments_present": bool(nutriments)},
        "plausibility": plaus,
    }


# ---------------------------------------------------------------------------
# P2 — Externe, versionierte Evidenz-Eingaben (Hersteller/Haendler/OCR/KI)
# ---------------------------------------------------------------------------
# Rueckwaertskompatibles Eingabeformat: eine Liste von Evidenz-Items. Jedes Item
# traegt mindestens {claim, status/value, source, confidence} und optional
# {code (Allergen), modelVersion, reason}. Bestehende Pipeline-Felder werden
# verdrahtet (statt Quellen vorzutaeuschen): OFF bleibt barcode_database, OCR
# bleibt ocr_extracted, KI bleibt ai. Quellenrang entscheidet bei Konkurrenz;
# Widersprueche verschwinden NIE still, sondern erzeugen einen Review-Konflikt.
_DIET_CLAIMS = ("vegan", "vegetarian", "halal")
_ALLERGEN_STATUS_ORDER = {"contains": 3, "may_contain": 2, "free_from_claim": 1, "unknown": 0}

# P4 — erlaubte Statuswerte je Claim. Kein stilles Coercing: ein unbekannter
# Statuswert (z. B. vegan=maybe) wird abgelehnt, nicht umgedeutet.
_VALID_DIET_STATUS = {
    "vegan": {"yes", "no", "unknown"},
    "vegetarian": {"yes", "no", "unknown"},
    "halal": {"halal", "not_halal", "doubtful", "unknown"},
}
_VALID_ALLERGEN_STATUS = {"contains", "may_contain", "free_from_claim", "unknown"}


def validate_evidence_input(raw: Any) -> tuple[bool, str | None, dict[str, Any] | None]:
    """P4 — zentrale, strikte Schema-Validierung VOR jeder Evidenzanwendung.

    Returns ``(ok, rejection_reason, normalized)``. Bei ``ok=False`` ist
    ``normalized`` None und ``rejection_reason`` ein maschinenlesbarer Grund;
    der Aufrufer darf die Evidenz dann NICHT anwenden. Geprueft werden:
      * bekannte Quelle (sonst darf sie keine Entscheidung ueberschreiben),
      * bekannter Claim + gueltiger Status je Claim (kein Coercing),
      * Allergen-Code aus der EU-14-Taxonomie,
      * Confidence endlich und in [0, 1] (NaN/Inf/negativ/>1 abgelehnt),
      * KI-Evidenz braucht eine nichtleere Modellversion,
      * Nicht-KI darf durch ein frei uebergebenes ``modelVersion`` NICHT als
        KI-Beteiligung erscheinen (``is_ai``/``model_version`` bleiben dann leer).
    """
    if not isinstance(raw, dict):
        return False, "not_an_object", None
    claim = str(raw.get("claim") or "")
    source = str(raw.get("source") or "")
    status_raw = raw.get("status", raw.get("value"))
    status = str(status_raw) if status_raw is not None else None
    # Interner, NICHT vom externen Payload faelschbarer Trust-Marker. Default
    # True (programmatische/explizite Pipeline-Evidenz); ``collect_evidence_inputs``
    # setzt ihn fuer frei angehaengte ``evidenceInputs`` hart auf False.
    trusted = raw.get("_trusted", True) is True

    # P2: ``unknown`` ist ein Ergebnis-/Fallbackwert, KEINE entscheidungsfaehige
    # Evidenzquelle. ``source=unknown`` und fehlende Quellen sind nicht autoritativ
    # und duerfen niemals einen Status setzen — Confidence 1 aendert das nicht.
    if source == "" or source == SOURCE_UNKNOWN:
        return False, f"non_authoritative_source:{claim or 'unknown'}", None
    if source not in SOURCE_RANK:
        return False, f"unknown_source:{source}:{claim or 'unknown'}", None
    # P1: eine untrusted (frei angehaengte) Evidenz darf KEINE privilegierte
    # Quelle selbst behaupten. Solche Quellen entstehen ausschliesslich ueber den
    # verifizierten Hersteller-/Connector-/OCR-/KI-Adapter-Pfad
    # (TrustedEvidenceContext / Funktionsparameter).
    if not trusted and source in PRIVILEGED_SOURCES:
        return False, f"untrusted_privileged_source:{source}:{claim or 'unknown'}", None
    is_ai = source == SOURCE_AI

    conf_raw = raw.get("confidence", 0.0)
    try:
        confidence = float(conf_raw if conf_raw is not None else 0.0)
    except (TypeError, ValueError):
        return False, f"invalid_confidence:{claim or 'unknown'}", None
    if not math.isfinite(confidence) or confidence < 0.0 or confidence > 1.0:
        return False, f"confidence_out_of_range:{claim or 'unknown'}", None

    code: str | None = None
    if claim in _DIET_CLAIMS:
        if status not in _VALID_DIET_STATUS[claim]:
            return False, f"invalid_status:{claim}:{status}", None
    elif claim == "allergen":
        code = str(raw.get("code") or "")
        if code not in EU14_KEYS:
            return False, f"unknown_allergen_code:{code or 'missing'}", None
        if status not in _VALID_ALLERGEN_STATUS:
            return False, f"invalid_status:allergen:{status}", None
    else:
        return False, f"unknown_claim:{claim or 'missing'}", None

    model_version = raw.get("modelVersion")
    has_model_version = isinstance(model_version, str) and model_version.strip() != ""
    if is_ai and not has_model_version:
        return False, f"ai_no_model_version:{claim}", None

    # P2 — Provenienz vollstaendig erhalten. Es werden NUR tatsaechlich vorhandene
    # String-Werte uebernommen (keine Provenienz erfinden). Die Provenienz geht in
    # die akzeptierte, normalisierte Evidenz ein und damit in den Fingerprint —
    # verschiedene Produzenten-/Extraktor-/Modellversionen ergeben verschiedene
    # Fingerprints, ohne in TypeScript eine zweite Fachlogik einzufuehren.
    provenance: dict[str, str] = {}
    for prov_key in ("producer", "producerVersion", "extractorVersion", "connector", "originalField"):
        prov_val = raw.get(prov_key)
        if isinstance(prov_val, str) and prov_val.strip() != "":
            provenance[prov_key] = prov_val.strip()
    # Modellversion ist die KI-Provenienz; nur fuer echte KI-Evidenz wirksam.
    if is_ai and has_model_version:
        provenance["modelVersion"] = str(model_version).strip()

    norm = {
        "claim": claim,
        "source": source,
        "status": status,
        "confidence": round(confidence, 4),
        "reason": str(raw.get("reason") or f"evidence:{source}"),
        "is_ai": is_ai,
        # Nur KI traegt eine wirksame Modellversion; ein frei uebergebenes
        # modelVersion an Nicht-KI bleibt wirkungslos (keine KI-Beteiligung).
        "model_version": str(model_version) if (is_ai and has_model_version) else None,
        "code": code,
        # Erhaltene Provenienz (nur vorhandene Werte). Geht in Fingerprint + Diagnose.
        "provenance": provenance,
    }
    return True, None, norm


def _apply_allergen_evidence(
    allergens: dict[str, dict[str, Any]],
    code: str,
    status: str,
    source: str,
    confidence: float,
    reason: str,
    review: list[str],
) -> None:
    cur = allergens[code]
    order = _ALLERGEN_STATUS_ORDER
    # Widerspruch contains <-> free_from_claim ist sicherheitsrelevant -> Review.
    if cur["status"] != "unknown" and status != cur["status"] and (
        "free_from_claim" in {status, cur["status"]} and "contains" in {status, cur["status"]}
    ):
        review.append(f"allergen:source_conflict:{code}")
    if order[status] > order[cur["status"]] or (
        order[status] == order[cur["status"]] and source_rank(source) < source_rank(cur["source"])
    ):
        cur.update({"status": status, "source": source, "confidence": round(float(confidence), 4), "reasons": [reason]})


def apply_evidence_inputs(
    claims: dict[str, dict[str, Any]],
    allergens: dict[str, dict[str, Any]],
    review: list[str],
    evidence_inputs: list[dict[str, Any]] | None,
) -> tuple[str | None, list[dict[str, Any]]]:
    """Wendet externe Evidenz nach Quellenrang an (mutiert ``claims``/``allergens``
    in place). Gibt ``(model_version, accepted)`` zurueck: die Modellversion, wenn
    belastbare KI-Evidenz tatsaechlich beteiligt war (sonst None), und die Liste
    der AKZEPTIERTEN, normalisierten Evidenz (schema-valide und nicht per
    KI-Policy verworfen). Abgelehnte/Spoof-Evidenz ist hier NICHT enthalten und
    geht damit auch nicht in den Fingerprint ein."""
    model_version_used: str | None = None
    accepted: list[dict[str, Any]] = []
    if not evidence_inputs:
        return None, accepted
    for raw in evidence_inputs:
        # P4: strikte Schema-Validierung VOR jeder Anwendung. Ungueltige Evidenz
        # wird nicht angewendet und erzeugt einen maschinenlesbaren Review-Grund.
        ok, rejection, norm = validate_evidence_input(raw)
        if not ok or norm is None:
            review.append(f"evidence:rejected:{rejection}")
            continue
        claim = norm["claim"]
        source = norm["source"]
        status = norm["status"]
        confidence = norm["confidence"]
        reason = norm["reason"]
        is_ai = norm["is_ai"]

        # KI-Guardrails: gueltiges Schema, aber per Policy verworfen — KI darf
        # kein Zertifikat/keine Allergenfreiheit erfinden.
        if is_ai:
            if claim == "halal" and status == "halal":
                review.append("ai:halal_certification_ignored")
                continue
            if claim == "allergen" and status == "free_from_claim":
                review.append("ai:allergen_free_claim_ignored")
                continue

        # Akzeptierte, entscheidungsrelevante Evidenz fuer den Fingerprint.
        accepted.append(norm)

        if claim in _DIET_CLAIMS and status is not None:
            cur = claims.get(claim)
            if cur is None:
                continue
            if is_ai:
                model_version_used = norm["model_version"]  # KI tatsaechlich beruecksichtigt
            conflict = cur["status"] != "unknown" and status != cur["status"]
            if conflict:
                review.append(f"{claim}:source_conflict:{cur['source']}_vs_{source}")
            stronger = source_rank(source) < source_rank(cur["source"])
            fills_gap = cur["status"] == "unknown" and source_rank(source) <= source_rank(cur["source"])
            if stronger or fills_gap:
                claims[claim] = {
                    "status": status,
                    "source": source,
                    "confidence": round(confidence, 4),
                    "reasons": list(cur["reasons"]) + [reason],
                }
        elif claim == "allergen":
            code = norm["code"] or ""
            if code in allergens and status != "unknown":
                if is_ai:
                    model_version_used = norm["model_version"]
                _apply_allergen_evidence(allergens, code, status, source, confidence, reason, review)
    return model_version_used, accepted


# ---------------------------------------------------------------------------
# P1 — Unveraenderliche Sicherheitsinvarianten (zentrale Safety-Schicht)
# ---------------------------------------------------------------------------
# Harte biologische Ausschluesse. Quellenrang entscheidet NUR zwischen fachlich
# vereinbaren Evidenzen; ein belegter Ausschluss bleibt immer bestehen. Ein
# positiver Claim oder Zertifikathinweis (egal welcher Quellenrang) darf ihn
# NIEMALS aushebeln. Widerspruechliche Evidenz bleibt sichtbar (Review) und die
# verworfene Evidenz wird diagnostisch festgehalten.
_HARD_NEGATIVE = {"vegan": "no", "vegetarian": "no", "halal": "not_halal"}


def apply_safety_invariants(
    claims: dict[str, dict[str, Any]],
    base_claims: dict[str, dict[str, Any]],
    review: list[str],
) -> list[dict[str, Any]]:
    """Erzwingt die belegten harten Negativstatus aus ``base_claims`` (rein aus
    Evidenz/Regeln, VOR externer Evidenz entschieden) auf die finalen ``claims``.

    Wenn die Basis einen harten Ausschluss belegt (``vegan=no`` /
    ``vegetarian=no`` / ``halal=not_halal``) und externe Evidenz diesen kippen
    wollte, wird der sichere Negativstatus wiederhergestellt, ein
    ``<claim>:safety_override``-Reviewgrund gesetzt und die verworfene Evidenz
    zurueckgegeben. Stimmte die Evidenz mit dem Ausschluss ueberein, bleibt sie
    unveraendert (kein Spurious-Review). Mutiert ``claims`` in place."""
    discarded: list[dict[str, Any]] = []
    for key, safe in _HARD_NEGATIVE.items():
        base = base_claims.get(key)
        if base is None or base["status"] != safe:
            continue  # kein belegter harter Ausschluss -> nichts zu schuetzen
        cur = claims[key]
        if cur["status"] == safe:
            continue  # niemand hat ueberschrieben (Evidenz war vereinbar)
        review.append(f"{key}:safety_override:{cur['source']}:{cur['status']}")
        discarded.append({
            "claim": key,
            "discardedStatus": cur["status"],
            "discardedSource": cur["source"],
            "enforced": safe,
        })
        claims[key] = {
            "status": base["status"],
            "source": base["source"],
            "confidence": base["confidence"],
            "reasons": list(base["reasons"]) + [
                f"safety:hard_exclusion_discards:{cur['source']}:{cur['status']}",
            ],
        }
    return discarded


# ---------------------------------------------------------------------------
# P1/P2 — Trust-Boundary + zentraler Evidenz-Adapter
# ---------------------------------------------------------------------------
# Ueberfuehrt VORHANDENE echte Quelldaten in das versionierte Evidenzformat.
# Taeuscht KEINE Quelle vor: fehlende Felder erzeugen keine Evidenz, der Payload
# kann keine hoehere Quelle erschleichen (die Quelle wird je Feld hart gesetzt),
# und der Adapter trifft KEINE fachliche Entscheidung. OFF/Barcode bleibt
# Basisevidenz (decide_allergens/build_nutrition) und laeuft bewusst NICHT ueber
# diesen Adapter — OFF wird so nie zu manufacturer_label.
#
# Vertrauensgrenze (pa-v6): privilegierte Evidenz (Hersteller/Haendler/OCR/KI)
# entsteht AUSSCHLIESSLICH ueber den getrennten ``TrustedEvidenceContext`` (von der
# Pipeline explizit uebergeben) bzw. den aequivalenten internen
# ``evidence_inputs=``-Parameter. NORMALE Offer-Felder (``retailerEvidence`` /
# ``ocrEvidence`` / ``aiEvidence`` / ``manufacturerEvidence`` /
# ``manufacturerEvidenceVerified`` / ``ocrVersion`` / ``aiModelVersion``) und frei
# an ein Offer angehaengte ``evidenceInputs`` sind UNTRUSTED: sie werden mit einem
# internen, nicht faelschbaren Trust-Marker (``_trusted=False``) versehen und
# koennen keine privilegierte Quelle behaupten (-> abgelehnt in
# ``validate_evidence_input``). Ein Offer-Payload kann selbst keinen Trust setzen.
@dataclass
class TrustedEvidenceContext:
    """Vertrauenswuerdige, intern erzeugte Evidenz — explizit aus der Pipeline
    uebergeben, NICHT aus beliebigen Offer-Feldern gelesen. Jede Liste enthaelt
    rohe Evidenz-Items ``{claim, status/value, confidence, ...}``; die Quelle wird
    je Feld hart gesetzt (der Produzent bestimmt sie, nicht der Payload)."""

    retailer: list[dict[str, Any]] = field(default_factory=list)
    ocr: list[dict[str, Any]] = field(default_factory=list)
    ai: list[dict[str, Any]] = field(default_factory=list)
    manufacturer: list[dict[str, Any]] = field(default_factory=list)
    ocr_version: str = ""
    ai_model_version: str = ""
    # Hersteller-Evidenz gilt nur als belegt, wenn der Connector/Server sie
    # nachvollziehbar verifiziert hat — eine nicht vom externen Payload
    # faelschbare Markierung (getrennter Funktionsparameter), kein Offer-Boolean.
    manufacturer_verified: bool = False


def _coerce_source_items(
    raw: Any,
    source: str,
    *,
    version: str = "",
    version_field: str | None = None,
) -> list[dict[str, Any]]:
    """Vertrauenswuerdige Quell-Items: Quelle hart setzen, Trust-Marker entfernen
    (Default = trusted), optionale Versionsangabe ergaenzen."""
    if not isinstance(raw, list):
        return []
    out: list[dict[str, Any]] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        item = dict(entry)
        # Quelle ehrlich erzwingen — ein Payload-`source` darf nicht hochstufen.
        item["source"] = source
        item.pop("_trusted", None)  # trusted by default in validate_evidence_input
        if version_field and version:
            item.setdefault(version_field, version)
        out.append(item)
    return out


def _untrusted_items(raw: Any) -> list[dict[str, Any]]:
    """Frei angehaengte, untrusted ``evidenceInputs``: die deklarierte Quelle
    bleibt erhalten (damit eine privilegierte Quelle ehrlich abgelehnt werden
    kann), aber der interne Trust-Marker wird hart auf False gesetzt — ein
    gefaelschter Marker im Payload greift NICHT."""
    if not isinstance(raw, list):
        return []
    out: list[dict[str, Any]] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        item = dict(entry)
        for control_key in ("_trusted", "__trusted__", "trusted"):
            item.pop(control_key, None)
        item["_trusted"] = False
        out.append(item)
    return out


def _untrusted_source_items(raw: Any, source: str) -> list[dict[str, Any]]:
    """Normale, am Offer haengende typisierte Felder (``retailerEvidence`` etc.).

    Diese sind KEINE sichere Trust-Boundary mehr (P1): ein gewoehnliches Offer-Feld
    darf niemals automatisch privilegierte Evidenz erzeugen. Die Items werden mit
    ihrer privilegierten Quelle, aber hartem internen Trust-Marker ``_trusted=False``
    weitergereicht — ``validate_evidence_input`` lehnt sie dann mit einem
    maschinenlesbaren Grund (``untrusted_privileged_source:<src>:<claim>``) ab. Ein
    im Payload gefaelschter Trust-Marker greift NICHT."""
    if not isinstance(raw, list):
        return []
    out: list[dict[str, Any]] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        item = dict(entry)
        for control_key in ("_trusted", "__trusted__", "trusted"):
            item.pop(control_key, None)
        item["source"] = source
        item["_trusted"] = False
        out.append(item)
    return out


def _dedupe_evidence(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Deterministische Deduplikation ueber (claim, code, source, status)."""
    seen: set[tuple[str, str, str, str]] = set()
    out: list[dict[str, Any]] = []
    for it in items:
        status = it.get("status", it.get("value"))
        key = (
            str(it.get("claim") or ""),
            str(it.get("code") or ""),
            str(it.get("source") or ""),
            str(status if status is not None else ""),
        )
        if key in seen:
            continue
        seen.add(key)
        out.append(it)
    return out


def collect_evidence_inputs(
    offer: dict[str, Any],
    explicit: list[dict[str, Any]] | None = None,
    *,
    trusted: TrustedEvidenceContext | None = None,
) -> list[dict[str, Any]]:
    """Sammelt + normalisiert Evidenz, getrennt nach Vertrauensherkunft.

    Reihenfolge (deterministisch, TRUSTED zuerst, damit Trusted bei Duplikaten
    gewinnt):
      1. ``explicit`` — programmatische, von der Pipeline uebergebene Evidenz
         (aequivalenter interner Parameter, getrennt vom Offer-Payload).
      2. ``trusted`` (``TrustedEvidenceContext``) — vom verifizierten Hersteller-/
         Connector-/OCR-/KI-Adapter erzeugte Evidenz; Quelle je Feld hart gesetzt.
         Dies ist der EINZIGE privilegierte Weg ueber das Offer hinaus.
      3. Normale, am Offer haengende typisierte Felder ``retailerEvidence`` /
         ``ocrEvidence`` / ``aiEvidence`` / ``manufacturerEvidence`` sind seit
         pa-v6 NICHT mehr "trusted-by-convention": sie sind UNTRUSTED und werden
         (mit ihrer privilegierten Quelle, aber hartem Trust-Marker False) zur
         Ablehnung weitergereicht. ``manufacturerEvidenceVerified`` / ``ocrVersion``
         / ``aiModelVersion`` am Offer setzen KEINEN Trust mehr.
      4. ZULETZT die frei angehaengten, UNTRUSTED ``offer['evidenceInputs']`` —
         mit hartem Trust-Marker False; eine privilegierte Quelle wird spaeter in
         ``validate_evidence_input`` abgelehnt (P1).

    Doppelte Eintraege werden ueber (claim, code, source, status) dedupliziert;
    die zuerst gesehene (trusted) Variante bleibt erhalten."""
    items: list[dict[str, Any]] = []

    # 1) explizite Pipeline-Evidenz (trusted, getrennter interner Parameter).
    if explicit:
        items.extend(x for x in explicit if isinstance(x, dict))

    # 2) TrustedEvidenceContext — der EINZIGE privilegierte, getrennte Kanal.
    if trusted is not None:
        items.extend(_coerce_source_items(trusted.retailer, SOURCE_RETAILER))
        items.extend(_coerce_source_items(
            trusted.ocr, SOURCE_OCR,
            version=str(trusted.ocr_version or ""), version_field="extractorVersion",
        ))
        items.extend(_coerce_source_items(
            trusted.ai, SOURCE_AI,
            version=str(trusted.ai_model_version or ""), version_field="modelVersion",
        ))
        if trusted.manufacturer_verified is True:
            items.extend(_coerce_source_items(trusted.manufacturer, SOURCE_MANUFACTURER))

    # 3) Normale typisierte Offer-Felder: UNTRUSTED (kein trusted-by-convention
    #    mehr). Sie behalten ihre privilegierte Quelle, werden aber hart als
    #    untrusted markiert und damit in validate_evidence_input abgelehnt
    #    (maschinenlesbarer Grund untrusted_privileged_source) — ein gewoehnliches
    #    Offer-Feld darf niemals automatisch privilegierte Evidenz erzeugen.
    items.extend(_untrusted_source_items(offer.get("retailerEvidence"), SOURCE_RETAILER))
    items.extend(_untrusted_source_items(offer.get("ocrEvidence"), SOURCE_OCR))
    items.extend(_untrusted_source_items(offer.get("aiEvidence"), SOURCE_AI))
    items.extend(_untrusted_source_items(offer.get("manufacturerEvidence"), SOURCE_MANUFACTURER))

    # 4) frei angehaengte, UNTRUSTED evidenceInputs (zuletzt -> verlieren Dedup).
    items.extend(_untrusted_items(offer.get("evidenceInputs")))

    return _dedupe_evidence(items)


# ---------------------------------------------------------------------------
# Quellenfingerprint (P2/P3/P9) — entwertet Cache bei Evidenz-/Regelaenderung.
# ---------------------------------------------------------------------------
def _sorted_tags(off: dict[str, Any], key: str) -> str:
    raw = off.get(key)
    if not isinstance(raw, list):
        return ""
    return ",".join(sorted(str(t) for t in raw))


def _canonical(value: Any) -> str:
    """Rekursive, deterministische Serialisierung strukturierter Daten (P3).
    Dict-Keys werden sortiert, Listen ebenfalls (Tag-/Key-Reihenfolge darf den
    Fingerprint NICHT aendern); String-Blaetter werden normalisiert."""
    if isinstance(value, dict):
        return "{" + ",".join(f"{_norm(k)}:{_canonical(value[k])}" for k in sorted(value, key=str)) + "}"
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(sorted(_canonical(v) for v in value)) + "]"
    if value is None:
        return ""
    if isinstance(value, str):
        return _norm(value)
    return str(value)


def source_fingerprint(
    offer: dict[str, Any],
    off_product: dict[str, Any] | None,
    nutrition: dict[str, Any] | None = None,
    *,
    evidence_inputs: list[dict[str, Any]] | None = None,
    model_version: str | None = None,
    amount: float | None = None,
    basis: str | None = None,
    serving_size: Any = None,
    serving_unit: str | None = None,
    nutrition_basis: str | None = None,
    evidence_schema_version: str = EVIDENCE_SCHEMA_VERSION,
) -> str:
    """Deterministischer Quellenfingerprint ueber ALLE entscheidungsrelevanten
    Eingaben (P3). Enthaelt Name/Marke/Menge/Barcode, category/canonicalCategory/
    sourceCategory(Raw), Haendler-/Herstellerfelder, Zutaten, Allergen-/Spuren-/
    Label-/analysis-Tags, Naehrwerte samt Einheiten/Quelle, OCR-Text+Version,
    KI-Evidenz und Modellversion. NEU (pa-v4): amount, basis, serving size/unit,
    Naehrwertbasis und die Evidenzschema-Version — also exakt die Eingaben, die
    auch ``build_product_analysis`` verwendet (verschiedene Einheit/Basis/Menge
    aendern den Fingerprint, wenn sie das Ergebnis beeinflussen). Kanonisch +
    sortiert: Objekt-Key- und Tag-Reihenfolge aendern den Fingerprint NICHT;
    semantische Aenderungen schon. ``analyzedAt`` bleibt ausgeschlossen. Es geht
    NUR die tatsaechlich akzeptierte (normalisierte) Evidenz ein — von
    ``build_product_analysis`` so uebergeben; abgelehnte/Spoof-Evidenz aendert den
    Fingerprint nicht. NEU (pa-v6): die akzeptierte Evidenz traegt jetzt die volle
    Provenienz (producer/producerVersion/extractorVersion/modelVersion/connector/
    originalField) -> verschiedene Produzenten-/Extraktorversionen ergeben
    verschiedene Fingerprints. Praefix sf5: entwertet alle alten sf1..sf4-Analysen."""
    parts = [
        RULES_VERSION,
        evidence_schema_version,
        _norm(offer.get("normalizedName") or offer.get("name") or offer.get("title")),
        _norm(offer.get("brand")),
        _norm(offer.get("size") or offer.get("unit") or offer.get("quantity")),
        _norm(offer.get("baseUnit")),
        _norm(offer.get("gtin") or offer.get("ean") or offer.get("barcode")),
        # Menge/Basis/Portion/Naehrwertbasis beeinflussen die Naehrwertausgabe.
        "amount:" + ("" if amount is None else f"{float(amount):g}"),
        "basis:" + _norm(basis),
        "ssize:" + ("" if serving_size is None else _norm(serving_size)),
        "sunit:" + _norm(serving_unit),
        "nbasis:" + _norm(nutrition_basis),
        # Kategorie ist entscheidungsrelevant (Alkohol/Milch/Fisch) -> in den FP.
        "cat:" + _norm(offer.get("category")),
        "scat:" + _norm(offer.get("sourceCategory")),
        "scatraw:" + _norm(offer.get("sourceCategoryRaw")),
        "ccat:" + _canonical(offer.get("canonicalCategory")),
        # Haendler-/Herstellerfelder (sofern die Pipeline sie liefert).
        "rd:" + _canonical(offer.get("retailerData")),
        "md:" + _canonical(offer.get("manufacturerData") or offer.get("manufacturer")),
        # OCR-Text + Extraktorversion.
        "ocr:" + _norm(offer.get("ocrText") or offer.get("ocr") or ""),
        "ocrv:" + _norm(offer.get("ocrVersion")),
        "off1" if isinstance(off_product, dict) else "off0",
    ]
    if isinstance(off_product, dict):
        parts.append(_norm(off_product.get("ingredients_text")))
        parts.append(_sorted_tags(off_product, "allergens_tags"))
        parts.append(_sorted_tags(off_product, "traces_tags"))
        parts.append(_sorted_tags(off_product, "labels_tags"))
        parts.append(_sorted_tags(off_product, "ingredients_analysis_tags"))
        parts.append(_norm(off_product.get("quantity")))
        parts.append(_norm(off_product.get("serving_size")))
        parts.append(_norm(off_product.get("nutrition_data_per")))
        nutriments = off_product.get("nutriments")
        if isinstance(nutriments, dict):
            parts.append(",".join(f"{_norm(k)}={nutriments[k]}" for k in sorted(nutriments, key=str)))
    if isinstance(nutrition, dict):
        parts.append(_norm(nutrition.get("source")))
        per100 = nutrition.get("per_100g")
        if isinstance(per100, dict):
            parts.append(",".join(f"{_norm(k)}={per100[k]}" for k in sorted(per100, key=str)))
    # KI-Evidenz + Modellversion: aendern die Entscheidung -> in den Fingerprint.
    parts.append("mv:" + _norm(model_version))
    if evidence_inputs:
        parts.append("ev:" + _canonical(evidence_inputs))
    digest = hashlib.sha1("|".join(parts).encode("utf-8")).hexdigest()
    return f"sf5:{digest[:16]}"


# ---------------------------------------------------------------------------
# Hauptzusammenbau
# ---------------------------------------------------------------------------
def build_product_analysis(
    offer: dict[str, Any],
    off_product: dict[str, Any] | None,
    legacy_nutrition: dict[str, Any],
    *,
    amount: float | None = None,
    basis: str | None = None,
    evidence_inputs: list[dict[str, Any]] | None = None,
    trusted: TrustedEvidenceContext | None = None,
    model_version: str | None = None,
    now: str | None = None,
) -> dict[str, Any]:
    """Baut das vollstaendige ProductAnalysisV2-Objekt (eine Wahrheit).

    Vertrauenswuerdige, intern erzeugte Evidenz wird ausschliesslich ueber
    ``evidence_inputs`` (programmatisch) oder ``trusted`` (TrustedEvidenceContext)
    uebergeben. Frei an das Offer angehaengte ``evidenceInputs`` gelten als
    untrusted und koennen keine privilegierte Quelle erschleichen (P1)."""
    ev = Evidence(offer, off_product)
    review: list[str] = []

    # P1/P2: zentraler Adapter — explizite + vertrauenswuerdige (TrustedEvidenceContext)
    # + rueckwaertskompatible Offer-Felder als trusted, frei angehaengte
    # evidenceInputs als untrusted. Keine Quelle wird vorgetaeuscht.
    evidence_inputs = collect_evidence_inputs(offer, evidence_inputs, trusted=trusted)

    # 1) Rohe Regelentscheidungen (rein aus Evidenz/Regeln) — die BASIS, die die
    #    harten biologischen Ausschluesse fuer P1 belegt.
    vegetarian = decide_vegetarian(ev, review)
    vegan = decide_vegan(ev, review)
    halal = decide_halal(ev, review)
    allergens = decide_allergens(ev, review)
    base_claims = {
        "vegan": dict(vegan), "vegetarian": dict(vegetarian), "halal": dict(halal),
    }

    # 2) Quellenkonflikte aufloesen: externe Evidenz nach Rang einarbeiten (P2/P4).
    #    ``accepted_evidence`` enthaelt NUR schema-valide, nicht per Policy verworfene
    #    Evidenz und geht (statt der rohen Eingabe) in den Fingerprint ein — abgelehnte
    #    Spoof-Evidenz darf keine wiederverwendbare Analyse erzeugen.
    claims = {"vegan": vegan, "vegetarian": vegetarian, "halal": halal}
    used_model_version, accepted_evidence = apply_evidence_inputs(claims, allergens, review, evidence_inputs)

    # 3) Abschliessend die unveraenderlichen Safety-Invariants anwenden (P1):
    #    ein belegter harter Ausschluss kann NICHT von hoeher gerankter Evidenz
    #    ueberschrieben werden. Verworfene Evidenz diagnostisch festhalten.
    safety_overrides = apply_safety_invariants(claims, base_claims, review)
    vegan, vegetarian, halal = claims["vegan"], claims["vegetarian"], claims["halal"]

    # modelVersion AUSSCHLIESSLICH bei tatsaechlich beruecksichtigter, gueltiger
    # KI-Evidenz (P4): der direkte Parameter allein setzt sie NICHT.
    effective_model_version = used_model_version

    serving_size = off_product.get("serving_size") if isinstance(off_product, dict) else None
    nutrition = build_nutrition(legacy_nutrition, off_product, amount, basis, serving_size, review)

    review_reasons = sorted(set(review))
    return {
        "analysisVersion": RULES_VERSION,
        "rulesVersion": RULES_VERSION,
        "evidenceSchemaVersion": EVIDENCE_SCHEMA_VERSION,
        "modelVersion": effective_model_version,
        "analyzedAt": now,
        "sourceFingerprint": source_fingerprint(
            offer, off_product, legacy_nutrition,
            evidence_inputs=accepted_evidence, model_version=effective_model_version,
            amount=amount, basis=basis,
            serving_size=nutrition.get("serving_size"),
            serving_unit=nutrition.get("serving_unit"),
            nutrition_basis=nutrition.get("basis"),
        ),
        "vegan": vegan,
        "vegetarian": vegetarian,
        "halal": halal,
        # Halal-Relevanz-Gate (pa-v7): ZUSATZmetadaten VOR der tiefen KI-Pruefung.
        # Aendert ``halal`` (oben) NICHT — nutzt dieselbe Evidenz, ist also
        # widerspruchsfrei (haram <-> not_halal). ``deepAnalysisRecommended`` sagt,
        # ob dieses Produkt ueberhaupt an die tiefe Halal-Pruefung eskaliert werden
        # soll; pflanzliche Grundprodukte/Schwein/Alkohol brauchen das nie.
        "halalRelevance": classify_halal_relevance(ev),
        "gelatin": ev.gelatin(),
        "allergens": allergens,
        "nutrition": nutrition,
        "safetyOverrides": safety_overrides,
        # Akzeptierte, normalisierte Evidenz inkl. Provenienz — rein diagnostisch
        # in Python verfuegbar (Quelle/Status/Code/Confidence + producer/
        # producerVersion/extractorVersion/modelVersion/connector/originalField).
        # Keine Fachlogik in TypeScript; die TS-Seite projiziert nur.
        "acceptedEvidence": accepted_evidence,
        "reviewNeeded": bool(review_reasons),
        "reviewReasons": review_reasons,
    }


# ---------------------------------------------------------------------------
# Legacy-Ableitung (keine sofortige destruktive Migration, P1)
# ---------------------------------------------------------------------------
_HALAL_V2_TO_LEGACY = {"halal": "yes", "not_halal": "no", "doubtful": "unknown", "unknown": "unknown"}
_DIET_V2_TO_LEGACY = {"yes": True, "no": False, "unknown": None}


def legacy_diet_flags(analysis: dict[str, Any]) -> dict[str, Any]:
    """Erzeugt das bestehende ``dietFlags``-Format aus der V2-Wahrheit."""
    vegan = analysis["vegan"]
    vegetarian = analysis["vegetarian"]
    halal = analysis["halal"]
    legacy_status = _HALAL_V2_TO_LEGACY.get(halal["status"], "unknown")
    return {
        "vegan": _DIET_V2_TO_LEGACY.get(vegan["status"]),
        "vegetarian": _DIET_V2_TO_LEGACY.get(vegetarian["status"]),
        "gelatin": analysis["gelatin"],
        "halal": {
            "status": legacy_status,
            # Den vollen V2-Status (inkl. doubtful) zusaetzlich mitgeben.
            "statusV2": halal["status"],
            "confidence": halal["confidence"],
            "reasons": halal["reasons"],
        },
        "reasons": list(dict.fromkeys(vegan["reasons"] + vegetarian["reasons"])),
        "confidence": round(max(vegan["confidence"], vegetarian["confidence"]), 4),
    }


def legacy_allergens(analysis: dict[str, Any]) -> dict[str, Any]:
    """Erzeugt das bestehende ``allergens``-Format aus der V2-Wahrheit."""
    per = analysis["allergens"]
    contains = sorted(k for k, v in per.items() if v["status"] == "contains")
    may = sorted(k for k, v in per.items() if v["status"] == "may_contain")
    free = sorted(k for k, v in per.items() if v["status"] == "free_from_claim")
    sources = {v["source"] for k, v in per.items() if v["status"] in {"contains", "may_contain"}}
    if SOURCE_BARCODE_DB in sources:
        src = "openfoodfacts"
    elif sources:
        src = "rules"
    else:
        src = "none"
    confs = [v["confidence"] for v in per.values() if v["status"] in {"contains", "may_contain"}]
    return {
        "source": src,
        "contains": contains,
        "may_contain": may,
        "free_from_claim": free,
        "unknown": [],
        "confidence": round(max(confs), 4) if confs else (0.45 if src != "none" else 0.2),
        "reasons": sorted({r for v in per.values() for r in v["reasons"]}) or ["rule:no_allergen_signal"],
    }
