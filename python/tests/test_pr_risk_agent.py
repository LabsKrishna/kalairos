"""Tests for the pr_risk agent — Phase 3.1.

Covers tool wiring (subprocess shell-out + error handling) and agent
construction. The real-LLM integration is exercised by
`tests/test_integration.py` when `ANTHROPIC_API_KEY` is set.
"""

import subprocess

import pytest

from kalairos.agents.pr_risk import (
    PR_RISK_INSTRUCTIONS,
    build_pr_risk_agent,
    fetch_pr_diff,
    fetch_pr_files,
)


# ── Agent construction ────────────────────────────────────────────────────


def test_build_pr_risk_agent_has_expected_shape():
    agent = build_pr_risk_agent()
    assert agent.name == "pr-risk-analyzer"
    assert "fetch_pr_diff" in agent.tools
    assert "fetch_pr_files" in agent.tools
    assert agent.instructions == PR_RISK_INSTRUCTIONS


def test_agent_instructions_mention_load_bearing_terms():
    """The system prompt is what the LLM sees. Guard the key vocabulary
    from drifting silently — these terms are how the prompt steers
    the model's behavior."""
    text = PR_RISK_INSTRUCTIONS.lower()
    assert "critical" in text
    assert "doc" in text
    assert "test" in text
    assert "verdict" in text
    assert "fetch_pr_files" in text
    assert "fetch_pr_diff" in text


def test_build_pr_risk_agent_returns_fresh_instances():
    """Each call returns a new Agent — callers can build per-run if they
    want isolation, or reuse one across runs."""
    a = build_pr_risk_agent()
    b = build_pr_risk_agent()
    assert a is not b
    assert a.name == b.name


# ── fetch_pr_files ────────────────────────────────────────────────────────


def test_fetch_pr_files_returns_stdout_on_success(monkeypatch):
    fake = subprocess.CompletedProcess(
        args=[],
        returncode=0,
        stdout="src/index.js\nREADME.md\ntests/test_x.py\n",
        stderr="",
    )
    monkeypatch.setattr(subprocess, "run", lambda *a, **kw: fake)
    out = fetch_pr_files.call(pr_number=42)
    assert "src/index.js" in out
    assert "README.md" in out
    assert "tests/test_x.py" in out


def test_fetch_pr_files_returns_error_on_nonzero_exit(monkeypatch):
    fake = subprocess.CompletedProcess(
        args=[], returncode=1, stdout="", stderr="no such PR"
    )
    monkeypatch.setattr(subprocess, "run", lambda *a, **kw: fake)
    out = fetch_pr_files.call(pr_number=999)
    assert out.startswith("Error:")
    assert "no such PR" in out


def test_fetch_pr_files_handles_missing_gh_cli(monkeypatch):
    def raise_fnf(*a, **kw):
        raise FileNotFoundError

    monkeypatch.setattr(subprocess, "run", raise_fnf)
    out = fetch_pr_files.call(pr_number=1)
    assert out.startswith("Error:")
    assert "gh" in out


def test_fetch_pr_files_handles_timeout(monkeypatch):
    def raise_to(*a, **kw):
        raise subprocess.TimeoutExpired(cmd="gh", timeout=15)

    monkeypatch.setattr(subprocess, "run", raise_to)
    out = fetch_pr_files.call(pr_number=1)
    assert out.startswith("Error:")
    assert "timed out" in out


def test_fetch_pr_files_passes_correct_args(monkeypatch):
    """Verify the subprocess gets the exact command we expect — drift in
    the gh invocation would silently break the agent."""
    captured = {}

    def capture(args, **kw):
        captured["args"] = args
        return subprocess.CompletedProcess(
            args=args, returncode=0, stdout="", stderr=""
        )

    monkeypatch.setattr(subprocess, "run", capture)
    fetch_pr_files.call(pr_number=99)
    assert captured["args"][:3] == ["gh", "pr", "view"]
    assert "99" in captured["args"]
    assert "--json" in captured["args"]
    assert "files" in captured["args"]
    assert "--jq" in captured["args"]


# ── fetch_pr_diff ─────────────────────────────────────────────────────────


def test_fetch_pr_diff_returns_stdout_on_success(monkeypatch):
    fake = subprocess.CompletedProcess(
        args=[],
        returncode=0,
        stdout="diff --git a/x b/x\n+hello\n",
        stderr="",
    )
    monkeypatch.setattr(subprocess, "run", lambda *a, **kw: fake)
    out = fetch_pr_diff.call(pr_number=42)
    assert "diff --git" in out
    assert "+hello" in out


def test_fetch_pr_diff_returns_error_on_nonzero_exit(monkeypatch):
    fake = subprocess.CompletedProcess(
        args=[], returncode=1, stdout="", stderr="not found"
    )
    monkeypatch.setattr(subprocess, "run", lambda *a, **kw: fake)
    out = fetch_pr_diff.call(pr_number=999)
    assert out.startswith("Error:")
    assert "not found" in out


def test_fetch_pr_diff_handles_missing_gh_cli(monkeypatch):
    def raise_fnf(*a, **kw):
        raise FileNotFoundError

    monkeypatch.setattr(subprocess, "run", raise_fnf)
    out = fetch_pr_diff.call(pr_number=1)
    assert out.startswith("Error:")
    assert "gh" in out


def test_fetch_pr_diff_handles_timeout(monkeypatch):
    def raise_to(*a, **kw):
        raise subprocess.TimeoutExpired(cmd="gh", timeout=30)

    monkeypatch.setattr(subprocess, "run", raise_to)
    out = fetch_pr_diff.call(pr_number=1)
    assert out.startswith("Error:")
    assert "timed out" in out


def test_fetch_pr_diff_passes_correct_args(monkeypatch):
    captured = {}

    def capture(args, **kw):
        captured["args"] = args
        return subprocess.CompletedProcess(
            args=args, returncode=0, stdout="", stderr=""
        )

    monkeypatch.setattr(subprocess, "run", capture)
    fetch_pr_diff.call(pr_number=123)
    assert captured["args"] == ["gh", "pr", "diff", "123"]
