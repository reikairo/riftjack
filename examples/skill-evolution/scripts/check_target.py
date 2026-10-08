#!/usr/bin/env python3
"""Inspect one extracted local destination; never certify link validity."""
import argparse
import json
from pathlib import Path
import re
import stat


def check_target(source: str, destination: str) -> dict:
    fragment = "not_checked" if "#" in destination else "absent"

    def result(file: str, reason: str) -> dict:
        return {"file": file, "fragment": fragment, "reason": reason}

    try:
        document = Path(source).resolve(strict=True)
        if not stat.S_ISREG(document.stat().st_mode):
            return result("error", "source_not_regular_file")
    except (OSError, RuntimeError, ValueError):
        return result("error", "source_unavailable")

    path = destination.split("#", 1)[0]
    if not path:
        return result("not_checked", "fragment_only_or_empty")
    if re.match(r"^[A-Za-z][A-Za-z0-9+.-]*:", path) or path.startswith("//"):
        return result("not_checked", "url_or_scheme")
    if Path(path).is_absolute():
        return result("not_checked", "absolute_path")
    if any(c in destination for c in ("%", "?", "\\", "<", ">")) or any(
        ord(c) < 32 or ord(c) == 127 for c in destination
    ):
        return result("not_checked", "unsupported_syntax")

    if path.endswith("/") or any(part in (".", "..") for part in path.split("/")):
        return result("not_checked", "dot_segment_or_trailing_slash")

    root = document.parent
    try:
        target = (root / path).resolve(strict=False)
        try:
            target.relative_to(root)
        except ValueError:
            return result("not_checked", "outside_document_tree")
        mode = target.stat().st_mode
    except FileNotFoundError:
        return result("missing", "target_missing")
    except NotADirectoryError:
        return result("missing", "parent_not_directory")
    except (OSError, RuntimeError, ValueError):
        return result("error", "target_unavailable")
    if not stat.S_ISREG(mode):
        return result("not_checked", "target_not_regular_file")
    return result("present", "regular_file_exists")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", help="Existing source document")
    parser.add_argument("destination", help="One already extracted destination")
    args = parser.parse_args()
    report = check_target(args.source, args.destination)
    print(json.dumps(report, ensure_ascii=True))
    return 1 if report["file"] == "error" else 0


if __name__ == "__main__":
    raise SystemExit(main())
