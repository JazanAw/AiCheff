from __future__ import annotations

import argparse
import hashlib
import json
import re
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


def resolve_berlin_timezone() -> timezone | ZoneInfo:
    try:
        return ZoneInfo("Europe/Berlin")
    except ZoneInfoNotFoundError:
        return timezone(timedelta(hours=1), name="Europe/Berlin")


BERLIN_TZ = resolve_berlin_timezone()

DEFAULT_TAXONOMY_PATH = Path(__file__).with_name("taxonomy.yaml")
DEFAULT_CACHE_PATH = Path("cache") / "ollama_cache.jsonl"

# Bumped when the classifier prompt/schema changes in a way that invalidates
# previously cached answers. Cache entries WITHOUT this version (the old
# format:"json" era that produced garbage) are ignored on load, so a new scan
# never reuses a stale/low-quality answer as if it were trustworthy KI.
#
# v3 (Task P4): the offer fingerprint now also covers the retailer source
# category/department. These ARE decision-relevant (detect_category_conflict and
# the food-source signal both read them), so a cache entry keyed without them
# could serve a stale Non-Food verdict for a product whose department now clearly
# says Food (the "Spritzring" case, Task P2). Bumping the version controllably
# re-evaluates every pre-v3 entry instead of trusting an incomplete fingerprint;
# the cache file is NOT wiped — old-version lines are simply ignored on load.
# v4: the LLM decision cache is now keyed only by inputs that can influence the
# classifier (product identity text, source context, model and taxonomy). Price,
# validity and the per-offer id deliberately stay out: they change every week
# but are not part of the classifier prompt.
#
# BEWUSST NICHT auf v5 gehoben, als `reasons` auf eine Begruendung begrenzt und
# zum Pflichtfeld wurde: die Entscheidungsfelder entstehen laut Schema-Reihenfolge
# davor und wurden nachgemessen (8/8 identisch inkl. confidence). Ein Bump wuerde
# nur jeden gueltigen v4-Eintrag entwerten und den naechsten Scan ohne Cache
# starten lassen — genau die Laufzeit, die die Aenderung einsparen soll.
CLASSIFIER_SCHEMA_VERSION = "cat-schema-v4"

SUPPORTED_MODES = ("overlap", "starts")
OLLAMA_MODES = ("on", "off")
SUPPORTED_WEEK_WINDOWS = ("calendar", "retail")
WEEKDAY_ALIASES = {
    "mon": 0,
    "tue": 1,
    "wed": 2,
    "thu": 3,
    "fri": 4,
    "sat": 5,
    "sun": 6,
}
MIDWEEK_WEEKDAYS = {0, 1, 2, 3}
MAIN_PRIORITY = {
    "Alkohol": 100,
    "Fleisch & Wurst": 90,
    "Fisch & Meeresfrüchte": 89,
    "Gewürze/Saucen/Aufstriche": 80,
    "Backwaren": 70,
    "Milchprodukte & Eier": 60,
    "Tiefkühl": 58,
    "Obst & Gemüse": 50,
    "Süßwaren & Snacks": 40,
    "Grundnahrungsmittel": 30,
    "Feinkost & Kühlung": 25,
    "Konserven & Fertiggerichte": 24,
    "Getränke alkoholfrei": 20,
    "Non-Food": 10,
}
SONSTIGES_HINTS = {"sonstiges", "misc", "other"}
FOOD_RESCUE_BLOCKERS = {
    "shampoo",
    "zahnpasta",
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
    "klarspüler",
    "klarspuler",
    "maschinenpfleger",
    "finish klarspueler",
    "finish klarspüler",
    "finish klarspuler",
    "finish maschinenpfleger",
    "finish powerball",
    "finish ultimate",
    "spuelmittel",
    "spülmittel",
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
    "müllbeutel",
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
    "kerzen",
    "duenger",
    "dünger",
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
    "gemueseschneider",
    "gemüseschneider",
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
    "thermogläser",
    "thermoglaser",
    "trinkglaeser",
    "trinkgläser",
    "trinkglaser",
    "smoothie maker",
    "koffer",
    "smoker box",
    "smokerbox",
    "raeucherbox",
    "räucherbox",
    "hundenahrung",
    "katzenfutter",
    "katzen snacks",
    "katzen-snacks",
    "katzensnacks",
    "klumpstreu",
    "ultra klumpstreu",
    "vitakraft",
    "wasserglaeser",
    "wassergläser",
    "glas set",
    "glaeser set",
}
FOOD_RESCUE_DRINK_RULES: list[tuple[str, tuple[str, ...]]] = [
    ("Mate", ("mio mio", "mate")),
    ("Energy", ("gonrgy", "gönrgy", "goenrgy", "energy drink", "energydrink", "energy")),
    ("Wasser", ("mineralwasser", "wasser")),
    ("Säfte", ("direktsaft", "nektar", "saft")),
    ("Kaffee & Tee", ("espresso", "kaffee", "tee")),
    ("Softdrinks", ("soft drink", "softdrink", "cola", "limonade", "limo", "drink")),
]
FOOD_RESCUE_DAIRY_RULES: list[tuple[str, tuple[str, ...]]] = [
    ("Milchalternativen", ("not mlk", "not m lk", "haferdrink", "mandeldrink", "sojadrink", "pflanzendrink")),
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

ProgressCallback = Callable[[dict[str, Any]], None]

FIELD_ALIASES: dict[str, list[str]] = {
    "title": ["title", "name", "productName", "product", "product_title", "offerTitle"],
    "brand": ["brand", "brandName", "manufacturer"],
    "category": ["sourceCategoryRaw", "category", "sourceCategory", "warengruppe", "department", "departmentName"],
    "department": ["sourceDepartmentRaw", "department", "departmentName", "warengruppe", "category"],
    "chain": ["chain", "storeChain", "retailer", "retailerName", "store", "market"],
    "price": ["price", "offerPrice", "currentPrice", "salesPrice", "discountPrice"],
    "unit": ["unit", "size", "packageSize", "content", "quantity"],
    "validity_start": ["validityStart", "validFrom", "startDate", "start", "from"],
    "validity_end": ["validityEnd", "validTo", "endDate", "end", "to"],
    "gtin": ["gtin", "ean", "barcode", "upc"],
    "ean": ["ean", "gtin", "barcode", "upc"],
    "snapshot": ["postalCode", "postal", "plz", "zip", "region", "area", "snapshotId"],
    "id": ["id", "offerId"],
    "tags": ["tags", "tag", "labels", "badges", "flags", "attributes"],
    "ingredients": ["ingredients", "ingredientsText", "ingredients_text", "ingredientText", "zutaten"],
}


def text_normalize(value: Any) -> str:
    if value is None:
        return ""

    text = str(value).strip().lower()
    replacements = {
        "ä": "ae",
        "ö": "oe",
        "ü": "ue",
        "ß": "ss",
    }
    for src, dst in replacements.items():
        text = text.replace(src, dst)

    text = unicodedata.normalize("NFKD", text)
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def parse_price(value: Any) -> float | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)

    text = str(value)
    text = text.replace("EUR", "").replace("€", "")
    text = text.replace(" ", "")
    if "," in text and "." not in text:
        text = text.replace(",", ".")
    text = re.sub(r"[^0-9.\-]", "", text)
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def parse_datetime_berlin(value: Any, *, date_only_as_end: bool = False) -> datetime | None:
    if value is None:
        return None

    if isinstance(value, (int, float)):
        ts = float(value)
        if ts > 1_000_000_000_000:
            ts /= 1000.0
        return datetime.fromtimestamp(ts, tz=timezone.utc).astimezone(BERLIN_TZ)

    raw = str(value).strip()
    if not raw:
        return None

    candidates = [raw]
    if raw.endswith("Z"):
        candidates.append(raw[:-1] + "+00:00")

    has_explicit_time = bool(re.search(r"\d{1,2}:\d{2}", raw))

    for candidate in candidates:
        try:
            dt = datetime.fromisoformat(candidate)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=BERLIN_TZ)
            else:
                dt = dt.astimezone(BERLIN_TZ)
            if date_only_as_end and not has_explicit_time:
                dt = dt.replace(hour=23, minute=59, second=59, microsecond=999999)
            return dt
        except ValueError:
            continue

    for fmt in ("%Y-%m-%d", "%d.%m.%Y", "%d.%m.%Y %H:%M"):
        try:
            dt = datetime.strptime(raw, fmt).replace(tzinfo=BERLIN_TZ)
            if date_only_as_end and fmt in {"%Y-%m-%d", "%d.%m.%Y"}:
                dt = dt.replace(hour=23, minute=59, second=59, microsecond=999999)
            return dt
        except ValueError:
            continue

    return None


def parse_week_start(value: str | None) -> datetime | None:
    if not value:
        return None
    parsed = parse_datetime_berlin(value)
    if parsed is None:
        return None
    return parsed.replace(hour=0, minute=0, second=0, microsecond=0)


def resolve_week_end_day(week_window: str, week_end_day: str | None) -> int:
    if week_end_day:
        key = week_end_day.strip().lower()
        if key not in WEEKDAY_ALIASES:
            raise ValueError(f"Unsupported week-end-day: {week_end_day}")
        return WEEKDAY_ALIASES[key]
    if week_window == "retail":
        return WEEKDAY_ALIASES["sat"]
    return WEEKDAY_ALIASES["sun"]


