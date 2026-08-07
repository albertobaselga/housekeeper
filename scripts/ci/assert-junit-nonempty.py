#!/usr/bin/env python3
"""Fail unless one or more JUnit files contain at least one testcase."""

from __future__ import annotations

import glob
import sys
import xml.etree.ElementTree as ET


def usage() -> None:
    print(f"Usage: {sys.argv[0]} <junit-file-or-glob> [...]", file=sys.stderr)


def test_count(path: str) -> int:
    root = ET.parse(path).getroot()
    cases = root.findall(".//testcase")
    return len(cases)


def main() -> int:
    if len(sys.argv) < 2:
        usage()
        return 64

    paths: list[str] = []
    for pattern in sys.argv[1:]:
        matches = glob.glob(pattern, recursive=True)
        paths.extend(matches)

    unique_paths = sorted(set(paths))
    if not unique_paths:
        print("Quality gate failed: no JUnit files matched.", file=sys.stderr)
        return 65

    total = 0
    try:
        for path in unique_paths:
            count = test_count(path)
            total += count
            print(f"{path}: {count} testcases")
    except (OSError, ET.ParseError) as exc:
        print(f"Quality gate failed: invalid JUnit report: {exc}", file=sys.stderr)
        return 65

    if total == 0:
        print("Quality gate failed: JUnit reports contain zero testcases.", file=sys.stderr)
        return 65

    print(f"JUnit gate passed: {total} testcases across {len(unique_paths)} file(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
