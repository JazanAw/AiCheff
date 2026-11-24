"""Laufzeit-Schutz fuer den Kategorie-LLM: IPv4-Host und Schema-Reihenfolge.

Beides stammt aus der Messung eines Scans, der fuer 2.217 Angebote ~2 Stunden
brauchte: 2,04 s je Aufruf gingen fuer den IPv6-Umweg von `localhost` drauf, und
69 % der erzeugten Zeichen entfielen auf die Begruendungen NACH der Entscheidung.
Die Tests halten beide Korrekturen fest — inklusive der Falle, dass ein optionales
`reasons` die Confidence systematisch verschiebt."""
from __future__ import annotations

import pytest

from offers_categorizer.core import (
    DEFAULT_TAXONOMY_PATH,
    LLMClassifier,
    build_category_schema,
    load_taxonomy,
    normalize_ollama_host,
)


@pytest.mark.parametrize(
    ("host", "expected"),
    [
        ("http://localhost:11434", "http://127.0.0.1:11434"),
        ("http://localhost:11434/", "http://127.0.0.1:11434"),
        ("http://localhost", "http://127.0.0.1"),
        ("https://localhost:443/ollama", "https://127.0.0.1:443/ollama"),
    ],
)
def test_localhost_wird_auf_ipv4_gezogen(host: str, expected: str) -> None:
    assert normalize_ollama_host(host) == expected


@pytest.mark.parametrize(
    "host",
    [
        "http://127.0.0.1:11434",
        "http://0.0.0.0:11434",
        "http://192.168.100.67:11434",
        "http://ollama.intern:11434",
        "http://[::1]:11434",
    ],
)
def test_andere_hosts_bleiben_unveraendert(host: str) -> None:
    """Nur `localhost` ist doppeldeutig — ein bewusst gesetzter Host (auch eine
    explizite IPv6-Adresse) darf nicht umgebogen werden."""
    assert normalize_ollama_host(host) == host


def test_leerer_host_bleibt_leer() -> None:
    assert normalize_ollama_host("") == ""
    assert normalize_ollama_host("   ") == ""


def test_classifier_normalisiert_den_host_beim_bauen(tmp_path) -> None:
    """Die Korrektur muss unabhaengig von der Quelle greifen: .env, CLI-Default
    und Bridge liefern alle denselben `localhost`-String."""
    classifier = LLMClassifier(
        taxonomy=load_taxonomy(DEFAULT_TAXONOMY_PATH),
        enabled=True,
        host="http://localhost:11434/",
        model="qwen3:14b",
        cache_path=tmp_path / "cache.jsonl",
        use_llm_threshold=0.72,
    )
    assert classifier.host == "http://127.0.0.1:11434"


def test_reasons_ist_pflicht_und_steht_am_ende() -> None:
    """Structured Outputs erzeugen in Schema-Reihenfolge.

    `reasons` muss LETZTES Feld bleiben (sonst wird die Begruendung zur
    Chain-of-Thought und beeinflusst das Urteil) und PFLICHT bleiben: als
    optionales Feld verbietet die Grammatik hinter der Confidence das Komma,
    das Modell haengt eine weitere Ziffer an und die Confidence steigt
    systematisch um +0,05."""
    schema = build_category_schema(load_taxonomy(DEFAULT_TAXONOMY_PATH))

    assert list(schema["properties"]) == ["main", "sub", "isNonFood", "confidence", "reasons"]
    assert "reasons" in schema["required"]
    assert schema["properties"]["reasons"]["maxItems"] == 1


def test_entscheidungsfelder_stehen_vor_reasons() -> None:
    """Explizit gegen ein Umsortieren beim naechsten Prompt-Tuning."""
    properties = list(build_category_schema(load_taxonomy(DEFAULT_TAXONOMY_PATH))["properties"])
    for field in ("main", "sub", "isNonFood", "confidence"):
        assert properties.index(field) < properties.index("reasons")
