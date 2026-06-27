from orchestrator.config import apply_cli, default_config, load_config, AgentConfig


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


def test_apply_cli_claude_sets_all_roles_to_claude():
    cfg = apply_cli(default_config(), "claude")
    for role in ("scout", "builder", "reviewer"):
        assert cfg.agents[role].args[0] == "claude"
        assert cfg.agents[role].prompt_via == "stdin"
    # builder gets write permission so it can create/edit files
    assert "--dangerously-skip-permissions" in cfg.agents["builder"].args


def test_apply_cli_gemini_uses_arg_prompt():
    cfg = apply_cli(default_config(), "gemini")
    assert cfg.agents["reviewer"].args[0] == "gemini"
    assert cfg.agents["reviewer"].prompt_via == "arg"


def test_apply_cli_unknown_name_is_bare_executable():
    cfg = apply_cli(default_config(), "my-cli")
    assert cfg.agents["builder"].args == ["my-cli"]
    # fresh object per role — not the same instance aliased across roles
    assert cfg.agents["scout"] is not cfg.agents["builder"]
