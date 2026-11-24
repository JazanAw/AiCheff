from __future__ import annotations

import json
from pathlib import Path

from .core import parse_args, run_pipeline


def main() -> None:
    args = parse_args()
    result = run_pipeline(
        input_dir=Path(args.input),
        out_dir=Path(args.out),
        national_threshold=args.national_threshold,
        mode=args.mode,
        drop_unsure=args.drop_unsure,
        keywords_file=Path(args.keywords_file) if args.keywords_file else None,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
