"""Fail-fast + CLI plumbing for the Ollama category LLM.

These guard the production failure mode: Ollama kept returning HTTP 500 while a
scan ground through thousands of offers for hours. The classifier must now abort
after N consecutive transport-level failures instead of soldiering on."""
from __future__ import annotations

from pathlib import Path

import pytest

from offers_categorizer.core import (
    DEFAULT_TAXONOMY_PATH,
    LLMClassifier,
    OllamaFailFastError,
    OllamaRequestError,
    load_taxonomy,
    parse_args,
)


class _FakeOffer:
    """Minimal stand-in — classify() only needs a `.fingerprint` before it hits
    the (patched) _request_ollama call."""

    fingerprint = "fp-test"


def _make_classifier(tmp_path: Path, max_failures: int) -> LLMClassifier:
    # Echte Taxonomie: der Classifier bildet daraus die Cache-Signatur.
    return LLMClassifier(
        taxonomy=load_taxonomy(DEFAULT_TAXONOMY_PATH),
        enabled=True,
        host="http://localhost:11434",
        model="qwen3:14b",
        cache_path=tmp_path / "cache.sqlite",
        use_llm_threshold=0.72,
        timeout_seconds=5,
        max_consecutive_failures=max_failures,
    )


def test_fail_fast_aborts_after_consecutive_failures_when_ollama_dead(tmp_path: Path) -> None:
    clf = _make_classifier(tmp_path, max_failures=3)

    def boom(_offer: object) -> dict:
        raise OllamaRequestError("HTTP Error 500: Internal Server Error")

    clf._request_ollama = boom  # type: ignore[assignment]
    clf.ollama_healthy = lambda: False  # Ollama is genuinely down → abort allowed.
    offer = _FakeOffer()

    # First two transport failures degrade softly (None), counting up...
    assert clf.classify(offer) is None
    assert clf.classify(offer) is None
    # ...the third trips the fail-fast abort because the health check says dead.
    with pytest.raises(OllamaFailFastError):
        clf.classify(offer)
    assert clf.consecutive_failures == 3


def test_item_timeouts_do_not_abort_when_ollama_healthy(tmp_path: Path) -> None:
    """A loaded-but-slow model: every item times out, but /api/ps shows it loaded.
    The run must NOT abort — the items are skipped (timeout) and flagged later."""
    clf = _make_classifier(tmp_path, max_failures=3)

    def slow(_offer: object) -> dict:
        raise OllamaRequestError("timed out")

    clf._request_ollama = slow  # type: ignore[assignment]
    clf.ollama_healthy = lambda: True  # model still loaded → keep going
    offer = _FakeOffer()

    for _ in range(12):  # well past the 3-in-a-row threshold
        assert clf.classify(offer) is None  # never raises
        assert clf.last_outcome == "timeout"
    assert clf.timeout_count == 12
    # The streak is reset at each health-confirmed threshold, so it never aborts.
    assert clf.consecutive_failures < clf.max_consecutive_failures


def test_item_retry_recovers_within_budget(tmp_path: Path) -> None:
    clf = _make_classifier(tmp_path, max_failures=3)
    clf.item_retries = 1  # one retry per item
    calls = {"n": 0}

    def flaky(_offer: object):
        calls["n"] += 1
        if calls["n"] % 2 == 1:
            raise OllamaRequestError("timed out")  # first attempt fails
        return None  # retry: transport ok (payload unusable here)

    clf._request_ollama = flaky  # type: ignore[assignment]
    offer = _FakeOffer()

    assert clf.classify(offer) is None
    assert calls["n"] == 2  # retried once
    assert clf.last_outcome == "invalid"  # transport recovered, payload empty
    assert clf.consecutive_failures == 0  # not counted as a timeout


def test_item_retries_default_zero_keeps_single_attempt(tmp_path: Path) -> None:
    clf = _make_classifier(tmp_path, max_failures=0)
    calls = {"n": 0}

    def boom(_offer: object) -> dict:
        calls["n"] += 1
        raise OllamaRequestError("timed out")

    clf._request_ollama = boom  # type: ignore[assignment]
    clf.classify(_FakeOffer())
    assert calls["n"] == 1  # default: no retry


def test_fail_fast_counter_resets_on_success(tmp_path: Path) -> None:
    clf = _make_classifier(tmp_path, max_failures=3)
    calls = {"n": 0}

    def flaky(_offer: object):
        calls["n"] += 1
        if calls["n"] <= 2:
            raise OllamaRequestError("timeout")
        return None  # transport ok (Ollama alive), payload just unusable

    clf._request_ollama = flaky  # type: ignore[assignment]
    offer = _FakeOffer()

    clf.classify(offer)  # fail 1
    clf.classify(offer)  # fail 2
    assert clf.consecutive_failures == 2
    clf.classify(offer)  # transport success -> streak resets
    assert clf.consecutive_failures == 0


def test_fail_fast_disabled_by_default(tmp_path: Path) -> None:
    # max_consecutive_failures=0 keeps the legacy "never abort" behaviour.
    clf = _make_classifier(tmp_path, max_failures=0)

    def boom(_offer: object) -> dict:
        raise OllamaRequestError("HTTP 500")

    clf._request_ollama = boom  # type: ignore[assignment]
    offer = _FakeOffer()
    for _ in range(10):
        assert clf.classify(offer) is None  # never raises


def test_cli_accepts_timeout_and_failfast_args() -> None:
    args = parse_args(
        [
            "--input",
            "in",
            "--out",
            "out",
            "--ollama-timeout",
            "240",
            "--ollama-max-consecutive-failures",
            "3",
            "--ollama-retries",
            "1",
        ]
    )
    assert args.ollama_timeout == 240
    assert args.ollama_max_consecutive_failures == 3
    assert args.ollama_retries == 1
