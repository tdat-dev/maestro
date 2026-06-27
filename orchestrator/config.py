from __future__ import annotations

from dataclasses import dataclass, field, replace

import yaml


@dataclass
class AgentConfig:
    args: list[str]
    prompt_via: str = "stdin"  # "stdin" | "arg"
    timeout: int = 600


@dataclass
class SentryConfig:
    enabled: bool = False
    base_url: str = ""
    token: str = ""
    org: str = ""
    project: str = ""


@dataclass
class Config:
    agents: dict[str, AgentConfig]
    max_iterations: int = 6
    test_command: list[str] | None = None
    sentry: SentryConfig = field(default_factory=SentryConfig)


def default_config() -> Config:
    return Config(
        agents={
            "scout": AgentConfig(args=["claude", "-p"]),
            "builder": AgentConfig(args=["codex", "exec"]),
            "reviewer": AgentConfig(args=["gemini", "-p"]),
        },
        max_iterations=6,
        test_command=None,
        sentry=SentryConfig(),
    )


def load_config(path: str | None) -> Config:
    cfg = default_config()
    if path is None:
        return cfg
    with open(path, "r", encoding="utf-8") as fh:
        data = yaml.safe_load(fh) or {}

    if "max_iterations" in data:
        cfg = replace(cfg, max_iterations=int(data["max_iterations"]))
    if "test_command" in data:
        cfg = replace(cfg, test_command=list(data["test_command"]))
    if "agents" in data:
        for role, overrides in (data["agents"] or {}).items():
            base = cfg.agents.get(role, AgentConfig(args=[]))
            cfg.agents[role] = replace(
                base,
                **{k: v for k, v in overrides.items() if k in {"args", "prompt_via", "timeout"}},
            )
    if "sentry" in data:
        s = data["sentry"] or {}
        cfg = replace(cfg, sentry=replace(cfg.sentry, **{
            k: v for k, v in s.items()
            if k in {"enabled", "base_url", "token", "org", "project"}
        }))
    return cfg


# Convenience presets: point ALL three roles at a single CLI in one flag.
# Builder needs to write files, so each preset enables that CLI's write mode.
CLI_PRESETS: dict[str, AgentConfig] = {
    "claude": AgentConfig(args=["claude", "-p", "--dangerously-skip-permissions"], prompt_via="stdin"),
    "codex": AgentConfig(args=["codex", "exec", "-s", "workspace-write"], prompt_via="stdin"),
    "gemini": AgentConfig(args=["gemini", "-p"], prompt_via="arg"),
}


def apply_cli(cfg: Config, name: str) -> Config:
    """Override Scout, Builder and Reviewer to all use the named CLI.

    Known names (claude/codex/gemini) get a sensible headless+write template;
    any other name is treated as a bare executable run via stdin. A fresh
    AgentConfig is assigned per role so later per-role tweaks don't alias.
    """
    preset = CLI_PRESETS.get(name, AgentConfig(args=[name], prompt_via="stdin"))
    for role in ("scout", "builder", "reviewer"):
        cfg.agents[role] = AgentConfig(
            args=list(preset.args), prompt_via=preset.prompt_via, timeout=preset.timeout,
        )
    return cfg