def week_window(
    reference: datetime | None = None,
    week_start_override: datetime | None = None,
    *,
    week_window_mode: str = "calendar",
    week_end_day: str | None = None,
) -> tuple[datetime, datetime]:
    if week_window_mode not in SUPPORTED_WEEK_WINDOWS:
        raise ValueError(f"Unsupported week-window: {week_window_mode}")
    if week_start_override is not None:
        start = week_start_override
    else:
        current = reference.astimezone(BERLIN_TZ) if reference else datetime.now(BERLIN_TZ)
        start = (current - timedelta(days=current.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)
    end_day_index = resolve_week_end_day(week_window_mode, week_end_day)
    end = start + timedelta(days=end_day_index + 1) - timedelta(microseconds=1)
    return start, end


def deep_find_value(record: Any, aliases: list[str]) -> Any:
    if not isinstance(record, dict):
        return None

    lower_keys = {str(key).lower(): key for key in record.keys()}

    for alias in aliases:
        if alias in record and record[alias] is not None:
            return record[alias]
        key = lower_keys.get(alias.lower())
        if key is not None and record.get(key) is not None:
            return record[key]

    for value in record.values():
        if isinstance(value, dict):
            nested = deep_find_value(value, aliases)
            if nested is not None:
                return nested

    return None


def extract_offer_records(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [entry for entry in payload if isinstance(entry, dict)]

    if not isinstance(payload, dict):
        return []

    candidates: list[dict[str, Any]] = []
    preferred = [
        "offers",
        "liveOffers",
        "items",
        "results",
        "products",
        "data",
        "entries",
    ]

    for key in preferred:
        value = payload.get(key)
        if isinstance(value, list):
            candidates.extend(entry for entry in value if isinstance(entry, dict))

    if candidates:
        return candidates

    for key, value in payload.items():
        if str(key).lower() in {"filteredoffers", "summary", "metadata"}:
            continue
        if isinstance(value, list) and value and isinstance(value[0], dict):
            candidates.extend(entry for entry in value if isinstance(entry, dict))

    return candidates


def keyword_match(keyword: str, normalized_text: str, token_set: set[str]) -> bool:
    if not keyword:
        return False

    key = text_normalize(keyword)
    if not key:
        return False

    if " " in key:
        pattern = r"(?<![a-z0-9])" + re.escape(key) + r"(?![a-z0-9])"
        return re.search(pattern, normalized_text) is not None
    return key in token_set


def keyword_hits(
    keywords: tuple[str, ...] | list[str] | set[str],
    normalized_text: str,
    token_set: set[str],
) -> list[str]:
    hits: list[str] = []
    for keyword in keywords:
        normalized = text_normalize(keyword)
        if normalized and keyword_match(normalized, normalized_text, token_set):
            hits.append(normalized)
    return dedupe_list(hits)


# Vertrauenswürdige, eindeutige Quellabteilungen → kanonische Hauptkategorie
# (Task P3). Reines Abteilungs-Vokabular, KEINE Produkt-/Marken-Allowlist. Diese
# Abteilungen gewinnen gegen schwache Name-/Keyword-Signale: "Iglo Tagliatelle"
# in der Abteilung Tiefkühl bleibt Tiefkühl (nicht Grundnahrungsmittel), "…
# Qualitätswein" in "Wein und Spirituosen" bleibt Alkohol (nicht Süßwaren).
TRUSTED_SOURCE_DEPARTMENT_RULES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("Tiefkühl", ("tiefkuehl", "tiefkuhl", "tiefgekuehlt", "frozen", "gefroren")),
    ("Alkohol", ("spirituosen", "wein", "bier", "sekt", "schnaps", "aperitif", "longdrink")),
    ("Obst & Gemüse", ("obst", "gemuese", "gemuse")),
)

# Eindeutige Non-Food-Abteilungswörter: eine solche Abteilung erzwingt nie eine
# Food-Kategorie (gespiegelt zur Veto-Liste im Strict-Food-Filter / TS-Bridge).
NON_FOOD_DEPARTMENT_VETO: tuple[str, ...] = (
    "drogerie", "haushalt", "koerperpflege", "kosmetik", "hygiene", "tierbedarf",
    "tiernahrung", "garten", "technik", "elektro", "textil", "bekleidung",
    "spielware", "non-food", "nonfood", "freizeit",
)


def trusted_source_department_main(source_text_norm: str) -> str | None:
    """Finale kanonische Hauptkategorie aus einer VERTRAUENSWÜRDIGEN, eindeutigen
    Quellabteilung — oder None, wenn die Abteilung neutral, gemischt, leer,
    Non-Food oder nicht eindeutig zuordenbar ist. `source_text_norm` ist bereits
    text_normalize'd (klein, Umlaute gefaltet)."""
    raw = (source_text_norm or "").strip()
    if not raw:
        return None
    if any(veto in raw for veto in NON_FOOD_DEPARTMENT_VETO):
        return None
    for main, keywords in TRUSTED_SOURCE_DEPARTMENT_RULES:
        if main == "Alkohol" and "alkoholfrei" in raw:
            continue
        if any(keyword in raw for keyword in keywords):
            return main
    return None


def detect_food_rescue_category(
    normalized_text: str,
    token_set: set[str],
) -> tuple[str, str, list[str]] | None:
    blockers = keyword_hits(FOOD_RESCUE_BLOCKERS, normalized_text, token_set)
    if blockers:
        return None

    # Alcohol SOURCE context (department "Wein und Spirituosen"/"Spirituosen")
    # plus a clearly alcoholic drink type (Longdrink/Cocktail/Aperitif) must be
    # Alkohol, never a soft drink — the department is a hard alcohol signal that
    # the generic 'drink' rescue would otherwise overrule (P3). Department-driven,
    # no brand list.
    alcohol_context = (
        any(keyword_match(word, normalized_text, token_set) for word in ("spirituosen", "spirituose", "schnaps"))
        or "wein und spirituosen" in normalized_text
        or "wein spirituosen" in normalized_text
    )
    alcohol_drink_type = any(
        keyword_match(word, normalized_text, token_set)
        for word in ("longdrink", "cocktail", "aperitif", "aperitivo")
    )
    if alcohol_context and alcohol_drink_type:
        return "Alkohol", "Spirituosen", ["rescue_kw:spirituosen", "rescue:alcohol_context"]

    for sub, keywords in FOOD_RESCUE_DAIRY_RULES:
        hits = keyword_hits(keywords, normalized_text, token_set)
        if hits:
            reasons = [f"rescue_kw:{keyword}" for keyword in hits[:4]]
            reasons.append("rescue:dairy")
            return "Milchprodukte & Eier", sub, dedupe_list(reasons)

    for sub, keywords in FOOD_RESCUE_ALCOHOL_RULES:
        hits = keyword_hits(keywords, normalized_text, token_set)
        if hits:
            reasons = [f"rescue_kw:{keyword}" for keyword in hits[:4]]
            reasons.append("rescue:alcohol")
            return "Alkohol", sub, dedupe_list(reasons)

    for sub, keywords in FOOD_RESCUE_DRINK_RULES:
        hits = keyword_hits(keywords, normalized_text, token_set)
        if hits:
            reasons = [f"rescue_kw:{keyword}" for keyword in hits[:4]]
            reasons.append("rescue:drinks")
            return "Getränke alkoholfrei", sub, dedupe_list(reasons)

    for sub, keywords in FOOD_RESCUE_SNACK_RULES:
        hits = keyword_hits(keywords, normalized_text, token_set)
        if hits:
            reasons = [f"rescue_kw:{keyword}" for keyword in hits[:4]]
            reasons.append("rescue:snacks")
            return "Süßwaren & Snacks", sub, dedupe_list(reasons)

    ready_hits = keyword_hits(FOOD_RESCUE_READY_HINTS, normalized_text, token_set)
    if ready_hits:
        reasons = [f"rescue_kw:{keyword}" for keyword in ready_hits[:4]]
        reasons.append("rescue:ready_hint")
        return "Konserven & Fertiggerichte", "Fertiggerichte", dedupe_list(reasons)

    return None


@dataclass
class Taxonomy:
    main_categories: list[str]
    subcategories: dict[str, list[str]]
    keywords: dict[str, dict[str, list[str]]]
    negative_keywords: dict[str, list[str]]
    source_category_map: dict[str, dict[str, str]]
    conflict_rules: list[dict[str, Any]]
    secondary_score_ratio: float

    main_set: set[str] = field(default_factory=set)
    sub_set_map: dict[str, set[str]] = field(default_factory=dict)

    def __post_init__(self) -> None:
        self.main_set = set(self.main_categories)
        self.sub_set_map = {
            main: set(subs)
            for main, subs in self.subcategories.items()
        }


def taxonomy_cache_signature(taxonomy: "Taxonomy") -> str:
    """Stable signature of every taxonomy input that may affect a verdict."""
    payload = {
        "main_categories": taxonomy.main_categories,
        "subcategories": taxonomy.subcategories,
        "keywords": taxonomy.keywords,
        "negative_keywords": taxonomy.negative_keywords,
        "source_category_map": taxonomy.source_category_map,
        "conflict_rules": taxonomy.conflict_rules,
        "secondary_score_ratio": taxonomy.secondary_score_ratio,
    }
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha1(encoded.encode("utf-8")).hexdigest()


def load_taxonomy(path: Path) -> Taxonomy:
    text = path.read_text(encoding="utf-8-sig")

    payload: dict[str, Any]
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        try:
            import yaml  # type: ignore
        except ModuleNotFoundError as exc:
            raise RuntimeError(
                "taxonomy.yaml konnte nicht als JSON gelesen werden und PyYAML ist nicht installiert."
            ) from exc
        parsed = yaml.safe_load(text)
        if not isinstance(parsed, dict):
            raise RuntimeError("taxonomy.yaml hat kein gueltiges Mapping-Format.")
        payload = parsed

    main_categories = [str(x) for x in payload.get("main_categories", [])]
    subcategories = {
        str(main): [str(sub) for sub in subs]
        for main, subs in (payload.get("subcategories", {}) or {}).items()
    }
    keywords = {
        str(main): {
            str(sub): [str(k) for k in kw]
            for sub, kw in (sub_map or {}).items()
        }
        for main, sub_map in (payload.get("keywords", {}) or {}).items()
    }
    negative_keywords = {
        str(sub): [str(k) for k in kws]
        for sub, kws in (payload.get("negative_keywords", {}) or {}).items()
    }
    source_category_map = {
        text_normalize(key): {
            "main": str(value.get("main", "")).strip(),
            "sub": str(value.get("sub", "unknown")).strip() or "unknown",
        }
        for key, value in (payload.get("source_category_map", {}) or {}).items()
        if isinstance(value, dict)
    }
    conflict_rules = [
        rule
        for rule in (payload.get("conflict_rules", []) or [])
        if isinstance(rule, dict)
    ]
    secondary_score_ratio = float(payload.get("secondary_score_ratio", 0.65))

    if not main_categories:
        raise RuntimeError("taxonomy.yaml enthaelt keine main_categories.")

    for main in main_categories:
        if main not in subcategories:
            subcategories[main] = ["unknown"]
        if "unknown" not in subcategories[main]:
            subcategories[main].append("unknown")

    return Taxonomy(
        main_categories=main_categories,
        subcategories=subcategories,
        keywords=keywords,
        negative_keywords=negative_keywords,
        source_category_map=source_category_map,
        conflict_rules=conflict_rules,
        secondary_score_ratio=secondary_score_ratio,
    )


@dataclass
class OfferRecord:
    fingerprint: str
    raw_offer: dict[str, Any]
    title: str
    title_norm: str
    brand: str
    brand_norm: str
    source_category: str
    source_category_norm: str
    source_department: str
    source_department_norm: str
    chain: str
    chain_norm: str
    size_or_unit: str
    price: float | None
    validity_start: datetime | None
    validity_end: datetime | None
    validity_start_raw: str
    validity_end_raw: str
    gtin_or_ean: str
    tags: list[str]
    tags_norm: list[str]
    ingredients_text: str
    ingredients_norm: str
    source_file: str
    snapshot_id: str


def default_halal_annotation() -> dict[str, Any]:
    return {"status": "unknown", "confidence": 0.35, "reasons": ["rule:insufficient_data"]}


@dataclass
class CanonicalCategory:
    main: str
    sub: str
    secondary: list[str]
    is_non_food: bool
    confidence: float
    reasons: list[str]
    halal: dict[str, Any] = field(default_factory=default_halal_annotation)

    def to_output(self) -> dict[str, Any]:
        return {
            "main": self.main,
            "sub": self.sub,
            "secondary": self.secondary,
            "isNonFood": self.is_non_food,
            "confidence": round(max(0.0, min(1.0, self.confidence)), 4),
            "reasons": self.reasons,
            "halal": self.halal,
        }


@dataclass
class ClassificationResult:
    category: CanonicalCategory
    needs_llm: bool = False


@dataclass
class ProcessedOffer:
    offer: OfferRecord
    canonical: CanonicalCategory
    week_flags: dict[str, bool]
    review_needed: bool
    review_reason: str
    overridden: bool
    override_reasons: list[str]
    suspects: list[str]
    score_debug: dict[str, float]


def dedupe_list(values: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        result.append(value)
    return result

class RuleClassifier:
    def __init__(self, taxonomy: Taxonomy, min_rule_score: float) -> None:
        self.taxonomy = taxonomy
        self.min_rule_score = min_rule_score

        self.nonfood_keyword_index: list[tuple[str, str]] = []
        for sub, keywords in taxonomy.negative_keywords.items():
            for keyword in keywords:
                normalized = text_normalize(keyword)
                if normalized:
                    self.nonfood_keyword_index.append((sub, normalized))

        self.keyword_index: list[tuple[str, str, str]] = []
        for main, sub_map in taxonomy.keywords.items():
            for sub, keywords in sub_map.items():
                for keyword in keywords:
                    normalized = text_normalize(keyword)
                    if normalized:
                        self.keyword_index.append((main, sub, normalized))

    def _source_mapping(self, offer: OfferRecord) -> tuple[str, str] | None:
        source_text = " ".join(
            [offer.source_category_norm, offer.source_department_norm]
        ).strip()
        if not source_text:
            return None

        for key, mapping in self.taxonomy.source_category_map.items():
            if key and key in source_text:
                main = mapping.get("main", "")
                sub = mapping.get("sub", "unknown")
                if main in self.taxonomy.main_set:
                    if sub not in self.taxonomy.sub_set_map.get(main, set()):
                        sub = "unknown"
                    return (main, sub)
        return None

    def classify(self, offer: OfferRecord) -> ClassificationResult:
        body = " ".join(
            [
                offer.title_norm,
                offer.brand_norm,
                offer.source_category_norm,
                offer.source_department_norm,
            ]
        ).strip()
        tokens = set(body.split())
        source_is_sonstiges = any(
            hint in offer.source_category_norm for hint in SONSTIGES_HINTS
        )

        # Der PRODUKTNAME (Titel + Marke) und die HÄNDLER-ABTEILUNG sind zwei
        # verschieden starke Belege und werden deshalb getrennt gematcht.
        # Eine Abteilung ist eine Regalzuordnung, keine Warenart: Kaufland führt
        # Sportnahrung, Proteinriegel und Säuglingsmilch in der KOMBINIERTEN
        # Abteilung "Drogerie, Tiernahrung". Bis 2026-08-17 lief das
        # Keyword-Matching auf dem zusammengesetzten `body`, deshalb bekam JEDES
        # der 47 Angebote dieser Abteilung `nonfood_kw:tiernahrung` mit
        # Konfidenz 0.99 und needs_llm=False — auch "ESN Isoclear Whey-Protein",
        # "KORO Proteinriegel" und "APTAMIL Folgemilch 2 oder 3".
        name_body = " ".join([offer.title_norm, offer.brand_norm]).strip()
        name_tokens = set(name_body.split())

        rescue_category = detect_food_rescue_category(body, tokens)
        if rescue_category is not None:
            main, sub, rescue_reasons = rescue_category
            if sub not in self.taxonomy.sub_set_map.get(main, set()):
                sub = "unknown"
            return ClassificationResult(
                category=CanonicalCategory(
                    main=main,
                    sub=sub,
                    secondary=[],
                    is_non_food=False,
                    confidence=0.93,
                    reasons=rescue_reasons,
                ),
                needs_llm=False,
            )

        nonfood_hits: list[tuple[str, str]] = []
        nonfood_source_only_hits: list[tuple[str, str]] = []
        for sub, keyword in self.nonfood_keyword_index:
            if keyword_match(keyword, name_body, name_tokens):
                nonfood_hits.append((sub, keyword))
            elif keyword_match(keyword, body, tokens):
                nonfood_source_only_hits.append((sub, keyword))

        if nonfood_hits:
            nonfood_hits.sort(key=lambda item: len(item[1]), reverse=True)
            sub = nonfood_hits[0][0]
            reasons = [f"nonfood_kw:{keyword}" for _, keyword in nonfood_hits[:4]]
            category = CanonicalCategory(
                main="Non-Food",
                sub=sub if sub in self.taxonomy.sub_set_map["Non-Food"] else "unknown",
                secondary=[],
                is_non_food=True,
                confidence=0.99,
                reasons=reasons,
            )
            return ClassificationResult(category=category, needs_llm=False)

        if nonfood_source_only_hits:
            # Nur die ABTEILUNG nennt ein Non-Food-Wort. Das bleibt ein starker
            # Hinweis (die Abteilung ist meistens richtig), aber KEIN
            # abschließendes 0.99-Urteil: die Zuordnung wird als
            # `nonfood_department_hint:` protokolliert und mit needs_llm=True an
            # die KI weitergegeben, die den Produktnamen prüft. Der TS-Gate wertet
            # `nonfood_kw:`-Belege nur noch, wenn das Keyword im Namen steht —
            # so kann eine gemischte Abteilung kein Lebensmittel mehr hart
            # ausfiltern.
            nonfood_source_only_hits.sort(key=lambda item: len(item[1]), reverse=True)
            sub = nonfood_source_only_hits[0][0]
            reasons = [
                f"nonfood_department_hint:{keyword}"
                for _, keyword in nonfood_source_only_hits[:4]
            ]
            category = CanonicalCategory(
                main="Non-Food",
                sub=sub if sub in self.taxonomy.sub_set_map["Non-Food"] else "unknown",
                secondary=[],
                is_non_food=True,
                confidence=0.7,
                reasons=reasons,
            )
            return ClassificationResult(category=category, needs_llm=True)

        score_map: dict[tuple[str, str], float] = {}
        reason_map: dict[tuple[str, str], list[str]] = {}

        for main, sub, keyword in self.keyword_index:
            if keyword_match(keyword, body, tokens):
                weight = 2.3 if " " in keyword else 1.8
                score_map[(main, sub)] = score_map.get((main, sub), 0.0) + weight
                reason_map.setdefault((main, sub), []).append(f"kw:{keyword}")

        source_map = self._source_mapping(offer)
        if source_map is not None:
            source_main, source_sub = source_map
            if not (source_is_sonstiges and source_main == "Non-Food"):
                source_weight = 0.35 if source_is_sonstiges else 1.3
                key = (source_main, source_sub)
                score_map[key] = score_map.get(key, 0.0) + source_weight
                reason = "source_map_hint" if source_is_sonstiges else "source_map"
                reason_map.setdefault(key, []).append(reason)

        if not score_map:
            fallback = CanonicalCategory(
                main="Grundnahrungsmittel",
                sub="unknown",
                secondary=[],
                is_non_food=False,
                confidence=0.42,
                reasons=["rule:no_match"],
            )
            needs_llm = True
            return ClassificationResult(category=fallback, needs_llm=needs_llm)

        ranked = sorted(
            score_map.items(),
            key=lambda item: (
                item[1],
                MAIN_PRIORITY.get(item[0][0], 0),
                len(reason_map.get(item[0], [])),
            ),
            reverse=True,
        )
        (best_main, best_sub), best_score = ranked[0]
        second_score = ranked[1][1] if len(ranked) > 1 else 0.0
        margin = best_score - second_score
        best_reason_count = len(reason_map.get((best_main, best_sub), []))
        conflict_penalty = 0.0

        secondary: list[str] = []
        ratio_limit = best_score * self.taxonomy.secondary_score_ratio
        for (main, sub), score in ranked[1:4]:
            if score >= ratio_limit and main != best_main:
                secondary.append(f"{main}/{sub}")

        reasons = reason_map.get((best_main, best_sub), []).copy()
        if len(ranked) > 1:
            (second_main, second_sub), second_score = ranked[1]
            if second_main != best_main and second_score >= best_score - 0.6:
                reasons.append("repair:priority_conflict")
                reasons.append(f"conflict_alt:{second_main}/{second_sub}")
                conflict_penalty = 0.06

        for rule in self.taxonomy.conflict_rules:
            if_any = [text_normalize(x) for x in (rule.get("if_any") or [])]
            if not if_any:
                continue
            if not any(keyword_match(x, body, tokens) for x in if_any):
                continue

            when_main_raw = rule.get("when_main", "")
            when_main_values: list[str] = []
            if isinstance(when_main_raw, list):
                when_main_values = [str(item).strip() for item in when_main_raw if str(item).strip()]
            else:
                as_text = str(when_main_raw).strip()
                if as_text:
                    when_main_values = [as_text]
            if when_main_values and best_main not in when_main_values:
                continue

            force = rule.get("force") or {}
            force_main = str(force.get("main", "")).strip()
            force_sub = str(force.get("sub", "unknown")).strip() or "unknown"
            if force_main in self.taxonomy.main_set:
                if force_sub not in self.taxonomy.sub_set_map.get(force_main, set()):
                    force_sub = "unknown"
                best_main = force_main
                best_sub = force_sub
                reasons.append(str(rule.get("reason", "override:rule")))
                best_score += 0.8
                margin = max(margin, 1.0)
                best_reason_count = len(reason_map.get((best_main, best_sub), []))

        # Quellenpriorität (Task P3): eine VERTRAUENSWÜRDIGE, eindeutige
        # Quellabteilung gewinnt gegen schwache Name-/Keyword-Signale. Non-Food
        # wurde oben bereits kurzgeschlossen, daher hier nie ein Non-Food-Main zu
        # Food umdeuten. Der Sub fällt auf "unknown" zurück (wie source_map).
        source_dept_text = " ".join(
            [offer.source_category_norm, offer.source_department_norm]
        ).strip()
        trusted_main = trusted_source_department_main(source_dept_text)
        if trusted_main is not None and best_main != "Non-Food" and trusted_main != best_main:
            best_main = trusted_main
            best_sub = "unknown"
            reasons.append("override:trusted_source_department")
            best_score = max(best_score, self.min_rule_score + 1.0)
            margin = max(margin, 1.0)
            best_reason_count = len(reason_map.get((best_main, best_sub), []))

        if best_score >= self.min_rule_score and margin >= 1.0:
            reason_bonus = min(0.08, max(0, best_reason_count - 1) * 0.02)
            confidence = min(0.96, 0.84 + (best_score - self.min_rule_score) * 0.03 + reason_bonus)
            needs_llm = False
        else:
            confidence = min(0.78, 0.55 + best_score * 0.05)
            needs_llm = True
        confidence = max(0.0, confidence - conflict_penalty)

        if source_is_sonstiges:
            needs_llm = True
            reasons.append("source:sonstiges")

        category = CanonicalCategory(
            main=best_main,
            sub=best_sub,
            secondary=secondary,
            is_non_food=(best_main == "Non-Food"),
            confidence=confidence,
            reasons=dedupe_list(reasons),
        )
        return ClassificationResult(category=category, needs_llm=needs_llm)


class OllamaCache:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._cache: dict[str, dict[str, Any]] = {}
        if path.exists():
            for line in path.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    payload = json.loads(line)
                except json.JSONDecodeError:
                    continue
                # Only trust entries written by the CURRENT classifier schema.
                # Old entries (no version → the format:"json" era that produced
                # garbage) are ignored so a new scan never reuses them as KI.
                if str(payload.get("classifierSchemaVersion", "")) != CLASSIFIER_SCHEMA_VERSION:
                    continue
                key = str(payload.get("fingerprint", "")).strip()
                value = payload.get("result")
                if key and isinstance(value, dict):
                    self._cache[key] = value

    def get(self, fingerprint: str) -> dict[str, Any] | None:
        return self._cache.get(fingerprint)

    def set(self, fingerprint: str, result: dict[str, Any]) -> None:
        self._cache[fingerprint] = result
        entry = {
            "fingerprint": fingerprint,
            "result": result,
            "classifierSchemaVersion": CLASSIFIER_SCHEMA_VERSION,
            "cachedAt": datetime.now(timezone.utc).isoformat(),
        }
        with self.path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry, ensure_ascii=False) + "\n")

