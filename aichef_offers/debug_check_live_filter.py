from __future__ import annotations

import argparse
import json
import tempfile
from collections import Counter
from datetime import datetime
from pathlib import Path
from typing import Any

from offers_categorizer.core import BERLIN_TZ

from aichef_offers.core import RunConfig, detect_food_rescue, run_pipeline


def _extract_offers(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    if not isinstance(payload, dict):
        return []
    for key in ("offers", "liveOffers", "filteredOffers", "items", "data"):
        value = payload.get(key)
        if isinstance(value, list):
            return [item for item in value if isinstance(item, dict)]
    return []


def _load_file(path: Path) -> list[dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8-sig"))
    return _extract_offers(payload)


def _offer_key(offer: dict[str, Any]) -> str:
    name = str(offer.get("title") or offer.get("name") or "").strip().lower()
    chain = str(offer.get("chain") or offer.get("storeChain") or "").strip().lower()
    price = str(offer.get("price") or "").strip()
    start = str(offer.get("validityStart") or "").strip()
    end = str(offer.get("validityEnd") or "").strip()
    return "|".join([name, chain, price, start, end])


def _build_run_config(input_dir: Path, out_dir: Path, as_of: str | None) -> RunConfig:
    return RunConfig(
        input_dir=input_dir,
        out_dir=out_dir,
        mode="overlap",
        as_of=as_of,
        week_start=None,
        week_window="calendar",
        week_end_day=None,
        include_locked=True,
        emit_visible=True,
        ollama_on=False,
        ollama_url="http://localhost:11434",
        ollama_model="qwen2.5:14b-instruct",
        ollama_timeout=20,
        national_on=True,
        national_threshold=0.8,
        min_rule_score=3.0,
        min_margin=1.5,
        embeddings_on=False,
        knn_k=5,
        knn_threshold=0.7,
        keywords_file=None,
        nutrition_on=False,
        nutrition_source="both",
        nutrition_ttl_days=30,
        max_off_req_per_min=80,
        bls_path=Path("data/bls"),
        diet_on=False,
        halal_on=False,
        veg_implies_halal=True,
        dump_stats=False,
    )


def run_debug_check(live_path: Path, filter_path: Path, as_of: str | None = None) -> dict[str, Any]:
    live_offers = _load_file(live_path)
    filter_offers = _load_file(filter_path)

    combined: dict[str, dict[str, Any]] = {}
    for offer in [*live_offers, *filter_offers]:
        key = _offer_key(offer)
        if not key:
            continue
        combined[key] = offer

    with tempfile.TemporaryDirectory(prefix="aichef_debug_live_filter_") as temp_root:
        temp_root_path = Path(temp_root)
        input_dir = temp_root_path / "input"
        out_dir = temp_root_path / "out"
        input_dir.mkdir(parents=True, exist_ok=True)
        (input_dir / "snapshot.json").write_text(
            json.dumps({"snapshotId": "debug", "offers": list(combined.values())}, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

        config = _build_run_config(input_dir, out_dir, as_of)
        run_pipeline(config)

        all_in_week_payload = json.loads((out_dir / "all_in_week.json").read_text(encoding="utf-8"))
        flagged_nonfood_payload = json.loads((out_dir / "flagged_nonfood.json").read_text(encoding="utf-8"))
        all_in_week = _extract_offers(all_in_week_payload)
        flagged_nonfood = _extract_offers(flagged_nonfood_payload)

        rerun_index = {_offer_key(offer): offer for offer in [*all_in_week, *flagged_nonfood]}
        legacy_wrongly_filtered: list[dict[str, Any]] = []
        for original in filter_offers:
            rerun_offer = rerun_index.get(_offer_key(original))
            if not rerun_offer:
                continue
            canonical = rerun_offer.get("canonicalCategory") if isinstance(rerun_offer.get("canonicalCategory"), dict) else {}
            if rerun_offer.get("foodFlag") != "nonfood" and canonical.get("isNonFood") is not True:
                legacy_wrongly_filtered.append(
                    {
                        "name": rerun_offer.get("title") or rerun_offer.get("name"),
                        "chain": rerun_offer.get("chain") or rerun_offer.get("storeChain"),
                        "foodFlag": rerun_offer.get("foodFlag"),
                        "main": canonical.get("main"),
                        "sub": canonical.get("sub"),
                    }
                )

        rerun_false_positives: list[dict[str, Any]] = []
        for offer in flagged_nonfood:
            rescue = detect_food_rescue(offer)
            canonical = offer.get("canonicalCategory") if isinstance(offer.get("canonicalCategory"), dict) else {}
            if rescue is not None or (canonical.get("main") not in {"Non-Food", None} and offer.get("foodFlag") != "nonfood"):
                rerun_false_positives.append(
                    {
                        "name": offer.get("title") or offer.get("name"),
                        "chain": offer.get("chain") or offer.get("storeChain"),
                        "foodFlag": offer.get("foodFlag"),
                        "main": canonical.get("main"),
                        "sub": canonical.get("sub"),
                    }
                )

        reason_counter: Counter[str] = Counter()
        for offer in flagged_nonfood:
            for reason in offer.get("nonfoodReasons", []) if isinstance(offer.get("nonfoodReasons"), list) else []:
                reason_counter[str(reason)] += 1
            canonical = offer.get("canonicalCategory")
            if isinstance(canonical, dict):
                for reason in canonical.get("reasons", []) if isinstance(canonical.get("reasons"), list) else []:
                    text = str(reason)
                    if text.startswith("nonfood_kw:") or text.startswith("nonfood_department:"):
                        reason_counter[text] += 1

        return {
            "live_offers_count": len(live_offers),
            "filter_offers_count": len(filter_offers),
            "rerun_flagged_nonfood_count": len(flagged_nonfood),
            "filter_food_drink_false_positive_count": len(rerun_false_positives),
            "filter_food_drink_false_positives": rerun_false_positives[:50],
            "legacy_input_filter_mismatch_count": len(legacy_wrongly_filtered),
            "legacy_input_filter_mismatches": legacy_wrongly_filtered[:50],
            "top_nonfood_reasons": reason_counter.most_common(20),
            "checked_at": datetime.now(BERLIN_TZ).isoformat(),
        }


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Debug check for live/filter offer files")
    parser.add_argument("--live", required=True, type=Path, help="Path to live JSON export")
    parser.add_argument("--filter", required=True, type=Path, help="Path to filter JSON export")
    parser.add_argument("--as-of", default=None, help="Optional as-of date (YYYY-MM-DD)")
    args = parser.parse_args(argv)

    result = run_debug_check(args.live, args.filter, args.as_of)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
