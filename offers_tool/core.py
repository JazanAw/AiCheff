from __future__ import annotations

import argparse
import json
import re
import unicodedata
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


def resolve_berlin_timezone() -> timezone | ZoneInfo:
    try:
        return ZoneInfo("Europe/Berlin")
    except ZoneInfoNotFoundError:
        # Fallback for Windows/Python installs without IANA tz database.
        return timezone(timedelta(hours=1), name="Europe/Berlin")


BERLIN_TZ = resolve_berlin_timezone()

SUPPORTED_MODES = ("overlap", "starts")

DEFAULT_NONFOOD_KEYWORDS = [
    "kerze",
    "kerzen",
    "duftkerze",
    "duenger",
    "dunger",
    "universaldunger",
    "blumenerde",
    "pflanze",
    "pflanzen",
    "blume",
    "blumen",
    "samen",
    "saemereien",
    "samereien",
    "saatgut",
    "vase",
    "glasvase",
    "batterie",
    "batterien",
    "waschmittel",
    "reiniger",
    "reinigungsmittel",
    "kuechenwaage",
    "kuchenwaage",
    "kuechentuch",
    "kuchentuch",
    "kuechentuecher",
    "kuchentucher",
    "kuchenpapier",
    "schaumbad",
    "badeschaum",
    "bodymilk",
    "body milk",
    "shampoo",
    "deo",
    "zahnpasta",
    "zahncreme",
    "creme",
    "windeln",
    "katzenstreu",
    "hygienestreu",
    "muellbeutel",
    "mullbeutel",
    "alufolie",
    "frischhaltefolie",
    "haushalt",
    "drogerie",
    "kosmetik",
    "koerperpflege",
    "korperpflege",
    "tierfutter",
    "hundefutter",
    "katzenfutter",
]

DEFAULT_UNSURE_KEYWORDS = [
    "immun aktiv shot",
    "immun shot",
    "vitamin shot",
    "gesundheits shot",
    "health shot",
    "nahrungsergaenzung",
    "nahrungserganzung",
    "supplement",
]

DEFAULT_NONFOOD_CATEGORY_KEYWORDS = [
    "haushalt",
    "drogerie",
    "kosmetik",
    "koerperpflege",
    "korperpflege",
    "technik",
    "werkzeug",
    "gartenbedarf",
    "gartenartikel",
    "tierbedarf",
    "haustier",
    "tiernahrung",
    "pflanzen",
    "blumen",
]

DEFAULT_FOOD_KEYWORDS = [
    "obst",
    "gemuese",
    "gemuse",
    "fleisch",
    "fisch",
    "brot",
    "backwaren",
    "milch",
    "joghurt",
    "kaese",
    "nudel",
    "reis",
    "linsen",
    "bohnen",
    "tomate",
    "kartoffel",
    "paprika",
    "gurke",
    "haehnchen",
    "rind",
    "wurst",
    "saft",
    "wasser",
    "cola",
    "tee",
    "kaffee",
    "alkohol",
    "bier",
    "wein",
    "sekt",
    "snack",
    "schokolade",
    "konserve",
    "tiefkuehl",
    "tiefkuhl",
    "lebensmittel",
]

FIELD_ALIASES = {
    "chain": [
        "storeChain",
        "chain",
        "retailerName",
        "retailer",
        "store",
        "market",
        "merchant",
    ],
    "title": [
        "name",
        "title",
        "productName",
        "product",
        "offerTitle",
        "description",
    ],
    "price": [
        "price",
        "offerPrice",
        "currentPrice",
        "salesPrice",
        "discountPrice",
    ],
    "unit": [
        "unit",
        "size",
        "packageSize",
        "quantity",
        "content",
    ],
    "validity_start": [
        "validityStart",
        "validFrom",
        "startDate",
        "start",
    ],
    "validity_end": [
        "validityEnd",
        "validTo",
        "endDate",
        "end",
    ],
    "gtin": ["gtin", "ean", "barcode", "upc"],
    "ean": ["ean", "gtin", "barcode", "upc"],
    "category": ["category", "department", "departmentName", "warengruppe"],
    "department": ["department", "departmentName", "category", "warengruppe"],
    "postal_code": ["postalCode", "zip", "plz", "postal"],
    "region": ["region", "federalState", "state", "area"],
    "brand": ["brand", "brandName"],
    "tags": ["tags", "labels"],
}


