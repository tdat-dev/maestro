from orchestrator.config import default_config, load_config, AgentConfig


def test_default_config_has_three_roles():
    cfg = default_config()
    assert set(cfg.agents) == {"scout", "builder", "reviewer"}
    assert cfg.max_iterations == 6
    assert cfg.sentry.enabled is False


def test_default_role_cli_mapping():
    cfg = default_config()
    assert cfg.agents["scout"].args[0] == "claude"
    assert cfg.agents["builder"].args[0] == "codex"
    assert cfg.agents["reviewer"].args[0] == "gemini"


def test_load_config_none_returns_defaults():
    cfg = load_config(None)
    assert cfg.max_iterations == 6


def test_load_config_overlays_yaml(tmp_path):
    p = tmp_path / "cfg.yaml"
    p.write_text(
        "max_iterations: 3\n"
        "agents:\n"
        "  builder:\n"
        "    args: [claude, -p]\n",
        encoding="utf-8",
    )
    cfg = load_config(str(p))
    assert cfg.max_iterations == 3
    assert cfg.agents["builder"].args == ["claude", "-p"]
    # untouched roles keep defaults
    assert cfg.agents["scout"].args[0] == "claude"
    assert isinstance(cfg.agents["reviewer"], AgentConfig)