class OllamaRequestError(RuntimeError):
    """A single Ollama request failed at the transport level (timeout, refused
    connection, HTTP 5xx). Distinct from a malformed/invalid JSON answer, which
    is a soft failure that should NOT trip the fail-fast counter."""


class OllamaFailFastError(RuntimeError):
    """Raised once Ollama has failed `max_consecutive_failures` times in a row.
    Aborts the whole pipeline so a dead/500-ing Ollama can't make a run crawl
    through thousands of offers (each waiting out the per-request timeout)."""


def normalize_ollama_host(host: str) -> str:
    """Zieht einen `localhost`-Host hart auf IPv4.

    Auf Windows loest urllib `localhost` zuerst nach ::1 auf, wartet dort den
    Connect-Timeout ab und faellt erst danach auf IPv4 zurueck — Ollama lauscht
    aber nur auf 127.0.0.1. Gemessen: 2,042 s pro Request ueber `localhost`
    gegen 0,017 s ueber `127.0.0.1`. Bei rund 1.600 Klassifizierungen je Scan
    sind das ~54 Minuten reine Wartezeit, deshalb die Korrektur hier statt in
    der Konfiguration: sie greift unabhaengig davon, ob der Host aus .env, dem
    CLI-Default oder der Bridge kommt.
    """
    cleaned = (host or "").strip().rstrip("/")
    if not cleaned:
        return cleaned
    parsed = urllib.parse.urlsplit(cleaned)
    if parsed.hostname != "localhost":
        return cleaned
    userinfo = parsed.netloc.rsplit("@", 1)[0] + "@" if "@" in parsed.netloc else ""
    port = f":{parsed.port}" if parsed.port else ""
    return urllib.parse.urlunsplit(
        (parsed.scheme, f"{userinfo}127.0.0.1{port}", parsed.path, parsed.query, parsed.fragment)
    )


