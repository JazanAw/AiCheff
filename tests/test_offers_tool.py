from __future__ import annotations

import json
import shutil
from datetime import datetime
from pathlib import Path

from offers_tool.core import BERLIN_TZ, run_pipeline


def copy_fixtures(target_dir: Path) -> None:
    fixture_dir = Path(__file__).parent / "fixtures"
    for file_path in fixture_dir.glob("*.json"):
        shutil.copy(file_path, target_dir / file_path.name)


def load_offers(path: Path) -> list[dict]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    return payload["offers"]


def test_national_coverage_and_regional_split(tmp_path: Path) -> None:
    input_dir = tmp_path / "data"
    out_dir = tmp_path / "out"
    input_dir.mkdir()
    copy_fixtures(input_dir)

    result = run_pipeline(
        input_dir=input_dir,
        out_dir=out_dir,
        national_threshold=0.80,
        mode="overlap",
        now=datetime(2026, 2, 10, 12, 0, tzinfo=BERLIN_TZ),
    )

    assert result["snapshots"] == 3

    national = load_offers(out_dir / "national_food_offers.json")
    titles = {offer["title"] for offer in national}
    assert "Bio Bananen" in titles
    assert "Avocado Hass" not in titles


def test_nonfood_is_flagged_with_reason(tmp_path: Path) -> None:
    input_dir = tmp_path / "data"
    out_dir = tmp_path / "out"
    input_dir.mkdir()
    copy_fixtures(input_dir)

    run_pipeline(
        input_dir=input_dir,
        out_dir=out_dir,
        national_threshold=0.80,
        mode="overlap",
        now=datetime(2026, 2, 10, 12, 0, tzinfo=BERLIN_TZ),
    )

    flagged = load_offers(out_dir / "flagged_nonfood.json")
    candle = next(offer for offer in flagged if offer["title"] == "Schneemann Duftkerze Vanille")
    assert candle["food_flag"] == "nonfood"
    assert any(reason.startswith("keyword:kerze") or reason.startswith("keyword:duftkerze") for reason in candle["reasons"])


def test_overlap_mode_keeps_long_running_offer(tmp_path: Path) -> None:
    input_dir = tmp_path / "data"
    out_dir = tmp_path / "out"
    input_dir.mkdir()
    copy_fixtures(input_dir)

    run_pipeline(
        input_dir=input_dir,
        out_dir=out_dir,
        national_threshold=0.80,
        mode="overlap",
        now=datetime(2026, 2, 10, 12, 0, tzinfo=BERLIN_TZ),
    )

    national = load_offers(out_dir / "national_food_offers.json")
    assert any(offer["title"] == "Olivenoel Premium" for offer in national)


def test_starts_mode_moves_long_running_offer_to_flagged_out_of_week(tmp_path: Path) -> None:
    input_dir = tmp_path / "data"
    out_dir = tmp_path / "out"
    input_dir.mkdir()
    copy_fixtures(input_dir)

    run_pipeline(
        input_dir=input_dir,
        out_dir=out_dir,
        national_threshold=0.80,
        mode="starts",
        now=datetime(2026, 2, 10, 12, 0, tzinfo=BERLIN_TZ),
    )

    national = load_offers(out_dir / "national_food_offers.json")
    assert not any(offer["title"] == "Olivenoel Premium" for offer in national)

    out_of_week = load_offers(out_dir / "flagged_out_of_week.json")
    assert any(offer["title"] == "Olivenoel Premium" for offer in out_of_week)


def test_unsure_supplement_is_marked_unsure_not_nonfood(tmp_path: Path) -> None:
    input_dir = tmp_path / "data"
    out_dir = tmp_path / "out"
    input_dir.mkdir()

    snapshot_payload = {
        "snapshotId": "10115",
        "offers": [
            {
                "storeChain": "Kaufland",
                "name": "Tetesept Immun Aktiv Shot",
                "price": 1.99,
                "unit": "60ml",
                "validityStart": "2026-02-09T06:00:00.000Z",
                "validityEnd": "2026-02-14T22:59:59.000Z",
                "category": "Sonstiges",
                "postalCode": "10115",
            }
        ],
    }

    for zip_code in ("10115", "20095", "80331"):
        payload = {**snapshot_payload, "snapshotId": zip_code}
        payload["offers"][0]["postalCode"] = zip_code
        (input_dir / f"snapshot_{zip_code}.json").write_text(
            json.dumps(payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    run_pipeline(
        input_dir=input_dir,
        out_dir=out_dir,
        national_threshold=0.80,
        mode="overlap",
        now=datetime(2026, 2, 10, 12, 0, tzinfo=BERLIN_TZ),
    )

    national = load_offers(out_dir / "national_food_offers.json")
    shot = next(offer for offer in national if offer["title"] == "Tetesept Immun Aktiv Shot")
    assert shot["food_flag"] == "unsure"
    assert any(reason.startswith("unsure:") for reason in shot["reasons"])
