"""Tests for the declarative PR risk WorkflowGraph — Phase 3.2.

Covers:
- File-classification rules (critical / doc / mixed / unknown).
- The `llm_text_call` helper.
- The summarize tool factory (with a fake Anthropic client).
- Graph topology + validation.
- End-to-end Executor run with mocked subprocess + fake LLM.
"""

import subprocess
from typing import Any

import pytest

from kalairos import Executor, Ledger
from kalairos.agents.pr_risk import (
    SUMMARIZE_SYSTEM,
    _make_summarize_tool,
    build_pr_risk_graph,
    build_pr_risk_graph_agent,
    classify_file_list,
    is_critical_file,
    is_doc_only_file,
)
from kalairos.llm import llm_text_call


# ── Fake Anthropic client ──────────────────────────────────────────────────


class _Block:
    def __init__(self, type: str, **kw):
        self.type = type
        for k, v in kw.items():
            setattr(self, k, v)


class _Response:
    def __init__(self, content):
        self.content = content


class _FakeMessages:
    def __init__(self, reply_text: str = "VERDICT: LOW\n- looks fine"):
        self.reply_text = reply_text
        self.calls: list[dict] = []

    def create(self, **kw):
        self.calls.append(kw)
        return _Response([_Block(type="text", text=self.reply_text)])


class FakeAnthropicClient:
    def __init__(self, reply_text: str = "VERDICT: LOW\n- looks fine"):
        self.messages = _FakeMessages(reply_text)


# ── Classification rules ──────────────────────────────────────────────────


@pytest.mark.parametrize(
    "path",
    [
        "src/server.py",
        "lib/index.ts",
        "package.json",
        "pyproject.toml",
        "Dockerfile",
        ".github/workflows/ci.yml",
        "db/migrations/001_init.sql",
        "scripts/deploy.sh",
        "config.yaml",
    ],
)
def test_is_critical_file_matches(path):
    assert is_critical_file(path) is True


@pytest.mark.parametrize(
    "path",
    [
        "README.md",
        "docs/intro.md",
        "CHANGELOG.md",
        "LICENSE",
        "notes.rst",
    ],
)
def test_is_doc_only_file_matches(path):
    assert is_doc_only_file(path) is True


def test_classify_file_list_critical_wins():
    """One critical file → 'critical', even alongside docs."""
    files = "README.md\nsrc/server.py\nCHANGELOG.md\n"
    assert classify_file_list(files) == "critical"


def test_classify_file_list_all_docs():
    files = "README.md\nCHANGELOG.md\ndocs/intro.md\n"
    assert classify_file_list(files) == "doc"


def test_classify_file_list_empty():
    """Empty file list → 'doc' so the graph short-circuits the
    deep-scan path rather than running it on nothing."""
    assert classify_file_list("") == "doc"
    assert classify_file_list("\n\n  \n") == "doc"


def test_classify_file_list_unknown_extension_defaults_critical():
    """Unknown patterns surface for review — safer default than skipping."""
    assert classify_file_list("mystery.xyz\n") == "critical"


# ── llm_text_call helper ──────────────────────────────────────────────────


def test_llm_text_call_returns_assistant_text():
    client = FakeAnthropicClient(reply_text="hello world")
    out = llm_text_call(
        client,
        model="m",
        system="be terse",
        user_message="ping",
    )
    assert out == "hello world"


def test_llm_text_call_caches_system_prompt():
    """The system block must carry cache_control so repeated tool
    invocations from the same factory hit the prompt cache."""
    client = FakeAnthropicClient()
    llm_text_call(client, model="m", system="cached!", user_message="x")
    call = client.messages.calls[0]
    sys_block = call["system"][0]
    assert sys_block["cache_control"] == {"type": "ephemeral"}
    assert sys_block["text"] == "cached!"


def test_llm_text_call_passes_user_message_as_only_message():
    client = FakeAnthropicClient()
    llm_text_call(client, model="m", system="s", user_message="the question")
    call = client.messages.calls[0]
    assert call["messages"] == [{"role": "user", "content": "the question"}]


# ── summarize tool factory ────────────────────────────────────────────────


def test_make_summarize_tool_returns_a_tool():
    client = FakeAnthropicClient()
    t = _make_summarize_tool(client, model="m")
    assert t.name == "summarize_pr_risk"
    assert "files" in t.parameters["properties"]
    assert "diff" in t.parameters["properties"]


def test_summarize_tool_calls_llm_with_files_and_diff():
    client = FakeAnthropicClient(reply_text="VERDICT: HIGH\n- bad")
    t = _make_summarize_tool(client, model="m")
    out = t.call(files="src/x.py\n", diff="--- a/x\n+++ b/x\n+rm -rf /\n")
    assert "VERDICT: HIGH" in out
    # Sanity: the user message contained both inputs
    user_content = client.messages.calls[0]["messages"][0]["content"]
    assert "src/x.py" in user_content
    assert "rm -rf" in user_content


def test_summarize_tool_doc_only_message_when_diff_empty():
    """Empty diff (doc-only path) should send a 'No diff' marker so the
    model knows it's not a critical PR — avoids the model trying to
    invent risks from nothing."""
    client = FakeAnthropicClient()
    t = _make_summarize_tool(client, model="m")
    t.call(files="README.md\n", diff="")
    user_content = client.messages.calls[0]["messages"][0]["content"]
    assert "doc-only" in user_content.lower() or "no diff" in user_content.lower()


# ── Graph topology + agent wiring ─────────────────────────────────────────