class LLMClassifier:
    def __init__(
        self,
        taxonomy: Taxonomy,
        *,
        enabled: bool,
        host: str,
        model: str,
        cache_path: Path,
        use_llm_threshold: float,
        timeout_seconds: int = 35,
        max_consecutive_failures: int = 0,
        item_retries: int = 0,
        num_predict: int = 256,
    ) -> None:
        self.taxonomy = taxonomy
        self.enabled = enabled
        self.host = normalize_ollama_host(host)
        self.model = model
        self.taxonomy_signature = taxonomy_cache_signature(taxonomy)
        self.timeout_seconds = timeout_seconds
        self.use_llm_threshold = use_llm_threshold
        # 0 disables the fail-fast guard (legacy behaviour). >0 means: after that
        # many consecutive transport failures, run a HEALTH CHECK — only abort if
        # Ollama is genuinely down / the model is no longer loaded. A loaded-but-
        # slow model must not kill the whole run; those items become reviewNeeded.
        self.max_consecutive_failures = max(0, int(max_consecutive_failures))
        # Extra attempts for a SINGLE timed-out item before giving up on it (0 =
        # one attempt, no retry). Kept low: a slow model is better served by a
        # higher per-request timeout than by re-running the same slow request.
        self.item_retries = max(0, int(item_retries))
        # Cap generated tokens so a chatty/thinking model can't run away. The
        # category JSON is tiny; 256 tokens is ample.
        self.num_predict = max(16, int(num_predict))
        self.consecutive_failures = 0
        self.cache = OllamaCache(cache_path)
        # Per-run diagnostics surfaced to the bridge/status (not just logs).
        self.classified_count = 0
        self.timeout_count = 0
        self.invalid_count = 0
        self.cache_hit_count = 0
        # Outcome of the most recent classify() call so the caller can mark the
        # offer: one of cache|classified|invalid|timeout|disabled.
        self.last_outcome = "idle"
        self.last_error = ""
        self.last_timeout_offer = ""

    def should_use(self, rule: ClassificationResult) -> bool:
        if not self.enabled:
            return False
        if rule.needs_llm:
            return True
        return rule.category.confidence < self.use_llm_threshold

    def _model_matches(self, name: str) -> bool:
        want = self.model.strip().lower()
        have = str(name or "").strip().lower()
        if not want or not have:
            return False
        if have == want:
            return True
        # "qwen3" matches "qwen3:14b"; "qwen3:14b" tolerates a quant suffix.
        if ":" not in want and have.split(":")[0] == want:
            return True
        return have.startswith(f"{want}-")

    def ollama_healthy(self) -> bool:
        """Best-effort health probe used to decide whether a streak of timeouts is
        a DEAD Ollama (abort) or just a slow-but-loaded model (keep going).
        Healthy = /api/ps is reachable AND the configured model is loaded. Any
        error / model-not-loaded counts as unhealthy."""
        try:
            req = urllib.request.Request(url=f"{self.host}/api/ps", method="GET")
            with urllib.request.urlopen(req, timeout=min(10, max(3, self.timeout_seconds))) as resp:
                raw = resp.read().decode("utf-8", errors="replace")
            data = json.loads(raw)
        except Exception:
            return False
        models = data.get("models") if isinstance(data, dict) else None
        if not isinstance(models, list):
            return False
        for entry in models:
            if not isinstance(entry, dict):
                continue
            name = entry.get("name") or entry.get("model") or ""
            if self._model_matches(str(name)):
                return True
        return False

    def classify(self, offer: OfferRecord) -> CanonicalCategory | None:
        if not self.enabled:
            self.last_outcome = "disabled"
            return None

        cache_key = classification_cache_key(
            offer,
            model=self.model,
            taxonomy_signature=self.taxonomy_signature,
        )
        cached = self.cache.get(cache_key)
        if cached:
            validated = self._validate(cached)
            if validated is not None:
                validated.reasons.append("cache:hit")
                validated.reasons = dedupe_list(validated.reasons)
                self.cache_hit_count += 1
                self.last_outcome = "cache"
                return validated

        # Try the item up to (1 + item_retries) times for transport failures.
        payload: dict[str, Any] | None = None
        last_exc: OllamaRequestError | None = None
        for _attempt in range(self.item_retries + 1):
            try:
                payload = self._request_ollama(offer)
                last_exc = None
                break
            except OllamaRequestError as exc:
                last_exc = exc

        if last_exc is not None:
            # Every attempt for THIS item failed at transport level (timeout /
            # refused / 5xx). This is a per-item failure, NOT automatically a
            # run-ending one.
            self.consecutive_failures += 1
            self.timeout_count += 1
            self.last_outcome = "timeout"
            self.last_error = str(last_exc)
            self.last_timeout_offer = getattr(offer, "title", "") or getattr(offer, "fingerprint", "")
            if (
                self.max_consecutive_failures > 0
                and self.consecutive_failures >= self.max_consecutive_failures
            ):
                # Only abort if Ollama is actually down / the model is gone. A
                # loaded model that is merely slow keeps running; the offending
                # items are skipped (reviewNeeded: ai_timeout).
                if not self.ollama_healthy():
                    raise OllamaFailFastError(
                        f"KI-Lauf abgebrochen: Ollama nicht erreichbar oder Modell "
                        f"'{self.model}' nicht geladen — {self.consecutive_failures} "
                        f"Fehler in Folge (zuletzt: {last_exc})."
                    ) from last_exc
                # Healthy → slow items, not a dead Ollama. Reset the streak and
                # carry on so a few hard products can't abort the whole run.
                self.consecutive_failures = 0
            return None

        # A successful transport response (even if the JSON is later rejected as
        # invalid) means Ollama is alive — reset the consecutive-failure streak.
        self.consecutive_failures = 0
        if payload is None:
            self.invalid_count += 1
            self.last_outcome = "invalid"
            return None

        validated = self._validate(payload)
        if validated is None:
            self.invalid_count += 1
            self.last_outcome = "invalid"
            return None

        self.cache.set(cache_key, validated.to_output())
        validated.reasons.append("llm")
        validated.reasons = dedupe_list(validated.reasons)
        self.classified_count += 1
        self.last_outcome = "classified"
        return validated

    def _request_ollama(self, offer: OfferRecord) -> dict[str, Any] | None:
        taxonomy_brief = {
            "main_categories": self.taxonomy.main_categories,
            "subcategories": self.taxonomy.subcategories,
        }

        # Structured Outputs: the JSON Schema (with main/sub ENUMS) is passed as
        # `format`, which constrains the model to valid categories — far more
        # reliable for a local 14B than a free `format:"json"`.
        schema = build_category_schema(self.taxonomy)

        # Der Non-Food-Teil des Prompts entstand aus konkreten Fehlurteilen des
        # Laufs 2026-08-17. Das Modell erfand Non-Food-Begründungen aus einem
        # unbekannten Markennamen plus der leeren Abteilung "Sonstiges":
        #   "Hohes C" (Saft)            -> "possibly a cleaning product or spray"
        #   "WERA NOVA Plombir" (Eis)   -> "suggests a tool or equipment"
        #   "K-CLASSIC Mini-Windbeutel" -> "a type of kitchen tool or bag"
        #   "LAMBERTZ Composition"      -> "possibly related to art supplies"
        #   "FRISIA Ufonauten Esspapier"-> "a paper product used for food packaging"
        # Alle fünf sind Lebensmittel. Ein falsches Non-Food-Urteil versteckt ein
        # echtes Angebot dauerhaft, ein falsches Food-Urteil wird vom Regel-Gate
        # abgefangen — die Beweislast liegt daher bei Non-Food.
        system_prompt = (
            "You classify a German supermarket product into the given taxonomy. "
            "Return ONLY JSON matching the schema. 'main' and 'sub' MUST be from the "
            "allowed enums; 'main' must never be 'Sonstiges'. If unsure, pick the best "
            "main, set sub to 'unknown', set confidence low (<0.5) and add a short reason. "
            "At most 2 short reasons. No prose, no thinking.\n"
            "\n"
            "isNonFood rules (a wrong Non-Food verdict permanently hides a real deal, "
            "so the burden of proof is on Non-Food):\n"
            "1. Set isNonFood=true ONLY if you can name the concrete non-food product "
            "class: appliance/device, tableware/container, textile/clothing/shoes, "
            "furniture, tool, toy/craft item, cleaner/detergent, cosmetic/body care, "
            "medicine/supplement-free drugstore item, pet food or pet supply, living "
            "plant or cut flower, stationery, electronics.\n"
            "2. NEVER infer Non-Food from an unfamiliar brand or product name. If you do "
            "not recognise it, treat it as food, set isNonFood=false and confidence<0.5. "
            "Most items in a German supermarket flyer are food.\n"
            "3. source_department values like 'Sonstiges', 'Extra-Angebote', "
            "'Bonus-Aktionen', 'Rabatt-Monat', 'Filialangebote', 'Angebote zum "
            "Wochenstart' or a campaign/movie name carry NO category information. Never "
            "use them as evidence for Non-Food (or for any category).\n"
            "4. German compounds: the LAST part (the head) decides the product class. "
            "'Mikrowellengericht'/'Pfannengericht' = a dish (food); 'Mikrowelle' = the "
            "appliance (non-food). 'Esspapier' = edible paper (food); 'Küchenpapier' = "
            "paper (non-food). 'Grillkäse'/'Ofenkäse' = cheese (food); 'Grillzange' = "
            "tool (non-food). 'Windbeutel' = a cream puff (pastry), not a bag.\n"
            "5. Food even when sold in a drugstore aisle: sports nutrition (Whey/"
            "Protein/Creatine), protein and muesli bars, infant formula "
            "(Folgemilch/Anfangsmilch), baby food. Classify these as food.\n"
            "6. Food: all alcoholic drinks, coffee, tea, spices, salt, sweets, ice "
            "cream, juices and soft drinks.\n"
            "7. Non-Food even though edible: pet food and pet snacks "
            "(Katzen-/Hunde-/Nagerfutter, Katzensnack).\n"
            "8. Non-Food even in an 'Obst, Gemüse, Pflanzen' aisle: living plants, pot "
            "plants and cut flowers (Rose, Orchidee, Chrysantheme, Aster, Hortensie, "
            "Korbmarante, Blumenstrauß). Vegetables and herbs sold by the bunch "
            "('Bund') in that same aisle ARE food (Lauchzwiebeln, Radieschen, "
            "Petersilie).\n"
            "9. size_or_unit is a strong hint: kg/g/l/ml point to a consumable; "
            "'Stück'/'Packung' alone is neutral, never evidence for Non-Food."
        )
        user_payload = {
            "taxonomy": taxonomy_brief,
            "product": {
                "title": offer.title,
                "brand": offer.brand,
                "source_category": offer.source_category,
                "source_department": offer.source_department,
                "chain": offer.chain,
                "size_or_unit": offer.size_or_unit,
            },
            "rules": [
                "Cheese (Käse, Gouda, Grünländer) → Milchprodukte & Eier, not Süßwaren.",
                "Pasta sauce / pesto in a jar → Konserven & Fertiggerichte, not Tiefkühl.",
                "Spray/lacquer/cleaner/Kfz/Auto → Non-Food (isNonFood=true).",
                "Only Tiefkühl when the product is actually frozen (TK).",
                "Unknown brand + uninformative department → food with low confidence, "
                "never Non-Food.",
                "Judge the German compound by its HEAD: Mikrowellen-GERICHT is a dish, "
                "Ess-PAPIER is a sweet, Kaffee-MASCHINE is a device.",
            ],
        }

        request_payload = {
            "model": self.model,
            "stream": False,
            # Real Structured Output (JSON Schema) instead of just format:"json".
            "format": schema,
            # Disable qwen3-style "thinking" so we don't pay for hidden reasoning
            # tokens. Ignored by models/Ollama versions that don't support it.
            "think": False,
            # Keep the model warm between per-item calls in a batch run.
            "keep_alive": "10m",
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": json.dumps(user_payload, ensure_ascii=False)},
            ],
            "options": {
                "temperature": 0,
                "num_predict": self.num_predict,
            },
        }

        body = json.dumps(request_payload, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(
            url=f"{self.host}/api/chat",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout_seconds) as response:
                raw = response.read().decode("utf-8", errors="replace")
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            # Transport-level failure (timeout / connection refused / HTTP 5xx —
            # HTTPError is a URLError subclass). Surface it so the fail-fast
            # counter can trip; the caller turns repeated failures into an abort.
            raise OllamaRequestError(str(exc)) from exc

        try:
            envelope = json.loads(raw)
        except json.JSONDecodeError:
            return None

        content = ""
        message = envelope.get("message")
        if isinstance(message, dict):
            content = str(message.get("content", ""))
        elif "response" in envelope:
            content = str(envelope.get("response", ""))
        else:
            content = str(envelope)

        return extract_json_object(content)

    def _validate(self, payload: dict[str, Any]) -> CanonicalCategory | None:
        main = str(payload.get("main", "")).strip()
        sub = str(payload.get("sub", "unknown")).strip() or "unknown"

        if main not in self.taxonomy.main_set:
            return None

        if sub not in self.taxonomy.sub_set_map.get(main, set()):
            sub = "unknown"

        secondary_raw = payload.get("secondary", [])
        secondary: list[str] = []
        if isinstance(secondary_raw, list):
            for value in secondary_raw:
                text = str(value).strip()
                if text:
                    secondary.append(text)

        is_non_food = bool(payload.get("isNonFood", False) or main == "Non-Food")

        confidence = payload.get("confidence", 0.65)
        try:
            confidence_value = float(confidence)
        except (TypeError, ValueError):
            confidence_value = 0.65
        confidence_value = max(0.0, min(1.0, confidence_value))

        reasons_raw = payload.get("reasons", [])
        reasons = [str(reason).strip() for reason in reasons_raw] if isinstance(reasons_raw, list) else []
        reasons = [reason for reason in reasons if reason]

        return CanonicalCategory(
            main=main,
            sub=sub,
            secondary=dedupe_list(secondary),
            is_non_food=is_non_food,
            confidence=confidence_value,
            reasons=dedupe_list(reasons),
        )


def build_category_schema(taxonomy: Taxonomy) -> dict[str, Any]:
    """A JSON Schema for Ollama Structured Outputs. `main`/`sub` are constrained
    to the taxonomy enums so a local model can only return VALID categories — no
    free-text hallucinations. The shape is deliberately minimal."""
    all_subs: list[str] = []
    seen: set[str] = set()
    for subs in taxonomy.subcategories.values():
        for sub in subs:
            if sub not in seen:
                seen.add(sub)
                all_subs.append(sub)
    if "unknown" not in seen:
        all_subs.append("unknown")

    # `reasons` steht bewusst am Ende und ist bewusst PFLICHT:
    #
    # Structured Outputs erzeugen die Felder in Schema-Reihenfolge, die Begruendung
    # entsteht also erst NACH der Entscheidung und kann sie nicht mehr beeinflussen.
    # Sie kostete aber 69 % der erzeugten Zeichen, darum das Limit von 1 statt 2 —
    # gemessen 8/8 identische Entscheidungen (inkl. confidence) bei ~26 % weniger
    # Tokens.
    #
    # Das Feld ganz zu streichen waere die naheliegende, aber falsche Optimierung:
    # solange es OPTIONAL ist, darf hinter `0.9` ein Komma folgen. Ohne das Feld
    # verbietet die Grammatik das Komma, das Modell haengt stattdessen eine Ziffer
    # an und die Confidence steigt systematisch um +0,05 (gemessen in 6 von 8
    # Faellen) — das wuerde still die Review-Schwellen verschieben. Als Pflichtfeld
    # bleibt das Komma erzwungen und die Confidence exakt wie bisher.
    #
    # Aus demselben Grund bleibt der Prompt ("At most 2 short reasons") unveraendert:
    # ein anderer Prompt erzeugt andere Tokens und damit potenziell andere Urteile.
    return {
        "type": "object",
        "properties": {
            "main": {"type": "string", "enum": list(taxonomy.main_categories)},
            "sub": {"type": "string", "enum": all_subs},
            "isNonFood": {"type": "boolean"},
            "confidence": {"type": "number", "minimum": 0, "maximum": 1},
            "reasons": {"type": "array", "items": {"type": "string"}, "maxItems": 1},
        },
        "required": ["main", "sub", "isNonFood", "confidence", "reasons"],
        "additionalProperties": False,
    }


def extract_json_object(content: str) -> dict[str, Any] | None:
    text = content.strip()
    if not text:
        return None
    try:
        value = json.loads(text)
        if isinstance(value, dict):
            return value
    except json.JSONDecodeError:
        pass

    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return None

    candidate = text[start : end + 1]
    try:
        value = json.loads(candidate)
        if isinstance(value, dict):
            return value
    except json.JSONDecodeError:
        return None
    return None


def offer_fingerprint(
    *,
    chain_norm: str,
    title_norm: str,
    brand_norm: str,
    size_norm: str,
    price: float | None,
    validity_start_raw: str,
    validity_end_raw: str,
    gtin_or_ean: str,
) -> str:
    """Offer IDENTITY fingerprint — keys cross-snapshot grouping/dedup. Bewusst
    OHNE Quell-Kategorie/-Abteilung: dasselbe Produkt darf über Snapshots hinweg
    auch dann zu EINER Gruppe verschmelzen, wenn ein Snapshot die Abteilung nicht
    mitliefert (group_offers füllt sie dann nach). Der Klassifizierungs-Cache nutzt
    stattdessen den decision-vollständigen {@link classification_cache_key}."""
    identity = gtin_or_ean.strip() if gtin_or_ean else ""
    price_part = "" if price is None else f"{price:.4f}"
    key = "|".join(
        [
            f"chain:{chain_norm}",
            f"id:{text_normalize(identity)}",
            f"title:{title_norm}",
            f"brand:{brand_norm}",
            f"size:{size_norm}",
            f"price:{price_part}",
            f"vs:{text_normalize(validity_start_raw)}",
            f"ve:{text_normalize(validity_end_raw)}",
        ]
    )
    return hashlib.sha1(key.encode("utf-8")).hexdigest()


def classification_cache_key(
    offer: "OfferRecord",
    *,
    model: str = "",
    taxonomy_signature: str = "",
) -> str:
    """Stable fingerprint of the actual LLM decision inputs.

    Price, validity, retailer offer id and ``offer.fingerprint`` are intentionally
    excluded: none is sent to the model, and all can change from one weekly offer
    to the next. Source category/department and chain remain because they are part
    of the prompt and can legitimately change the food/non-food verdict. Model,
    schema and taxonomy namespace otherwise compatible-looking cache entries.
    """
    parts = "|".join(
        [
            f"schema:{CLASSIFIER_SCHEMA_VERSION}",
            f"model:{text_normalize(model)}",
            f"taxonomy:{taxonomy_signature.strip().lower()}",
            f"title:{getattr(offer, 'title_norm', '') or ''}",
            f"brand:{getattr(offer, 'brand_norm', '') or ''}",
            f"size:{text_normalize(getattr(offer, 'size_or_unit', '') or '')}",
            f"chain:{getattr(offer, 'chain_norm', '') or ''}",
            f"scat:{getattr(offer, 'source_category_norm', '') or ''}",
            f"sdept:{getattr(offer, 'source_department_norm', '') or ''}",
        ]
    )
    return hashlib.sha1(parts.encode("utf-8")).hexdigest()


def record_from_raw(raw_offer: dict[str, Any], source_file: Path, snapshot_id: str) -> OfferRecord | None:
    title_raw = deep_find_value(raw_offer, FIELD_ALIASES["title"])
    chain_raw = deep_find_value(raw_offer, FIELD_ALIASES["chain"])

    if title_raw is None or chain_raw is None:
        return None

    title = str(title_raw).strip()
    chain = str(chain_raw).strip()
    if not title or not chain:
        return None

    brand = str(deep_find_value(raw_offer, FIELD_ALIASES["brand"]) or "").strip()
    source_category = str(deep_find_value(raw_offer, FIELD_ALIASES["category"]) or "").strip()
    source_department = str(deep_find_value(raw_offer, FIELD_ALIASES["department"]) or "").strip()
    size_or_unit = str(deep_find_value(raw_offer, FIELD_ALIASES["unit"]) or "").strip()

    price = parse_price(deep_find_value(raw_offer, FIELD_ALIASES["price"]))

    validity_start_raw = str(deep_find_value(raw_offer, FIELD_ALIASES["validity_start"]) or "").strip()
    validity_end_raw = str(deep_find_value(raw_offer, FIELD_ALIASES["validity_end"]) or "").strip()

    validity_start = parse_datetime_berlin(validity_start_raw, date_only_as_end=False)
    validity_end = parse_datetime_berlin(validity_end_raw, date_only_as_end=True)

    gtin = str(deep_find_value(raw_offer, FIELD_ALIASES["gtin"]) or "").strip()
    ean = str(deep_find_value(raw_offer, FIELD_ALIASES["ean"]) or "").strip()
    gtin_or_ean = gtin or ean
    tags_raw = deep_find_value(raw_offer, FIELD_ALIASES["tags"])
    tags: list[str] = []
    if isinstance(tags_raw, list):
        for value in tags_raw:
            text = str(value).strip()
            if text:
                tags.append(text)
    elif isinstance(tags_raw, str):
        for part in re.split(r"[,;|]", tags_raw):
            text = part.strip()
            if text:
                tags.append(text)
    tags_norm = [text_normalize(value) for value in tags if text_normalize(value)]
    ingredients_text = str(deep_find_value(raw_offer, FIELD_ALIASES["ingredients"]) or "").strip()
    ingredients_norm = text_normalize(ingredients_text)

    title_norm = text_normalize(title)
    chain_norm = text_normalize(chain)
    brand_norm = text_normalize(brand)
    size_norm = text_normalize(size_or_unit)

    fingerprint = offer_fingerprint(
        chain_norm=chain_norm,
        title_norm=title_norm,
        brand_norm=brand_norm,
        size_norm=size_norm,
        price=price,
        validity_start_raw=validity_start_raw,
        validity_end_raw=validity_end_raw,
        gtin_or_ean=gtin_or_ean,
    )

    return OfferRecord(
        fingerprint=fingerprint,
        raw_offer=raw_offer,
        title=title,
        title_norm=title_norm,
        brand=brand,
        brand_norm=brand_norm,
        source_category=source_category,
        source_category_norm=text_normalize(source_category),
        source_department=source_department,
        source_department_norm=text_normalize(source_department),
        chain=chain,
        chain_norm=chain_norm,
        size_or_unit=size_or_unit,
        price=price,
        validity_start=validity_start,
        validity_end=validity_end,
        validity_start_raw=validity_start_raw,
        validity_end_raw=validity_end_raw,
        gtin_or_ean=gtin_or_ean,
        tags=tags,
        tags_norm=tags_norm,
        ingredients_text=ingredients_text,
        ingredients_norm=ingredients_norm,
        source_file=str(source_file),
        snapshot_id=snapshot_id,
    )

def source_snapshot_id(file_path: Path, payload: Any) -> str:
    if isinstance(payload, dict):
        value = deep_find_value(payload, FIELD_ALIASES["snapshot"])
        if value is not None and str(value).strip():
            return str(value).strip()
    return file_path.stem


HALAL_ALCOHOL_KEYWORDS = {
    "beer",
    "bier",
    "wein",
    "vodka",
    "rum",
    "gin",
    "whiskey",
    "whisky",
    "likor",
    "likoer",
}
HALAL_GUMMY_KEYWORDS = {
    "gummibaer",
    "gummibaeren",
    "gummibar",
    "gummibaren",
    "gummy",
    "wine gums",
    "fruchtgummi",
}


def infer_halal_annotation(category: CanonicalCategory, offer: OfferRecord) -> dict[str, Any]:
    body = " ".join(
        [
            offer.title_norm,
            offer.brand_norm,
            offer.source_category_norm,
            offer.source_department_norm,
            " ".join(offer.tags_norm),
        ]
    ).strip()
    tokens = set(body.split())
    ingredients = offer.ingredients_norm

    alcohol_hit = category.main == "Alkohol" or any(
        keyword_match(keyword, body, tokens) for keyword in HALAL_ALCOHOL_KEYWORDS
    )
    if alcohol_hit:
        return {"status": "not_halal", "confidence": 0.96, "reasons": ["rule:alcohol_detected"]}

    tags_joined = " ".join(offer.tags_norm)
    if "non halal" in tags_joined or "not halal" in tags_joined:
        return {"status": "not_halal", "confidence": 0.9, "reasons": ["tag:not_halal"]}
    if "halal" in tags_joined:
        return {"status": "halal", "confidence": 0.88, "reasons": ["tag:halal"]}

    if ("vegan" in tags_joined or "vegetar" in tags_joined) and category.main != "Alkohol":
        return {
            "status": "likely_halal",
            "confidence": 0.7,
            "reasons": ["user_rule: vegan/vegetarisch => likely_halal"],
        }

    gummy_context = (
        category.main == "Süßwaren & Snacks"
        and any(keyword_match(keyword, body, tokens) for keyword in HALAL_GUMMY_KEYWORDS)
    )
    if gummy_context:
        if ingredients:
            if "schweinegelatine" in ingredients or ("gelatine" in ingredients and "schwein" in ingredients):
                return {"status": "not_halal", "confidence": 0.95, "reasons": ["rule:gelatin_pork"]}
            if "rindergelatine" in ingredients or ("gelatine" in ingredients and "rind" in ingredients):
                return {
                    "status": "unknown",
                    "confidence": 0.62,
                    "reasons": ["rule:gelatin_beef_unknown_slaughter"],
                }
            if "fischgelatine" in ingredients or ("fish gelatin" in ingredients):
                return {"status": "unknown", "confidence": 0.6, "reasons": ["rule:gelatin_fish_unknown"]}
            if "gelatine" in ingredients or "gelatin" in ingredients:
                return {"status": "unknown", "confidence": 0.58, "reasons": ["rule:gelatin_unknown_source"]}
            if "vegan" in ingredients:
                return {"status": "likely_halal", "confidence": 0.7, "reasons": ["rule:ingredients_vegan"]}
            return {"status": "unknown", "confidence": 0.45, "reasons": ["needs_ingredients_for_gelatin_check"]}
        return {"status": "unknown", "confidence": 0.4, "reasons": ["needs_ingredients_for_gelatin_check"]}

    return default_halal_annotation()


def compute_week_flags(
    start: datetime | None,
    end: datetime | None,
    week_start: datetime,
    week_end: datetime,
    mode: str,
) -> dict[str, bool]:
    overlap = bool(start and end and start <= week_end and end >= week_start)
    week_start_local_date = week_start.astimezone(BERLIN_TZ).date()
    starts_midweek = bool(
        start
        and start <= week_end
        and start.astimezone(BERLIN_TZ).date() > week_start_local_date
    )
    ends_before_week_end = bool(end and end < week_end and end >= week_start)
    ends_midweek = bool(
        ends_before_week_end
        and end is not None
        and end.astimezone(BERLIN_TZ).weekday() in MIDWEEK_WEEKDAYS
    )
    partial = starts_midweek or ends_before_week_end

    in_week = overlap
    if mode == "starts":
        in_week = bool(start and week_start <= start <= week_end)

    return {
        "inWeek": in_week,
        "startsMidweek": starts_midweek,
        "endsMidweek": ends_midweek,
        "endsBeforeWeekEnd": ends_before_week_end,
        "partialWeek": partial,
    }


def keyword_hits_for_main(
    main: str,
    taxonomy: Taxonomy,
    normalized_text: str,
    token_set: set[str],
) -> dict[str, list[str]]:
    sub_map = taxonomy.keywords.get(main, {})
    hits: dict[str, list[str]] = {}
    for sub, keywords in sub_map.items():
        if sub == "unknown":
            continue
        for keyword in keywords:
            normalized_keyword = text_normalize(keyword)
            if not normalized_keyword:
                continue
            if keyword_match(normalized_keyword, normalized_text, token_set):
                hits.setdefault(sub, []).append(normalized_keyword)
    return hits


def pick_best_sub_from_hits(hits: dict[str, list[str]]) -> tuple[str, list[str]] | None:
    if not hits:
        return None
    ranked = sorted(
        hits.items(),
        key=lambda item: (
            len(set(item[1])),
            max((len(kw) for kw in item[1]), default=0),
            item[0],
        ),
        reverse=True,
    )
    sub, keywords = ranked[0]
    return sub, dedupe_list(keywords)


# Preparation / seasoning product words. When present, a bare vegetable INGREDIENT
# hit (Knoblauch/Zwiebel/Kräuter …) is a flavour component, not raw produce — so a
# "Kochpaste Gerösteter Knoblauch" must NOT be repaired to Obst & Gemüse (P3).
# Distinctive whole tokens only (no risky substrings like bare "paste").
_PREPARATION_SIGNAL_WORDS = (
    "kochpaste",
    "wuerzpaste",
    "wurzpaste",
    "gewuerzpaste",
    "gewurzpaste",
    "wuerzmischung",
    "wurzmischung",
    "fix",
    "fond",
    "bruehe",
    "brue",
    "marinade",
    "dressing",
    "pesto",
    "sugo",
    "passata",
    "instant",
)

# Vegetable hits that are typically a SEASONING/flavour rather than the product
# itself; only these are suppressed in a preparation context.
_SEASONING_PRODUCE_WORDS = (
    "knoblauch",
    "zwiebel",
    "zwiebeln",
    "kraeuter",
    "krauter",
    "ingwer",
    "chili",
    "peperoni",
    "petersilie",
    "schnittlauch",
)


def _has_preparation_signal(normalized_text: str, token_set: set[str]) -> bool:
    return any(keyword_match(word, normalized_text, token_set) for word in _PREPARATION_SIGNAL_WORDS)


def category_suspects(
    category: CanonicalCategory,
    offer: OfferRecord,
    taxonomy: Taxonomy,
) -> list[dict[str, Any]]:
    body = " ".join(
        [offer.title_norm, offer.brand_norm, offer.source_category_norm, offer.source_department_norm]
    ).strip()
    tokens = set(body.split())
    # Beleg-Herkunft trennen: Ein Keyword im PRODUKTNAMEN sagt, was das Produkt
    # IST. Eines, das nur in der Haendler-Abteilung steht, sagt bloss, wo es im
    # Laden liegt — und Abteilungen sind nachweislich gemischt ("Getraenke,
    # Spirituosen", "Wochenangebote - Backwaren" bei Obst/Gemuese-Abteilung).
    # Nur mit dieser Trennung kann apply_auto_repair entscheiden, ob eine
    # Reparatur stark genug ist, ein begruendetes Modellurteil zu ueberstimmen.
    name_body = " ".join([offer.title_norm, offer.brand_norm]).strip()
    name_tokens = set(name_body.split())

    def _name_supported(keywords: list[str] | tuple[str, ...]) -> bool:
        return any(keyword_match(kw, name_body, name_tokens) for kw in keywords)

    suspects: list[dict[str, Any]] = []

    sauce_hits = keyword_hits_for_main("Gewürze/Saucen/Aufstriche", taxonomy, body, tokens)
    produce_hits = keyword_hits_for_main("Obst & Gemüse", taxonomy, body, tokens)
    dairy_hits = keyword_hits_for_main("Milchprodukte & Eier", taxonomy, body, tokens)
    frozen_hits = keyword_hits_for_main("Tiefkühl", taxonomy, body, tokens)

    if sauce_hits and category.main not in {"Gewürze/Saucen/Aufstriche", "Non-Food"}:
        best = pick_best_sub_from_hits(sauce_hits)
        if best is not None:
            suspects.append(
                {
                    "reason": "repair:sauce_keyword",
                    "main": "Gewürze/Saucen/Aufstriche",
                    "sub": best[0],
                    "keywords": best[1],
                    "name_supported": _name_supported(best[1]),
                }
            )

    # A preparation/seasoning product whose only produce hits are flavour
    # vegetables (Knoblauch/Zwiebel/Kräuter …) is NOT raw produce — suppress the
    # produce repair so "Kochpaste Gerösteter Knoblauch" stays a sauce/seasoning.
    produce_hit_words = {kw for words in produce_hits.values() for kw in words}
    only_seasoning_produce = produce_hit_words.issubset(set(_SEASONING_PRODUCE_WORDS))
    suppress_produce = only_seasoning_produce and _has_preparation_signal(body, tokens)

    if (
        produce_hits
        and not sauce_hits
        and not suppress_produce
        and category.main not in {"Obst & Gemüse", "Non-Food"}
    ):
        best = pick_best_sub_from_hits(produce_hits)
        if best is not None:
            suspects.append(
                {
                    "reason": "repair:produce_keyword",
                    "main": "Obst & Gemüse",
                    "sub": best[0],
                    "keywords": best[1],
                    "name_supported": _name_supported(best[1]),
                }
            )

    if dairy_hits and category.main not in {"Milchprodukte & Eier", "Non-Food"}:
        best = pick_best_sub_from_hits(dairy_hits)
        if best is not None:
            suspects.append(
                {
                    "reason": "repair:dairy_keyword",
                    "main": "Milchprodukte & Eier",
                    "sub": best[0],
                    "keywords": best[1],
                    "name_supported": _name_supported(best[1]),
                }
            )

    if frozen_hits and category.main not in {"Tiefkühl", "Non-Food"}:
        best = pick_best_sub_from_hits(frozen_hits)
        if best is not None:
            suspects.append(
                {
                    "reason": "repair:tk_keyword",
                    "main": "Tiefkühl",
                    "sub": best[0],
                    "keywords": best[1],
                    "name_supported": _name_supported(best[1]),
                }
            )

    return suspects


# High-precision plausibility rules. Keyword forms are German with umlauts; they
# are run through text_normalize (ü→ue, ä→ae) before matching, so they catch the
# transliterated tokens. `substring` enables compound matching (Frischkäse) for
# distinctive keywords only; risky short keywords stay token/word-boundary based.
_CONFLICT_RULES: list[dict[str, Any]] = [
    {
        "name": "non_food",
        "expected_main": "Non-Food",
        "expected_sub": "Haushalt",
        "acceptable": {"Non-Food"},
        "substring": False,
        "blockers": (),
        "keywords": (
            "kfz", "lack", "spray", "reiniger", "maschinenreiniger", "klarspüler",
            "waschmittel", "weichspüler", "shampoo", "duschgel", "batterie", "batterien",
            "allzweckreiniger", "politur", "frostschutz", "scheibenreiniger", "wc-reiniger",
        ),
    },
    {
        "name": "cheese",
        "expected_main": "Milchprodukte & Eier",
        "expected_sub": "Käse",
        "acceptable": {"Milchprodukte & Eier", "Feinkost & Kühlung"},
        "substring": True,
        # Meat products whose name contains "käse" must NOT be read as cheese.
        "blockers": ("leberkäse", "fleischkäse"),
        "keywords": (
            "käse", "gouda", "grünländer", "cheddar", "mozzarella", "camembert",
            "emmentaler", "brie", "feta", "butterkäse", "frischkäse", "schnittkäse",
            "raclette", "mascarpone", "ricotta", "parmesan", "maasdamer",
        ),
    },
    {
        "name": "meat",
        "expected_main": "Fleisch & Wurst",
        "expected_sub": "unknown",
        "acceptable": {"Fleisch & Wurst", "Tiefkühl", "Konserven & Fertiggerichte", "Feinkost & Kühlung"},
        "substring": False,
        "blockers": (),
        "keywords": (
            "fleisch", "wurst", "salami", "rind", "schwein", "hähnchen", "hackfleisch",
            "schnitzel", "bratwurst", "schinken", "mett", "cabanossi",
        ),
    },
    {
        "name": "fish",
        "expected_main": "Fisch & Meeresfrüchte",
        "expected_sub": "unknown",
        "acceptable": {"Fisch & Meeresfrüchte", "Tiefkühl", "Konserven & Fertiggerichte"},
        "substring": False,
        "blockers": (),
        "keywords": (
            "fisch", "lachs", "garnelen", "thunfisch", "forelle", "hering", "makrele", "scampi",
        ),
    },
    {
        "name": "pasta_sauce",
        "expected_main": "Konserven & Fertiggerichte",
        "expected_sub": "Saucen fertig",
        "acceptable": {
            "Konserven & Fertiggerichte", "Gewürze/Saucen/Aufstriche",
            "Grundnahrungsmittel", "Feinkost & Kühlung",
        },
        "substring": False,
        "blockers": (),
        "keywords": ("pastasauce", "pasta sauce", "nudelsauce", "pesto", "pastasoße"),
    },
]


def _conflict_keyword_hit(keyword: str, body: str, tokens: set[str], substring: bool) -> bool:
    norm = text_normalize(keyword)
    if not norm:
        return False
    if substring and " " not in norm:
        # Distinctive keyword → also catch compounds (frischkäse → frischkaese).
        return norm in body
    return keyword_match(norm, body, tokens)


def detect_category_conflict(
    category: CanonicalCategory,
    offer: OfferRecord,
) -> dict[str, Any] | None:
    """Detect a strong keyword↔category contradiction. Returns the expected
    correction (main/sub/keywords/reason) or None. Pure + taxonomy-free so it is
    easy to unit-test against known products."""
    body = " ".join(
        [offer.title_norm, offer.brand_norm, offer.source_category_norm, offer.source_department_norm]
    ).strip()
    if not body:
        return None
    tokens = set(body.split())

    for rule in _CONFLICT_RULES:
        if any(_conflict_keyword_hit(b, body, tokens, True) for b in rule["blockers"]):
            continue
        hits = [
            text_normalize(kw)
            for kw in rule["keywords"]
            if _conflict_keyword_hit(kw, body, tokens, rule["substring"])
        ]
        if not hits:
            continue
        if category.main in rule["acceptable"]:
            continue
        return {
            "expected_main": rule["expected_main"],
            "expected_sub": rule["expected_sub"],
            "keywords": dedupe_list(hits)[:4],
            "reason": f"rule_conflict:{rule['name']}",
        }
    return None


def detect_meat_keyword_mismatch(
    category: CanonicalCategory,
    offer: OfferRecord,
    taxonomy: Taxonomy,
) -> tuple[bool, list[str]]:
    if category.main == "Non-Food":
        return False, []

    body = " ".join(
        [offer.title_norm, offer.brand_norm, offer.source_category_norm, offer.source_department_norm]
    ).strip()
    tokens = set(body.split())
    meat_hits = keyword_hits_for_main("Fleisch & Wurst", taxonomy, body, tokens)
    if not meat_hits:
        return False, []

    frozen_context = any(keyword_match(token, body, tokens) for token in ("pizza", "lasagne", "tiefkuehl", "tiefkühl", "tk"))
    allowed_mains = {"Fleisch & Wurst"}
    if frozen_context:
        allowed_mains.update({"Tiefkühl", "Konserven & Fertiggerichte"})

    if category.main in allowed_mains:
        return False, []

    hit_keywords: list[str] = []
    for values in meat_hits.values():
        hit_keywords.extend(values)
    return True, dedupe_list(hit_keywords)


def apply_auto_repair(
    category: CanonicalCategory,
    offer: OfferRecord,
    taxonomy: Taxonomy,
) -> tuple[CanonicalCategory, bool, list[str], list[str]]:
    updated = CanonicalCategory(
        main=category.main,
        sub=category.sub,
        secondary=category.secondary.copy(),
        is_non_food=category.is_non_food,
        confidence=category.confidence,
        reasons=category.reasons.copy(),
        halal=dict(category.halal),
    )
    overrides: list[str] = []
    suspects: list[str] = []

    body = " ".join(
        [offer.title_norm, offer.brand_norm, offer.source_category_norm, offer.source_department_norm]
    ).strip()
    tokens = set(body.split())
    source_is_sonstiges = any(hint in offer.source_category_norm for hint in SONSTIGES_HINTS)

    nonfood_tokens = {
        "papier",
        "shampoo",
        "handcreme",
        "kuechenrolle",
        "kuechentuecher",
        "waschmittel",
    }
    sweet_tokens = {"keks", "schokolade", "praline", "bonbon", "kuchen", "rumkugel", "rumkugeln"}

    rescue_category = detect_food_rescue_category(body, tokens)
    if rescue_category is not None:
        rescue_main, rescue_sub, rescue_reasons = rescue_category
        should_apply_rescue = (
            updated.main == "Non-Food"
            or updated.sub == "unknown"
            or updated.confidence < 0.75
        )
        if should_apply_rescue:
            if rescue_sub not in taxonomy.sub_set_map.get(rescue_main, set()):
                rescue_sub = "unknown"
            updated.main = rescue_main
            updated.sub = rescue_sub
            updated.is_non_food = False
            updated.confidence = max(0.82, min(0.95, updated.confidence))
            overrides.append("repair:food_rescue")
            updated.reasons.extend(rescue_reasons)

    if updated.main not in taxonomy.main_set:
        updated.main = "Grundnahrungsmittel"
        updated.sub = "unknown"
        updated.confidence = min(updated.confidence, 0.45)
        overrides.append("override:invalid_main")

    if updated.sub not in taxonomy.sub_set_map.get(updated.main, set()):
        updated.sub = "unknown"
        updated.confidence = min(updated.confidence, 0.6)
        overrides.append("override:invalid_sub")

    if updated.is_non_food and updated.main != "Non-Food":
        updated.main = "Non-Food"
        if updated.sub not in taxonomy.sub_set_map.get("Non-Food", set()):
            updated.sub = "unknown"
        overrides.append("override:is_non_food")

    if updated.main == "Backwaren" and any(token in tokens for token in nonfood_tokens):
        updated.main = "Non-Food"
        updated.sub = "Papier" if "papier" in tokens or "kuechenrolle" in tokens else "Körperpflege"
        updated.is_non_food = True
        updated.confidence = max(updated.confidence, 0.9)
        overrides.append("override:backwaren_to_nonfood")

    if updated.main == "Alkohol" and any(token in tokens for token in sweet_tokens):
        updated.main = "Süßwaren & Snacks"
        updated.sub = "Schokolade & Pralinen"
        updated.is_non_food = False
        updated.confidence = min(0.88, max(updated.confidence, 0.72))
        overrides.append("override:alcohol_to_sweets")
        suspects.extend(["repair:alcohol_to_sweets", "suspect:rule_conflict"])

    suspect_repairs = category_suspects(updated, offer, taxonomy)
    # Eine Keyword-Reparatur darf ein bestehendes Urteil nur ueberstimmen, wenn
    # ihr Beleg im PRODUKTNAMEN steht. Steht er nur in der Haendler-Abteilung,
    # ist er zu schwach: Beobachtet im Lauf 2026-08-17 wurde "MEINE BACKWELT
    # Apfelecke" (Modell: "suggests a bakery") und "RIO D'ORO
    # Bananen-Kirsch-Getraenk" (Modell: "is a fruit drink") allein wegen des
    # Wortes "gemuese" in der Quellabteilung zu Obst & Gemuese umgebogen — das
    # Modell hatte die Produktform korrekt erkannt.
    # Solche Faelle werden nicht mehr umgeschrieben, aber als Review markiert,
    # damit ein echter Fehler nicht still durchrutscht.
    weak_repairs = [r for r in suspect_repairs if not r.get("name_supported", True)]
    suspect_repairs = [r for r in suspect_repairs if r.get("name_supported", True)]
    if weak_repairs and not suspect_repairs:
        suspects.append("suspect:source_only_category_hint")
    if suspect_repairs:
        picked = suspect_repairs[0]
        target_main = str(picked.get("main", "")).strip()
        target_sub = str(picked.get("sub", "unknown")).strip() or "unknown"
        reason = str(picked.get("reason", "repair:category_keyword"))
        keyword_reasons = [
            f"repair_kw:{kw}" for kw in (picked.get("keywords") or [])[:3]
        ]
        if target_main in taxonomy.main_set:
            if target_sub not in taxonomy.sub_set_map.get(target_main, set()):
                target_sub = "unknown"
            updated.main = target_main
            updated.sub = target_sub
            updated.is_non_food = target_main == "Non-Food"
            updated.confidence = min(updated.confidence, 0.78)
            overrides.append(reason)
            suspects.append(reason)
            suspects.append("suspect:rule_conflict")
            updated.reasons.extend(keyword_reasons)

    if updated.main in {"Grundnahrungsmittel", "Feinkost & Kühlung"} and updated.sub == "unknown":
        source_text = " ".join([offer.source_category_norm, offer.source_department_norm]).strip()
        for key, mapping in taxonomy.source_category_map.items():
            if key and key in source_text:
                mapped_main = mapping.get("main", "")
                mapped_sub = mapping.get("sub", "unknown")
                if source_is_sonstiges and mapped_main == "Non-Food":
                    continue
                if mapped_main in taxonomy.main_set:
                    if mapped_sub not in taxonomy.sub_set_map.get(mapped_main, set()):
                        mapped_sub = "unknown"
                    updated.main = mapped_main
                    updated.sub = mapped_sub
                    updated.is_non_food = mapped_main == "Non-Food"
                    updated.confidence = max(updated.confidence, 0.62)
                    overrides.append("override:source_map")
                    break

    if updated.main != "Non-Food" and updated.sub == "unknown":
        sub_hits = keyword_hits_for_main(updated.main, taxonomy, body, tokens)
        best_unknown_fix = pick_best_sub_from_hits(sub_hits)
        if best_unknown_fix is not None:
            updated.sub = best_unknown_fix[0]
            updated.confidence = max(updated.confidence, 0.66)
            overrides.append("repair:sub_from_keyword")
            updated.reasons.extend([f"sub_kw:{kw}" for kw in best_unknown_fix[1][:3]])

    if updated.main == "Non-Food":
        updated.is_non_food = True

    if updated.main == "Grundnahrungsmittel" and updated.sub == "unknown":
        updated.confidence = min(updated.confidence, 0.68)

    if updated.sub not in taxonomy.sub_set_map.get(updated.main, set()):
        updated.sub = "unknown"
        overrides.append("override:final_invalid_sub")

    if not updated.secondary:
        updated.secondary = []
    else:
        updated.secondary = dedupe_list([value for value in updated.secondary if value])

    if overrides:
        updated.reasons.extend(overrides)
        updated.reasons = dedupe_list(updated.reasons)

    if any(reason.startswith("repair:priority_conflict") for reason in updated.reasons):
        suspects.extend(["repair:priority_conflict", "suspect:rule_conflict"])

    suspects = dedupe_list(suspects)
    return updated, bool(overrides), overrides, suspects


def summarize(processed: list[ProcessedOffer], out_dir: Path) -> None:
    by_main: dict[str, int] = {}
    by_sub: dict[str, int] = {}
    unknown_sub_count = 0
    starts_midweek_count = 0
    ends_midweek_count = 0
    nonfood_count = 0

    for entry in processed:
        main = entry.canonical.main
        sub = entry.canonical.sub
        by_main[main] = by_main.get(main, 0) + 1
        key = f"{main} / {sub}"
        by_sub[key] = by_sub.get(key, 0) + 1
        if sub == "unknown":
            unknown_sub_count += 1
        if entry.week_flags.get("startsMidweek") is True:
            starts_midweek_count += 1
        if entry.week_flags.get("endsMidweek") is True:
            ends_midweek_count += 1
        if entry.canonical.is_non_food:
            nonfood_count += 1

    review_needed = [entry for entry in processed if entry.review_needed]
    overridden = [entry for entry in processed if entry.overridden]

    lines: list[str] = [
        "# Kategorie-Summary",
        "",
        f"- generated_at: `{datetime.now(timezone.utc).isoformat()}`",
        f"- total_offers: `{len(processed)}`",
        f"- unknown_sub_count: `{unknown_sub_count}`",
        f"- unknown_sub_percent: `{(unknown_sub_count / len(processed) * 100 if processed else 0):.2f}%`",
        f"- review_needed: `{len(review_needed)}`",
        f"- starts_midweek_count: `{starts_midweek_count}`",
        f"- ends_midweek_count: `{ends_midweek_count}`",
        f"- nonfood_count: `{nonfood_count}`",
        f"- postcheck_overrides: `{len(overridden)}`",
        "",
        "## Counts by main",
        "",
    ]

    for main, count in sorted(by_main.items(), key=lambda item: item[0]):
        lines.append(f"- {main}: {count}")

    lines.extend([
        "",
        "## Counts by sub",
        "",
    ])
    for key, count in sorted(by_sub.items(), key=lambda item: item[0]):
        lines.append(f"- {key}: {count}")

    lines.extend([
        "",
        "## Top 50 review needed",
        "",
    ])

    for entry in review_needed[:50]:
        lines.append(
            f"- {entry.offer.chain}: {entry.offer.title} -> {entry.canonical.main}/{entry.canonical.sub} ({entry.review_reason})"
        )

    if not review_needed:
        lines.append("- none")

    lines.extend([
        "",
        "## Post-check overrides",
        "",
    ])

    for entry in overridden:
        lines.append(
            f"- {entry.offer.chain}: {entry.offer.title} -> {entry.canonical.main}/{entry.canonical.sub} ({', '.join(entry.override_reasons)})"
        )

    if not overridden:
        lines.append("- none")

    (out_dir / "summary.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def enrich_output_offer(entry: ProcessedOffer, snapshot_count: int, seen_in_files: list[str], seen_in_snapshots: list[str]) -> dict[str, Any]:
    out = dict(entry.offer.raw_offer)

    out.setdefault("title", entry.offer.title)
    out.setdefault("name", entry.offer.title)
    out.setdefault("brand", entry.offer.brand)
    out.setdefault("chain", entry.offer.chain)
    out.setdefault("category", entry.offer.source_category)
    out.setdefault("validityStart", entry.offer.validity_start_raw)
    out.setdefault("validityEnd", entry.offer.validity_end_raw)
    out.setdefault("price", entry.offer.price)
    out.setdefault("unit", entry.offer.size_or_unit)

    out["canonicalCategory"] = entry.canonical.to_output()
    out["weekFlags"] = entry.week_flags
    out["categorySuspects"] = entry.suspects
    out["reviewNeeded"] = entry.review_needed
    out["reviewReason"] = entry.review_reason
    out["offerFingerprint"] = entry.offer.fingerprint
    out["seenInSnapshots"] = seen_in_snapshots
    out["seenInFiles"] = seen_in_files
    out["snapshotCoverage"] = len(seen_in_snapshots)
    out["snapshotTotal"] = snapshot_count

    return out

def run_pipeline(
    *,
    input_dir: Path,
    out_dir: Path,
    mode: str,
    ollama_mode: str,
    model: str,
    ollama_host: str,
    week_start_iso: str | None,
    week_window_mode: str,
    week_end_day: str | None,
    min_rule_score: float,
    use_llm_threshold: float,
    dump_stats: bool,
    taxonomy_path: Path = DEFAULT_TAXONOMY_PATH,
    cache_path: Path = DEFAULT_CACHE_PATH,
    now: datetime | None = None,
    on_progress: ProgressCallback | None = None,
    llm_timeout_seconds: int = 35,
    max_consecutive_failures: int = 0,
    item_retries: int = 0,
) -> dict[str, Any]:
    if mode not in SUPPORTED_MODES:
        raise ValueError(f"Unsupported mode: {mode}")
    if ollama_mode not in OLLAMA_MODES:
        raise ValueError(f"Unsupported ollama mode: {ollama_mode}")
    if week_window_mode not in SUPPORTED_WEEK_WINDOWS:
        raise ValueError(f"Unsupported week-window: {week_window_mode}")

    taxonomy = load_taxonomy(taxonomy_path)

    week_start_override = parse_week_start(week_start_iso)
    week_start, week_end = week_window(
        reference=now,
        week_start_override=week_start_override,
        week_window_mode=week_window_mode,
        week_end_day=week_end_day,
    )

    input_dir = input_dir.resolve()
    out_dir = out_dir.resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    files = sorted(input_dir.glob("*.json"))
    if not files:
        raise FileNotFoundError(f"Keine JSON-Dateien gefunden: {input_dir}")

    groups: dict[str, OfferRecord] = {}
    group_files: dict[str, set[str]] = {}
    group_snapshots: dict[str, set[str]] = {}

    raw_records = 0

    for file_path in files:
        try:
            payload = json.loads(file_path.read_text(encoding="utf-8-sig"))
        except json.JSONDecodeError:
            continue

        records = extract_offer_records(payload)
        if not records:
            continue

        snap_id = source_snapshot_id(file_path, payload)

        for raw in records:
            record = record_from_raw(raw, file_path, snap_id)
            if record is None:
                continue

            raw_records += 1
            existing = groups.get(record.fingerprint)
            if existing is None:
                groups[record.fingerprint] = record
                group_files[record.fingerprint] = {record.source_file}
                group_snapshots[record.fingerprint] = {record.snapshot_id}
                continue

            group_files[record.fingerprint].add(record.source_file)
            group_snapshots[record.fingerprint].add(record.snapshot_id)

            if not existing.source_category and record.source_category:
                existing.source_category = record.source_category
                existing.source_category_norm = record.source_category_norm
            if not existing.source_department and record.source_department:
                existing.source_department = record.source_department
                existing.source_department_norm = record.source_department_norm
            if not existing.brand and record.brand:
                existing.brand = record.brand
                existing.brand_norm = record.brand_norm
            if existing.price is None and record.price is not None:
                existing.price = record.price
            if not existing.size_or_unit and record.size_or_unit:
                existing.size_or_unit = record.size_or_unit
            if existing.validity_start is None and record.validity_start is not None:
                existing.validity_start = record.validity_start
                existing.validity_start_raw = record.validity_start_raw
            if existing.validity_end is None and record.validity_end is not None:
                existing.validity_end = record.validity_end
                existing.validity_end_raw = record.validity_end_raw

    snapshot_count = len({snap for snaps in group_snapshots.values() for snap in snaps})
    rule = RuleClassifier(taxonomy=taxonomy, min_rule_score=min_rule_score)
    llm = LLMClassifier(
        taxonomy=taxonomy,
        enabled=(ollama_mode == "on"),
        host=ollama_host,
        model=model,
        cache_path=cache_path,
        use_llm_threshold=use_llm_threshold,
        timeout_seconds=llm_timeout_seconds,
        max_consecutive_failures=max_consecutive_failures,
        item_retries=item_retries,
    )

    processed: list[ProcessedOffer] = []
    review_candidates: list[dict[str, Any]] = []
    total_unique = len(groups)
    processed_count = 0
    conflict_rejected = 0

    if on_progress is not None:
        on_progress(
            {
                "total": total_unique,
                "processed": 0,
                "batch": 0,
                "totalBatches": total_unique,
                "message": "Kategorie-Pipeline gestartet",
            }
        )

    for fingerprint, offer in groups.items():
        rule_result = rule.classify(offer)
        category = rule_result.category
        review_reasons: list[str] = []

        if llm.should_use(rule_result):
            llm_result = llm.classify(offer)
            if llm_result is not None:
                category = llm_result
            elif llm.last_outcome == "timeout":
                # The model timed out on THIS item (but Ollama is alive) — keep the
                # rule guess and flag it for manual review instead of failing the run.
                review_reasons.append("ai_timeout")
            else:
                # Transport ok but the answer was empty / failed schema validation.
                review_reasons.append("ai_invalid_schema")

        if not llm.enabled and rule_result.needs_llm:
            review_reasons.append("rule_low_confidence")

        repaired, overridden, override_reasons, suspects = apply_auto_repair(
            category=category,
            offer=offer,
            taxonomy=taxonomy,
        )

        # Plausibility / conflict gate (applies to BOTH rule and LLM results): a
        # strong keyword signal that contradicts the chosen main (e.g. cheese →
        # Süßwaren, Kfz-spray → food, pasta sauce → Tiefkühl) is corrected to the
        # expected category, the KI-trust markers are dropped, and the item is
        # flagged reviewNeeded:rule_conflict. So a wrong category is never written
        # as a confident KI result.
        conflict = detect_category_conflict(repaired, offer)
        if conflict is not None:
            target_main = conflict["expected_main"]
            target_sub = conflict["expected_sub"]
            if target_main in taxonomy.main_set:
                if target_sub not in taxonomy.sub_set_map.get(target_main, set()):
                    target_sub = "unknown"
                repaired.main = target_main
                repaired.sub = target_sub
                repaired.is_non_food = target_main == "Non-Food"
                repaired.confidence = min(repaired.confidence, 0.5)
                # Drop KI-trust markers — a conflict-corrected item is NOT clean KI.
                repaired.reasons = [r for r in repaired.reasons if r not in ("llm", "cache:hit")]
                repaired.reasons.append(conflict["reason"])
                repaired.reasons.extend([f"conflict_kw:{kw}" for kw in conflict["keywords"][:2]])
                repaired.reasons = dedupe_list(repaired.reasons)
                suspects.append("suspect:rule_conflict")
                suspects = dedupe_list(suspects)
                review_reasons.append("rule_conflict")
                conflict_rejected += 1

        repaired.halal = infer_halal_annotation(repaired, offer)

        meat_mismatch, meat_keywords = detect_meat_keyword_mismatch(repaired, offer, taxonomy)
        if meat_mismatch:
            review_reasons.append("keyword_mismatch_meat")
            suspects.append("suspect:meat_keyword_mismatch")
            repaired.reasons.extend([f"meat_kw:{keyword}" for keyword in meat_keywords[:4]])
            repaired.reasons = dedupe_list(repaired.reasons)
            suspects = dedupe_list(suspects)

        if repaired.sub == "unknown":
            review_reasons.append("unknown_sub")
        if repaired.confidence < 0.75:
            review_reasons.append("low_confidence")
        if (
            any(hint in offer.source_category_norm for hint in SONSTIGES_HINTS)
            and not repaired.is_non_food
            and repaired.sub == "unknown"
        ):
            review_reasons.append("source_sonstiges_unclear")
        if any(suspect.startswith("suspect:") for suspect in suspects):
            review_reasons.append("rule_conflict")
        review_reasons = dedupe_list([reason for reason in review_reasons if reason])
        review_needed = bool(review_reasons)
        review_reason = ",".join(review_reasons)

        week_flags = compute_week_flags(
            start=offer.validity_start,
            end=offer.validity_end,
            week_start=week_start,
            week_end=week_end,
            mode=mode,
        )

        entry = ProcessedOffer(
            offer=offer,
            canonical=repaired,
            week_flags=week_flags,
            review_needed=review_needed,
            review_reason=review_reason,
            overridden=overridden,
            override_reasons=override_reasons,
            suspects=suspects,
            score_debug={},
        )
        processed.append(entry)

        if review_needed:
            review_candidates.append(
                {
                    "offerFingerprint": fingerprint,
                    "title": offer.title,
                    "chain": offer.chain,
                    "reason": review_reason,
                    "canonicalCategory": repaired.to_output(),
                }
            )

        processed_count += 1
        if on_progress is not None:
            on_progress(
                {
                    "total": total_unique,
                    "processed": processed_count,
                    "batch": processed_count,
                    "totalBatches": total_unique,
                    "message": "Kategorie-Pipeline verarbeitet Angebote",
                }
            )

    processed.sort(key=lambda item: (item.offer.chain_norm, item.offer.title_norm))

    output_offers = [
        enrich_output_offer(
            entry,
            snapshot_count=max(1, snapshot_count),
            seen_in_files=sorted(group_files[entry.offer.fingerprint]),
            seen_in_snapshots=sorted(group_snapshots[entry.offer.fingerprint]),
        )
        for entry in processed
    ]

    in_week_offers = [offer for offer in output_offers if offer.get("weekFlags", {}).get("inWeek") is True]
    nonfood_offers = [
        offer
        for offer in output_offers
        if bool(((offer.get("canonicalCategory") or {}).get("isNonFood")))
    ]

    categorized_payload = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "weekStartBerlin": week_start.isoformat(),
        "weekEndBerlin": week_end.isoformat(),
        "mode": mode,
        "weekWindow": week_window_mode,
        "weekEndDay": week_end_day or ("sat" if week_window_mode == "retail" else "sun"),
        "ollama": {
            "enabled": llm.enabled,
            "host": ollama_host,
            "model": model,
            "cache": str(cache_path),
        },
        "offers": output_offers,
    }

    (out_dir / "categorized_offers.json").write_text(
        json.dumps(categorized_payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    in_week_payload = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "mode": mode,
        "offers": in_week_offers,
    }
    (out_dir / "categorized_offers_in_week.json").write_text(
        json.dumps(in_week_payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    (out_dir / "categorized_nonfood.json").write_text(
        json.dumps(
            {
                "generatedAt": datetime.now(timezone.utc).isoformat(),
                "offers": nonfood_offers,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    (out_dir / "review_needed.json").write_text(
        json.dumps(
            {
                "generatedAt": datetime.now(timezone.utc).isoformat(),
                "offers": review_candidates[:200],
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    suspect_payload = []
    for entry in processed:
        if not entry.suspects:
            continue
        suspect_payload.append(
            {
                "offerFingerprint": entry.offer.fingerprint,
                "title": entry.offer.title,
                "chain": entry.offer.chain,
                "canonicalCategory": entry.canonical.to_output(),
                "suspects": entry.suspects,
            }
        )
    (out_dir / "category_suspects.json").write_text(
        json.dumps(
            {
                "generatedAt": datetime.now(timezone.utc).isoformat(),
                "offers": suspect_payload,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    summarize(processed, out_dir)

    unknown_sub_total = sum(1 for entry in processed if entry.canonical.sub == "unknown")
    starts_midweek_total = sum(1 for entry in processed if entry.week_flags.get("startsMidweek") is True)
    ends_midweek_total = sum(1 for entry in processed if entry.week_flags.get("endsMidweek") is True)
    nonfood_total = sum(1 for entry in processed if entry.canonical.is_non_food)

    ai_timeout_total = sum(
        1 for entry in processed if "ai_timeout" in (entry.review_reason or "")
    )
    # ai_classified = items whose FINAL category still carries a KI-trust marker
    # (fresh "llm" or a versioned "cache:hit"). Conflict-corrected items had those
    # markers stripped, so they are NOT counted as clean KI here — keeping this
    # number honest for the quality gate.
    ai_classified_final = sum(
        1
        for entry in processed
        if ("llm" in entry.canonical.reasons or "cache:hit" in entry.canonical.reasons)
    )
    stats = {
        "input_files": len(files),
        "raw_records": raw_records,
        "unique_offers": len(output_offers),
        "in_week": len(in_week_offers),
        "nonfood": len(nonfood_offers),
        "review_needed": len(review_candidates),
        "suspects": len(suspect_payload),
        "unknown_sub": unknown_sub_total,
        "starts_midweek": starts_midweek_total,
        "ends_midweek": ends_midweek_total,
        "nonfood_total": nonfood_total,
        # KI / Ollama diagnostics (surfaced to the bridge + admin status).
        "ai_classified": ai_classified_final,
        "ai_classified_raw": llm.classified_count,
        "ai_timeouts": llm.timeout_count,
        "ai_invalid": llm.invalid_count,
        "ai_cache_hits": llm.cache_hit_count,
        "ai_review_timeout": ai_timeout_total,
        "ai_conflict_rejected": conflict_rejected,
        "last_timeout_offer": llm.last_timeout_offer,
        "last_ollama_error": llm.last_error,
        "out_dir": str(out_dir),
    }

    if dump_stats:
        (out_dir / "stats.json").write_text(
            json.dumps(stats, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    if on_progress is not None:
        on_progress(
            {
                "total": total_unique,
                "processed": total_unique,
                "batch": total_unique,
                "totalBatches": total_unique,
                "message": "Kategorie-Pipeline abgeschlossen",
            }
        )

    return stats


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Reklassifiziert Angebots-JSONs in Haupt-/Unterkategorien inkl. Week-Flags."
    )
    parser.add_argument("--input", required=True, type=Path, help="Ordner mit JSON-Dateien")
    parser.add_argument("--out", required=True, type=Path, help="Output-Ordner")
    parser.add_argument("--mode", choices=SUPPORTED_MODES, default="overlap")
    parser.add_argument("--ollama", choices=OLLAMA_MODES, default="off")
    parser.add_argument("--model", default="llama3.1")
    parser.add_argument("--ollama-host", default="http://localhost:11434")
    parser.add_argument("--week-start", default=None, help="Optionales ISO-Datum fuer Wochenstart")
    parser.add_argument("--week-window", choices=SUPPORTED_WEEK_WINDOWS, default="calendar")
    parser.add_argument(
        "--week-end-day",
        choices=tuple(WEEKDAY_ALIASES.keys()),
        default=None,
        help="Optionales Ende der Angebotswoche (mon..sun), ueberschreibt week-window.",
    )
    parser.add_argument("--min-rule-score", type=float, default=3.0)
    parser.add_argument("--use-llm-threshold", type=float, default=0.72)
    # Per-request Ollama timeout (seconds) for the category LLM. Central default
    # comes from the backend env (OLLAMA_TIMEOUT_MS); kept conservative here.
    parser.add_argument("--ollama-timeout", type=int, default=35)
    # Abort the run after this many consecutive transport-level Ollama failures
    # (0 = never abort, legacy behaviour). Only aborts if a health check then
    # shows Ollama down / model unloaded; otherwise the streak resets.
    parser.add_argument("--ollama-max-consecutive-failures", type=int, default=0)
    # Extra attempts for a single timed-out item before skipping it (0 = none).
    parser.add_argument("--ollama-retries", type=int, default=0)
    parser.add_argument("--dump-stats", action="store_true")
    parser.add_argument("--taxonomy", type=Path, default=DEFAULT_TAXONOMY_PATH)
    parser.add_argument("--cache", type=Path, default=DEFAULT_CACHE_PATH)
    return parser.parse_args(argv)
