from __future__ import annotations

from datetime import date, datetime
from typing import Any

from offers_categorizer.core import BERLIN_TZ, parse_datetime_berlin


START_FIELD_ALIASES = ("validityStart", "validFrom", "startDate", "start", "from")
END_FIELD_ALIASES = ("validityEnd", "validTo", "endDate", "end", "to")


def resolve_as_of_date(value: str | None) -> date:
    if value:
        parsed = parse_datetime_berlin(value, date_only_as_end=False)
        if parsed is not None:
            return parsed.astimezone(BERLIN_TZ).date()
        try:
            return datetime.strptime(value.strip(), "%Y-%m-%d").date()
        except ValueError:
            pass
    return datetime.now(BERLIN_TZ).date()


def _read_first(offer: dict[str, Any], aliases: tuple[str, ...]) -> Any:
    for key in aliases:
        if key in offer and offer[key] not in (None, ""):
            return offer[key]
    return None


def _to_local_date(value: Any, *, date_only_as_end: bool) -> date | None:
    parsed = parse_datetime_berlin(value, date_only_as_end=date_only_as_end)
    if parsed is None:
        return None
    return parsed.astimezone(BERLIN_TZ).date()


def compute_offer_availability(offer: dict[str, Any], as_of_date_local: date) -> dict[str, Any]:
    week_flags = offer.get("weekFlags") if isinstance(offer.get("weekFlags"), dict) else {}
    in_week = bool(week_flags.get("inWeek") is True)
    canonical = offer.get("canonicalCategory") if isinstance(offer.get("canonicalCategory"), dict) else {}
    is_nonfood = bool(
        offer.get("foodFlag") == "nonfood"
        or canonical.get("isNonFood") is True
        or canonical.get("main") == "Non-Food"
    )

    start_raw = _read_first(offer, START_FIELD_ALIASES)
    end_raw = _read_first(offer, END_FIELD_ALIASES)
    start_date_local = _to_local_date(start_raw, date_only_as_end=False) or as_of_date_local
    end_date_local = _to_local_date(end_raw, date_only_as_end=True) or as_of_date_local

    if is_nonfood:
        status = "locked"
        locked_reason = "nonfood_blocked"
    elif not in_week:
        status = "locked"
        locked_reason = "out_of_week"
    elif as_of_date_local < start_date_local:
        status = "locked"
        locked_reason = "starts_in_future"
    else:
        status = "unlocked"
        locked_reason = None

    return {
        "asOfDateLocal": as_of_date_local.isoformat(),
        "startDateLocal": start_date_local.isoformat(),
        "endDateLocal": end_date_local.isoformat(),
        "status": status,
        "unlockDateLocal": start_date_local.isoformat(),
        "lockedReason": locked_reason,
    }
