from __future__ import annotations

import argparse
import sys

from orchestrator.config import apply_cli, load_config
from orchestrator.graph import build_graph


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="orchestrator")
    sub = parser.add_subparsers(dest="cmd", required=True)
    run = sub.add_parser("run", help="Run the Scout/Builder/Reviewer loop")
    run.add_argument("--repo", required=True)
    run.add_argument("--goal", required=True)
    run.add_argument("--config", default=None)
    run.add_argument("--cli", default=None,
                     help="Use one CLI for all three roles (e.g. claude, codex, gemini). "
                          "Overrides roles from --config/defaults.")
    run.add_argument("--max-iters", type=int, default=None)
    run.add_argument("--branch", default="agent/run")
    args = parser.parse_args(argv)

    config = load_config(args.config)
    if args.cli:
        config = apply_cli(config, args.cli)
    if args.max_iters is not None:
        config.max_iterations = args.max_iters

    app = build_graph(config)
    initial = {
        "goal": args.goal,
        "repo_path": args.repo,
        "branch": args.branch,
        "max_iterations": config.max_iterations,
    }

    # FIX 7: recursion limit scales with max_iterations so a large --max-iters
    # never hits GraphRecursionError before finalize_maxed fires.
    recursion_limit = max(30, 4 * config.max_iterations + 12)

    # FIX 8: wrap invoke so any unexpected exception prints a clean one-liner.
    try:
        final = app.invoke(initial, config={"recursion_limit": recursion_limit})
    except Exception as exc:
        print(f"Orchestrator error: {exc}")
        return 1

    outcome = final.get("outcome", "failed")
    print(f"Orchestrator finished: {outcome} "
          f"(iterations={final.get('iteration', 0)})")
    return 0 if outcome == "success" else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
