from __future__ import annotations

import argparse
import sys

from orchestrator.config import load_config
from orchestrator.graph import build_graph


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="orchestrator")
    sub = parser.add_subparsers(dest="cmd", required=True)
    run = sub.add_parser("run", help="Run the Scout/Builder/Reviewer loop")
    run.add_argument("--repo", required=True)
    run.add_argument("--goal", required=True)
    run.add_argument("--config", default=None)
    run.add_argument("--max-iters", type=int, default=None)
    run.add_argument("--branch", default="agent/run")
    args = parser.parse_args(argv)

    config = load_config(args.config)
    if args.max_iters is not None:
        config.max_iterations = args.max_iters

    app = build_graph(config)
    initial = {
        "goal": args.goal,
        "repo_path": args.repo,
        "branch": args.branch,
        "max_iterations": config.max_iterations,
    }
    final = app.invoke(initial, config={"recursion_limit": 100})
    outcome = final.get("outcome", "failed")
    print(f"Orchestrator finished: {outcome} "
          f"(iterations={final.get('iteration', 0)})")
    return 0 if outcome == "success" else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