@dataclass
class ParsedOffer:
    key: str
    chain: str
    title: str
    normalized_title: str
    price: float | None
    unit: str
    validity_start: datetime | None
    validity_end: datetime | None
    validity_start_raw: str
    validity_end_raw: str
    category: str
    department: str
    gtin_or_ean: str
    postal_code: str
    region: str
    brand: str
    tags: list[str]
    source_file: str
    snapshot_id: str
    raw: dict[str, Any]


@dataclass
class AggregatedOffer:
    key: str
    chain: str
    title: str
    normalized_title: str
    price: float | None
    unit: str
    validity_start: datetime | None
    validity_end: datetime | None
    validity_start_raw: str
    validity_end_raw: str
    category: str
    department: str
    gtin_or_ean: str
    brand: str
    tags: set[str]
    snapshot_ids: set[str]
    source_files: set[str]
    postal_codes: set[str]
    regions: set[str]
    coverage: float = 0.0
    is_national: bool = False
    in_week: bool = False
    food_flag: str = "unsure"
    reasons: list[str] | None = None


def normalize_text(value: Any) -> str:
    if value is None:
        return ""

    text = str(value)
    text = text.strip().lower()
    text = (
        text.replace("ä", "ae")
        .replace("ö", "oe")
        .replace("ü", "ue")
        .replace("ß", "ss")
    )
    text = unicodedata.normalize("NFKD", text)
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def parse_price(value: Any) -> float | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)

    text = str(value).strip().replace("EUR", "").replace("€", "")
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


def parse_datetime_berlin(value: Any) -> datetime | None:
    if value is None:
        return None

    if isinstance(value, (int, float)):
        timestamp = float(value)
        if timestamp > 1_000_000_000_000:
            timestamp /= 1000.0
        return datetime.fromtimestamp(timestamp, tz=timezone.utc).astimezone(BERLIN_TZ)

    text = str(value).strip()
    if not text:
        return None

    candidates = [text]
    if text.endswith("Z"):
        candidates.append(text[:-1] + "+00:00")

    for candidate in candidates:
        try:
            parsed = datetime.fromisoformat(candidate)
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=BERLIN_TZ)
            else:
                parsed = parsed.astimezone(BERLIN_TZ)
            return parsed
        except ValueError:
            continue

    for fmt in ("%d.%m.%Y", "%d.%m.%Y %H:%M", "%Y-%m-%d"):
        try:
            parsed = datetime.strptime(text, fmt).replace(tzinfo=BERLIN_TZ)
            return parsed
        except ValueError:
            continue

    return None


def week_window(now: datetime | None = None) -> tuple[datetime, datetime]:
    current = now.astimezone(BERLIN_TZ) if now else datetime.now(BERLIN_TZ)
    start = (current - timedelta(days=current.weekday())).replace(
        hour=0,
        minute=0,
        second=0,
        microsecond=0,
    )
    end = start + timedelta(days=7) - timedelta(seconds=1)
    return start, end


def deep_find_value(record: Any, aliases: list[str]) -> Any:
    if not isinstance(record, dict):
        return None

    lower_map = {str(key).lower(): key for key in record.keys()}
    for alias in aliases:
        direct = record.get(alias)
        if direct is not None:
            return direct
        key = lower_map.get(alias.lower())
        if key is not None:
            return record.get(key)

    for value in record.values():
        if isinstance(value, dict):
            found = deep_find_value(value, aliases)
            if found is not None:
                return found

    return None


