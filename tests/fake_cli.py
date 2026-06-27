"""A stand-in for a real AI CLI. Reads a prompt from stdin and emits
canned output controlled by argv, so the graph can be driven offline.

Usage in tests:
  command = [sys.executable, "tests/fake_cli.py", "--emit", "<text>"]
  command = [sys.executable, "tests/fake_cli.py", "--fail"]
  command = [sys.executable, "tests/fake_cli.py", "--touch", "<relpath>"]
"""
import argparse
import sys


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--emit", default="")
    ap.add_argument("--touch", default="")
    ap.add_argument("--fail", action="store_true")
    args = ap.parse_args()

    _prompt = sys.stdin.read()  # consume stdin like a real CLI

    if args.touch:
        with open(args.touch, "w", encoding="utf-8") as fh:
            fh.write("generated\n")

    if args.emit:
        sys.stdout.write(args.emit)

    return 1 if args.fail else 0


if __name__ == "__main__":
    raise SystemExit(main())
