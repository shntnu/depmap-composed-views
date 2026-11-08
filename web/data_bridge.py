# /// script
# requires-python = ">=3.12,<3.14"
# dependencies = [
#     "altair==5.5.0",
#     "marimo",
#     "polars==1.40.1",
#     "requests==2.32.5",
# ]
# ///
"""Expose the catalog's verified query as a JSON-only command-line tool."""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python" / "notebooks"))
from nb06_verified_dependency_query import verified_dependency_query  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gene", default="KRAS")
    parser.add_argument("--lineage", default="Lung")
    parser.add_argument("--expected-release")
    parser.add_argument("--output", type=Path, help="Also save the complete evidence JSON to this path.")
    args = parser.parse_args(argv)
    try:
        result = verified_dependency_query(args.gene, args.lineage, expected_release=args.expected_release)
        serialized = json.dumps(result, indent=2, allow_nan=False) + "\n"
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(serialized, encoding="utf-8")
        sys.stdout.write(serialized)
    except Exception as error:
        print(f"DepMap query failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