def test_graph_has_expected_nodes_and_topology():
    g = build_pr_risk_graph()
    expected = {
        "fetch_files",
        "classify",
        "fetch_diff",
        "summarize",
        "skip_doc",
        "summarize_doc",
    }
    assert set(g.names()) == expected
    g.validate()  # no raise — topology is sound


def test_graph_starts_at_fetch_files():
    g = build_pr_risk_graph()
    assert g.start_node().name == "fetch_files"


def test_build_pr_risk_graph_agent_with_explicit_client():
    """Injecting a client (test path) should work without needing the
    real `anthropic` package or an API key."""
    client = FakeAnthropicClient()
    agent = build_pr_risk_graph_agent(client=client, model="m")
    assert agent.name == "pr-risk-analyzer-graph"
    for name in ("fetch_pr_files", "fetch_pr_diff", "summarize_pr_risk"):
        assert name in agent.tools


def test_summarize_system_prompt_mentions_load_bearing_terms():
    """Same guard as PR_RISK_INSTRUCTIONS — the summarize system prompt
    is what shapes the per-tool output. Lock its key vocabulary."""
    text = SUMMARIZE_SYSTEM.lower()
    assert "verdict" in text
    assert "low" in text and "medium" in text and "high" in text
    assert "look at" in text


# ── End-to-end: Executor over the graph ───────────────────────────────────


@pytest.fixture
def ledger(tmp_path):
    led = Ledger(tmp_path / "ledger.jsonl", tmp_path / "index.sqlite")
    led.open()
    try:
        yield led
    finally:
        led.close()


def test_e2e_critical_pr_walks_full_path(ledger, monkeypatch):
    """Critical-classified PR: fetch_files → classify → fetch_diff →
    summarize. Verdict ends up in state."""
    # Mock subprocess: fetch_pr_files returns mixed files; fetch_pr_diff
    # returns a diff.
    def fake_run(args, **kw):
        if "view" in args:
            return subprocess.CompletedProcess(
                args=args,
                returncode=0,
                stdout="src/server.py\nREADME.md\n",
                stderr="",
            )
        if "diff" in args:
            return subprocess.CompletedProcess(
                args=args,
                returncode=0,
                stdout="diff --git a/src/server.py b/src/server.py\n+os.system(cmd)\n",
                stderr="",
            )
        return subprocess.CompletedProcess(
            args=args, returncode=1, stdout="", stderr=""
        )

    monkeypatch.setattr(subprocess, "run", fake_run)

    client = FakeAnthropicClient(reply_text="VERDICT: HIGH\n- os.system on user cmd")
    agent = build_pr_risk_graph_agent(client=client, model="m")
    graph = build_pr_risk_graph()

    run, state = Executor(graph).run(
        agent, ledger, initial_state={"pr_number": 99}
    )

    assert run.status == "completed"
    assert "VERDICT: HIGH" in state["verdict"]
    # The graph took the critical path — fetch_diff ran
    assert "os.system" in state["diff"]


def test_e2e_doc_only_pr_skips_diff(ledger, monkeypatch):
    """Doc-only PR: fetch_files → classify → skip_doc → summarize_doc.
    `fetch_pr_diff` is NOT invoked — verifies the branch routes correctly."""
    diff_call_count = {"n": 0}

    def fake_run(args, **kw):
        if "view" in args:
            return subprocess.CompletedProcess(
                args=args,
                returncode=0,
                stdout="README.md\nCHANGELOG.md\n",
                stderr="",
            )
        if "diff" in args:
            diff_call_count["n"] += 1
            return subprocess.CompletedProcess(
                args=args,
                returncode=0,
                stdout="(should not be called)",
                stderr="",
            )
        return subprocess.CompletedProcess(
            args=args, returncode=1, stdout="", stderr=""
        )

    monkeypatch.setattr(subprocess, "run", fake_run)

    client = FakeAnthropicClient(reply_text="VERDICT: LOW\n- doc only")
    agent = build_pr_risk_graph_agent(client=client, model="m")
    graph = build_pr_risk_graph()

    run, state = Executor(graph).run(
        agent, ledger, initial_state={"pr_number": 7}
    )

    assert run.status == "completed"
    assert "VERDICT: LOW" in state["verdict"]
    assert diff_call_count["n"] == 0, "fetch_pr_diff must not run on doc path"


def test_e2e_emits_branch_chosen_event(ledger, monkeypatch):
    """The branch_chosen event records which path the graph took — that's
    the inspection knob the control plane will visualize in Phase 4."""

    def fake_run(args, **kw):
        if "view" in args:
            return subprocess.CompletedProcess(
                args=args, returncode=0, stdout="README.md\n", stderr=""
            )
        return subprocess.CompletedProcess(
            args=args, returncode=0, stdout="", stderr=""
        )

    monkeypatch.setattr(subprocess, "run", fake_run)
    client = FakeAnthropicClient()
    agent = build_pr_risk_graph_agent(client=client, model="m")
    graph = build_pr_risk_graph()

    run, _ = Executor(graph).run(
        agent, ledger, initial_state={"pr_number": 1}
    )

    rows = ledger.appender.load_raw()
    branch_events = [
        r
        for r in rows
        if (r.get("metadata") or {}).get("event_type") == "branch_chosen"
    ]
    assert len(branch_events) == 1
    payload = branch_events[0]["metadata"]["payload"]
    assert payload["node"] == "classify"
    assert payload["key"] == "doc"
    assert payload["target"] == "skip_doc"