def ensure_list_of_strings(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    text = str(value).strip()
    if not text:
        return []
    return [text]


def derive_snapshot_id(path: Path, payload: Any, offers: list[dict[str, Any]]) -> str:
    if isinstance(payload, dict):
        root_id = deep_find_value(payload, FIELD_ALIASES["postal_code"] + ["snapshotId", "locationId"])
        if root_id:
            return str(root_id)
        root_region = deep_find_value(payload, FIELD_ALIASES["region"])
        if root_region:
            return f"region:{root_region}"

    postal_codes = {
        str(deep_find_value(offer, FIELD_ALIASES["postal_code"])).strip()
        for offer in offers[:200]
        if deep_find_value(offer, FIELD_ALIASES["postal_code"]) is not None
    }
    postal_codes = {value for value in postal_codes if value}
    if len(postal_codes) == 1:
        return postal_codes.pop()

    return path.stem


def extract_offer_records(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]

    if not isinstance(payload, dict):
        return []

    records: list[dict[str, Any]] = []
    preferred_keys = ["offers", "nextWeekOffers", "items", "results", "products", "data"]
    for key in preferred_keys:
        value = payload.get(key)
        if isinstance(value, list):
            records.extend(item for item in value if isinstance(item, dict))

    if records:
        return records

    for key, value in payload.items():
        if key.lower() == "filteredoffers":
            continue
        if isinstance(value, list) and value and isinstance(value[0], dict):
            records.extend(item for item in value if isinstance(item, dict))

    return records


def build_offer_key(
    chain: str,
    title: str,
    price: float | None,
    unit: str,
    validity_start: datetime | None,
    validity_end: datetime | None,
    gtin_or_ean: str,
) -> str:
    chain_norm = normalize_text(chain)
    title_norm = normalize_text(title)
    unit_norm = normalize_text(unit)
    price_norm = "" if price is None else f"{price:.4f}"
    start_norm = validity_start.isoformat() if validity_start else ""
    end_norm = validity_end.isoformat() if validity_end else ""
    id_part = f"id:{normalize_text(gtin_or_ean)}" if gtin_or_ean else f"title:{title_norm}|unit:{unit_norm}"
    return "|".join(
        [
            f"chain:{chain_norm}",
            id_part,
            f"price:{price_norm}",
            f"start:{start_norm}",
            f"end:{end_norm}",
        ]
    )


def parse_offer(raw: dict[str, Any], source_file: Path, snapshot_id: str) -> ParsedOffer | None:
    title_value = deep_find_value(raw, FIELD_ALIASES["title"])
    chain_value = deep_find_value(raw, FIELD_ALIASES["chain"])
    if title_value is None or chain_value is None:
        return None

    title = str(title_value).strip()
    chain = str(chain_value).strip()
    if not title or not chain:
        return None

    price = parse_price(deep_find_value(raw, FIELD_ALIASES["price"]))
    unit = str(deep_find_value(raw, FIELD_ALIASES["unit"]) or "").strip()
    validity_start_raw = str(deep_find_value(raw, FIELD_ALIASES["validity_start"]) or "").strip()
    validity_end_raw = str(deep_find_value(raw, FIELD_ALIASES["validity_end"]) or "").strip()
    validity_start = parse_datetime_berlin(validity_start_raw)
    validity_end = parse_datetime_berlin(validity_end_raw)
    category = str(deep_find_value(raw, FIELD_ALIASES["category"]) or "").strip()
    department = str(deep_find_value(raw, FIELD_ALIASES["department"]) or "").strip()
    gtin = str(deep_find_value(raw, FIELD_ALIASES["gtin"]) or "").strip()
    ean = str(deep_find_value(raw, FIELD_ALIASES["ean"]) or "").strip()
    gtin_or_ean = gtin or ean
    postal_code = str(deep_find_value(raw, FIELD_ALIASES["postal_code"]) or "").strip()
    region = str(deep_find_value(raw, FIELD_ALIASES["region"]) or "").strip()
    brand = str(deep_find_value(raw, FIELD_ALIASES["brand"]) or "").strip()
    tags = ensure_list_of_strings(deep_find_value(raw, FIELD_ALIASES["tags"]))

    key = build_offer_key(
        chain=chain,
        title=title,
        price=price,
        unit=unit,
        validity_start=validity_start,
        validity_end=validity_end,
        gtin_or_ean=gtin_or_ean,
    )

    return ParsedOffer(
        key=key,
        chain=chain,
        title=title,
        normalized_title=normalize_text(title),
        price=price,
        unit=unit,
        validity_start=validity_start,
        validity_end=validity_end,
        validity_start_raw=validity_start_raw,
        validity_end_raw=validity_end_raw,
        category=category,
        department=department,
        gtin_or_ean=gtin_or_ean,
        postal_code=postal_code,
        region=region,
        brand=brand,
        tags=tags,
        source_file=str(source_file),
        snapshot_id=snapshot_id,
        raw=raw,
    )


def overlaps_week(start: datetime | None, end: datetime | None, week_start: datetime, week_end: datetime) -> bool:
    if start is None or end is None:
        return False
    return start <= week_end and end >= week_start


def starts_in_week(start: datetime | None, week_start: datetime, week_end: datetime) -> bool:
    if start is None:
        return False
    return week_start <= start <= week_end


def load_extra_keywords(path: Path | None) -> list[str]:
    if path is None or not path.exists():
        return []

    if path.suffix.lower() == ".json":
        content = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(content, list):
            return [normalize_text(item) for item in content if normalize_text(item)]
        if isinstance(content, dict):
            data = content.get("keywords", [])
            if isinstance(data, list):
                return [normalize_text(item) for item in data if normalize_text(item)]
        return []

    lines = []
    for line in path.read_text(encoding="utf-8").splitlines():
        cleaned = normalize_text(line.split("#", 1)[0])
        if cleaned:
            lines.append(cleaned)
    return lines


def classify_food_flag(
    offer: AggregatedOffer,
    blocked_keywords: list[str],
    blocked_category_keywords: list[str],
    food_keywords: list[str],
    unsure_keywords: list[str],
) -> tuple[str, list[str]]:
    source_text = normalize_text(
        " ".join(
            [
                offer.title,
                offer.brand,
                offer.category,
                offer.department,
                " ".join(sorted(offer.tags)),
            ]
        )
    )
    category_text = normalize_text(" ".join([offer.category, offer.department]))
    reasons: list[str] = []

    for keyword in blocked_keywords:
        if keyword and keyword in source_text:
            reasons.append(f"keyword:{keyword}")

    for keyword in blocked_category_keywords:
        if keyword and keyword in category_text:
            reasons.append(f"category:{keyword}")

    if reasons:
        return "nonfood", sorted(set(reasons))

    unsure_reasons: list[str] = []
    for keyword in unsure_keywords:
        if keyword and keyword in source_text:
            unsure_reasons.append(f"unsure:{keyword}")
    if unsure_reasons:
        return "unsure", sorted(set(unsure_reasons))

    for keyword in food_keywords:
        if keyword and (keyword in source_text or keyword in category_text):
            return "food", []

    return "unsure", []


def serialize_offer(offer: AggregatedOffer, total_snapshots: int) -> dict[str, Any]:
    return {
        "key": offer.key,
        "chain": offer.chain,
        "title": offer.title,
        "normalizedTitle": offer.normalized_title,
        "price": offer.price,
        "unit": offer.unit,
        "validityStart": offer.validity_start.isoformat() if offer.validity_start else offer.validity_start_raw,
        "validityEnd": offer.validity_end.isoformat() if offer.validity_end else offer.validity_end_raw,
        "category": offer.category,
        "department": offer.department,
        "brand": offer.brand,
        "gtinOrEan": offer.gtin_or_ean,
        "tags": sorted(offer.tags),
        "snapshotIds": sorted(offer.snapshot_ids),
        "sourceFiles": sorted(offer.source_files),
        "postalCodes": sorted(offer.postal_codes),
        "regions": sorted(offer.regions),
        "coverage": round(offer.coverage, 4),
        "coverageCount": len(offer.snapshot_ids),
        "snapshotTotal": total_snapshots,
        "national": offer.is_national,
        "food_flag": offer.food_flag,
        "reasons": offer.reasons or [],
    }


def coverage_buckets(offers: list[AggregatedOffer]) -> dict[str, int]:
    buckets = {
        "0.00-0.20": 0,
        "0.21-0.40": 0,
        "0.41-0.60": 0,
        "0.61-0.80": 0,
        "0.81-1.00": 0,
    }
    for offer in offers:
        value = offer.coverage
        if value <= 0.20:
            buckets["0.00-0.20"] += 1
        elif value <= 0.40:
            buckets["0.21-0.40"] += 1
        elif value <= 0.60:
            buckets["0.41-0.60"] += 1
        elif value <= 0.80:
            buckets["0.61-0.80"] += 1
        else:
            buckets["0.81-1.00"] += 1
    return buckets


def write_summary(
    out_dir: Path,
    *,
    mode: str,
    threshold: float,
    week_start: datetime,
    week_end: datetime,
    total_snapshots: int,
    raw_records: int,
    unique_offers: int,
    weekly_offers: list[AggregatedOffer],
    final_offers: list[AggregatedOffer],
    nonfood_offers: list[AggregatedOffer],
    dropped_unsure_count: int,
) -> None:
    per_chain: dict[str, Counter[str]] = defaultdict(Counter)
    for offer in weekly_offers:
        chain = offer.chain or "UNKNOWN"
        stats = per_chain[chain]
        stats["weekly"] += 1
        stats["national" if offer.is_national else "regional"] += 1
        stats[offer.food_flag] += 1
        if offer in final_offers:
            stats["output"] += 1

    lines = [
        "# Angebots-Summary",
        "",
        f"- generated_at: {datetime.now(timezone.utc).isoformat()}",
        f"- mode: `{mode}`",
        f"- national_threshold: `{threshold:.2f}`",
        f"- week_start_berlin: `{week_start.isoformat()}`",
        f"- week_end_berlin: `{week_end.isoformat()}`",
        f"- snapshots: `{total_snapshots}`",
        f"- raw_records: `{raw_records}`",
        f"- unique_offers: `{unique_offers}`",
        f"- weekly_offers: `{len(weekly_offers)}`",
        f"- national_offers: `{sum(1 for offer in weekly_offers if offer.is_national)}`",
        f"- regional_offers: `{sum(1 for offer in weekly_offers if not offer.is_national)}`",
        f"- nonfood_offers: `{len(nonfood_offers)}`",
        f"- unsure_offers: `{sum(1 for offer in weekly_offers if offer.food_flag == 'unsure')}`",
        f"- output_offers: `{len(final_offers)}`",
        f"- dropped_unsure: `{dropped_unsure_count}`",
        "",
        "## Coverage-Verteilung",
        "",
    ]

    for bucket, count in coverage_buckets(weekly_offers).items():
        lines.append(f"- `{bucket}`: {count}")

    lines.extend(
        [
            "",
            "## Pro Kette",
            "",
            "| Kette | Weekly | National | Regional | Nonfood | Unsure | Output |",
            "|---|---:|---:|---:|---:|---:|---:|",
        ]
    )

    for chain in sorted(per_chain.keys(), key=lambda value: value.lower()):
        stats = per_chain[chain]
        lines.append(
            f"| {chain} | {stats['weekly']} | {stats['national']} | {stats['regional']} | {stats['nonfood']} | {stats['unsure']} | {stats['output']} |"
        )

    (out_dir / "summary.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def run_pipeline(
    *,
    input_dir: Path,
    out_dir: Path,
    national_threshold: float = 0.80,
    mode: str = "overlap",
    drop_unsure: bool = False,
    keywords_file: Path | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    if mode not in SUPPORTED_MODES:
        raise ValueError(f"Unsupported mode '{mode}'. Expected one of: {', '.join(SUPPORTED_MODES)}")

    input_dir = input_dir.resolve()
    out_dir = out_dir.resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    files = sorted(input_dir.glob("*.json"))
    if not files:
        raise FileNotFoundError(f"No JSON files found in input directory: {input_dir}")

    groups: dict[str, AggregatedOffer] = {}
    snapshots_seen: set[str] = set()
    raw_records = 0

    for file_path in files:
        try:
            payload = json.loads(file_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue

        records = extract_offer_records(payload)
        if not records:
            continue

        snapshot_id = derive_snapshot_id(file_path, payload, records)
        snapshots_seen.add(snapshot_id)

        for raw in records:
            parsed = parse_offer(raw, source_file=file_path, snapshot_id=snapshot_id)
            if parsed is None:
                continue

            raw_records += 1
            existing = groups.get(parsed.key)
            if existing is None:
                groups[parsed.key] = AggregatedOffer(
                    key=parsed.key,
                    chain=parsed.chain,
                    title=parsed.title,
                    normalized_title=parsed.normalized_title,
                    price=parsed.price,
                    unit=parsed.unit,
                    validity_start=parsed.validity_start,
                    validity_end=parsed.validity_end,
                    validity_start_raw=parsed.validity_start_raw,
                    validity_end_raw=parsed.validity_end_raw,
                    category=parsed.category,
                    department=parsed.department,
                    gtin_or_ean=parsed.gtin_or_ean,
                    brand=parsed.brand,
                    tags=set(parsed.tags),
                    snapshot_ids={parsed.snapshot_id},
                    source_files={parsed.source_file},
                    postal_codes={parsed.postal_code} if parsed.postal_code else set(),
                    regions={parsed.region} if parsed.region else set(),
                )
                continue

            existing.snapshot_ids.add(parsed.snapshot_id)
            existing.source_files.add(parsed.source_file)
            if parsed.postal_code:
                existing.postal_codes.add(parsed.postal_code)
            if parsed.region:
                existing.regions.add(parsed.region)
            existing.tags.update(parsed.tags)
            if not existing.category and parsed.category:
                existing.category = parsed.category
            if not existing.department and parsed.department:
                existing.department = parsed.department
            if not existing.brand and parsed.brand:
                existing.brand = parsed.brand
            if not existing.unit and parsed.unit:
                existing.unit = parsed.unit
            if existing.price is None and parsed.price is not None:
                existing.price = parsed.price

    total_snapshots = max(1, len(snapshots_seen))
    all_offers = list(groups.values())

    for offer in all_offers:
        offer.coverage = len(offer.snapshot_ids) / float(total_snapshots)
        offer.is_national = offer.coverage >= national_threshold

    week_start, week_end = week_window(now)
    weekly_offers: list[AggregatedOffer] = []
    flagged_out_of_week: list[AggregatedOffer] = []

    for offer in all_offers:
        overlaps = overlaps_week(offer.validity_start, offer.validity_end, week_start, week_end)
        starts = starts_in_week(offer.validity_start, week_start, week_end)

        if mode == "overlap":
            offer.in_week = overlaps
        else:
            offer.in_week = starts
            if offer.is_national and overlaps and not starts:
                offer_copy = offer
                offer_copy.reasons = ["out_of_week:starts_mode"]
                flagged_out_of_week.append(offer_copy)

        if offer.in_week:
            weekly_offers.append(offer)

    extra_keywords = load_extra_keywords(keywords_file)
    blocked_keywords = sorted(set(normalize_text(value) for value in DEFAULT_NONFOOD_KEYWORDS + extra_keywords if normalize_text(value)))
    blocked_category_keywords = sorted(
        set(normalize_text(value) for value in DEFAULT_NONFOOD_CATEGORY_KEYWORDS if normalize_text(value))
    )
    food_keywords = sorted(set(normalize_text(value) for value in DEFAULT_FOOD_KEYWORDS if normalize_text(value)))
    unsure_keywords = sorted(
        set(normalize_text(value) for value in DEFAULT_UNSURE_KEYWORDS if normalize_text(value))
    )

    for offer in weekly_offers:
        flag, reasons = classify_food_flag(
            offer,
            blocked_keywords,
            blocked_category_keywords,
            food_keywords,
            unsure_keywords,
        )
        offer.food_flag = flag
        offer.reasons = reasons

    national_weekly = [offer for offer in weekly_offers if offer.is_national]
    flagged_nonfood = [offer for offer in weekly_offers if offer.food_flag == "nonfood"]

    final_offers: list[AggregatedOffer] = []
    dropped_unsure_count = 0
    for offer in national_weekly:
        if offer.food_flag == "nonfood":
            continue
        if offer.food_flag == "unsure" and drop_unsure:
            dropped_unsure_count += 1
            continue
        final_offers.append(offer)

    national_payload = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "inputDir": str(input_dir),
        "mode": mode,
        "nationalThreshold": national_threshold,
        "dropUnsure": drop_unsure,
        "weekStartBerlin": week_start.isoformat(),
        "weekEndBerlin": week_end.isoformat(),
        "snapshotCount": total_snapshots,
        "offers": [serialize_offer(offer, total_snapshots) for offer in final_offers],
    }
    (out_dir / "national_food_offers.json").write_text(
        json.dumps(national_payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    nonfood_payload = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "weekStartBerlin": week_start.isoformat(),
        "weekEndBerlin": week_end.isoformat(),
        "snapshotCount": total_snapshots,
        "offers": [serialize_offer(offer, total_snapshots) for offer in flagged_nonfood],
    }
    (out_dir / "flagged_nonfood.json").write_text(
        json.dumps(nonfood_payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    out_of_week_path = out_dir / "flagged_out_of_week.json"
    if mode == "starts":
        out_of_week_payload = {
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "weekStartBerlin": week_start.isoformat(),
            "weekEndBerlin": week_end.isoformat(),
            "snapshotCount": total_snapshots,
            "offers": [serialize_offer(offer, total_snapshots) for offer in flagged_out_of_week],
        }
        out_of_week_path.write_text(
            json.dumps(out_of_week_payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    elif out_of_week_path.exists():
        out_of_week_path.unlink()

    write_summary(
        out_dir=out_dir,
        mode=mode,
        threshold=national_threshold,
        week_start=week_start,
        week_end=week_end,
        total_snapshots=total_snapshots,
        raw_records=raw_records,
        unique_offers=len(all_offers),
        weekly_offers=weekly_offers,
        final_offers=final_offers,
        nonfood_offers=flagged_nonfood,
        dropped_unsure_count=dropped_unsure_count,
    )

    return {
        "input_files": len(files),
        "snapshots": total_snapshots,
        "raw_records": raw_records,
        "unique_offers": len(all_offers),
        "weekly_offers": len(weekly_offers),
        "national_output": len(final_offers),
        "nonfood_flagged": len(flagged_nonfood),
        "out_dir": str(out_dir),
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Ermittelt nationale Angebote der Woche und filtert Non-Food.")
    parser.add_argument("--input", required=True, type=Path, help="Ordner mit Angebots-JSONs")
    parser.add_argument("--out", required=True, type=Path, help="Output-Ordner")
    parser.add_argument("--national-threshold", type=float, default=0.80, help="Coverage-Threshold fuer national")
    parser.add_argument("--mode", choices=SUPPORTED_MODES, default="overlap", help="Wochenmodus")
    parser.add_argument(
        "--drop-ussegl",
        "--drop-unsure",
        dest="drop_unsure",
        action="store_true",
        help="Unsichere Treffer ebenfalls verwerfen",
    )
    parser.add_argument("--keywords-file", type=Path, default=None, help="Optionale Zusatz-Keywords")
    return parser.parse_args(argv)
