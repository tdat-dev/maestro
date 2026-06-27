from __future__ import annotations


def scout_prompt(goal: str, mode: str, repo_listing: str) -> str:
    return (
        "You are the Scout. Survey the working directory and produce a short "
        "implementation plan for the Builder.\n"
        f"Mode: {mode} (create = scaffold a new project, edit = modify existing code).\n"
        f"Goal: {goal}\n\n"
        f"Files present:\n{repo_listing}\n\n"
        "Reply with a concise plan as a fenced ```json block: "
        '{\"plan\": \"...\", \"tasks\": [\"...\"]}.'
    )


def builder_prompt(goal: str, plan: str, errors_text: str, review_notes: str) -> str:
    return (
        "You are the Builder. Implement the plan by creating/editing files in the "
        "current working directory. Make all changes directly on disk.\n"
        f"Goal: {goal}\n\n"
        f"Plan:\n{plan}\n\n"
        f"Errors from the last test run (fix these):\n{errors_text}\n\n"
        f"Reviewer feedback (address these):\n{review_notes or '(none yet)'}\n\n"
        "When done, briefly summarise what you changed."
    )


def reviewer_prompt(goal: str, plan: str, errors_text: str) -> str:
    return (
        "You are the Reviewer. Judge whether the goal is met and the code is sound.\n"
        f"Goal: {goal}\n\n"
        f"Plan:\n{plan}\n\n"
        f"Latest test/error output:\n{errors_text}\n\n"
        "Reply ONLY with a fenced ```json block: "
        '{\"approved\": true|false, \"blocking\": [\"...\"], \"notes\": \"...\"}. '
        "Approve only if the goal is met and there are no blocking issues."
    )
