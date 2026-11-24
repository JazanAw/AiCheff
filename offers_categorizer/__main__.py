from __future__ import annotations

import json
import sys

from .core import OllamaFailFastError, parse_args, run_pipeline

PROGRESS_PREFIX = "__AICHEF_PROGRESS__"

# Dedicated non-zero exit code for an Ollama fail-fast abort. The TypeScript
# bridge treats any non-zero exit as a failure and surfaces stderr; this code
# lets logs/tests tell "Ollama died" apart from a generic crash.
EXIT_OLLAMA_FAIL_FAST = 3


def main() -> None:
    args = parse_args()

    def emit_progress(payload: dict[str, object]) -> None:
        print(
            f"{PROGRESS_PREFIX}{json.dumps(payload, ensure_ascii=False)}",
            flush=True,
        )

    try:
        result = run_pipeline(
            input_dir=args.input,
            out_dir=args.out,
            mode=args.mode,
            ollama_mode=args.ollama,
            model=args.model,
            ollama_host=args.ollama_host,
            week_start_iso=args.week_start,
            week_window_mode=args.week_window,
            week_end_day=args.week_end_day,
            min_rule_score=args.min_rule_score,
            use_llm_threshold=args.use_llm_threshold,
            dump_stats=args.dump_stats,
            taxonomy_path=args.taxonomy,
            cache_path=args.cache,
            on_progress=emit_progress,
            llm_timeout_seconds=max(3, int(args.ollama_timeout)),
            max_consecutive_failures=max(0, int(args.ollama_max_consecutive_failures)),
            item_retries=max(0, int(args.ollama_retries)),
        )
    except OllamaFailFastError as exc:
        print(str(exc), file=sys.stderr, flush=True)
        sys.exit(EXIT_OLLAMA_FAIL_FAST)

    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
